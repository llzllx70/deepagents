#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PML_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge multiple PPTX files into one.")
    parser.add_argument(
        "inputs",
        nargs="+",
        help="Input PPTX files in the desired order.",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Output PPTX path.",
    )
    parser.add_argument(
        "--allow-size-mismatch",
        action="store_true",
        help="Allow merging PPTX files with different slide sizes.",
    )
    return parser.parse_args()


def _extract_pptx(pptx_path: Path, dest_dir: Path) -> None:
    with zipfile.ZipFile(pptx_path, "r") as archive:
        archive.extractall(dest_dir)


def _zip_dir(src_dir: Path, out_path: Path) -> None:
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(src_dir.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(src_dir).as_posix())


def _slide_number(path: Path) -> int:
    match = re.search(r"slide(\d+)\.xml$", path.name)
    if not match:
        raise ValueError(f"Unexpected slide filename: {path.name}")
    return int(match.group(1))


def _get_slide_size(presentation_path: Path) -> tuple[str, str] | None:
    tree = etree.parse(str(presentation_path))
    sld_sz = tree.getroot().find(f"{{{PML_NS}}}sldSz")
    if sld_sz is None:
        return None
    return sld_sz.get("cx"), sld_sz.get("cy")


def _hash_file(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _build_hash_index(media_dir: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    if not media_dir.exists():
        return hashes
    for item in media_dir.iterdir():
        if item.is_file():
            hashes[_hash_file(item)] = item.name
    return hashes


def _unique_name(dest_dir: Path, base_name: str) -> str:
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix
    counter = 1
    while True:
        candidate = f"{stem}-m{counter}{suffix}"
        if not (dest_dir / candidate).exists():
            return candidate
        counter += 1


def _ensure_related_part(
    src_slide_dir: Path,
    src_rel_target: str,
    dest_root: Path,
    base_hashes: dict[str, str],
    merged_hashes: dict[str, str],
) -> str:
    if src_rel_target.startswith("../media/"):
        folder = "media"
    elif src_rel_target.startswith("../embeddings/"):
        folder = "embeddings"
    else:
        return src_rel_target

    src_path = (src_slide_dir / src_rel_target).resolve()
    if not src_path.exists():
        return src_rel_target

    dest_dir = dest_root / "ppt" / folder
    dest_dir.mkdir(parents=True, exist_ok=True)

    file_hash = _hash_file(src_path)
    if file_hash in merged_hashes:
        return f"../{folder}/{merged_hashes[file_hash]}"

    if file_hash in base_hashes:
        merged_hashes[file_hash] = base_hashes[file_hash]
        return f"../{folder}/{base_hashes[file_hash]}"

    preferred_name = Path(src_rel_target).name
    dest_path = dest_dir / preferred_name
    if dest_path.exists():
        if _hash_file(dest_path) == file_hash:
            merged_hashes[file_hash] = preferred_name
            return f"../{folder}/{preferred_name}"
        new_name = _unique_name(dest_dir, preferred_name)
    else:
        new_name = preferred_name

    shutil.copyfile(src_path, dest_dir / new_name)
    merged_hashes[file_hash] = new_name
    return f"../{folder}/{new_name}"


def _copy_slide(
    src_root: Path,
    dest_root: Path,
    slide_path: Path,
    new_slide_number: int,
    base_hashes: dict[str, str],
    merged_hashes: dict[str, str],
) -> None:
    src_slide_dir = src_root / "ppt" / "slides"
    dest_slide_dir = dest_root / "ppt" / "slides"
    dest_slide_dir.mkdir(parents=True, exist_ok=True)

    dest_slide_path = dest_slide_dir / f"slide{new_slide_number}.xml"
    shutil.copyfile(slide_path, dest_slide_path)

    src_rels_path = src_root / "ppt" / "slides" / "_rels" / f"{slide_path.name}.rels"
    if not src_rels_path.exists():
        return

    rels_tree = etree.parse(str(src_rels_path))
    rels_root = rels_tree.getroot()
    for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target")
        if not target:
            continue
        new_target = _ensure_related_part(
            src_slide_dir,
            target,
            dest_root,
            base_hashes,
            merged_hashes,
        )
        if new_target != target:
            rel.set("Target", new_target)

    dest_rels_dir = dest_slide_dir / "_rels"
    dest_rels_dir.mkdir(parents=True, exist_ok=True)
    dest_rels_path = dest_rels_dir / f"slide{new_slide_number}.xml.rels"
    rels_tree.write(dest_rels_path, encoding="UTF-8", xml_declaration=True)


def _update_presentation(
    presentation_path: Path,
    pres_rels_path: Path,
    content_types_path: Path,
    new_slide_number: int,
    next_slide_id: int,
    next_rel_id: int,
) -> tuple[int, int]:
    pres_tree = etree.parse(str(presentation_path))
    pres_root = pres_tree.getroot()
    nsmap = {"p": PML_NS, "r": R_NS}

    sld_id_list = pres_root.find("p:sldIdLst", namespaces=nsmap)
    if sld_id_list is None:
        sld_id_list = etree.SubElement(pres_root, etree.QName(PML_NS, "sldIdLst"))

    sld_id = etree.SubElement(sld_id_list, etree.QName(PML_NS, "sldId"))
    sld_id.set("id", str(next_slide_id))
    sld_id.set(etree.QName(R_NS, "id"), f"rId{next_rel_id}")

    pres_tree.write(presentation_path, encoding="UTF-8", xml_declaration=True)

    rels_tree = etree.parse(str(pres_rels_path))
    rels_root = rels_tree.getroot()
    rel = etree.SubElement(rels_root, etree.QName(REL_NS, "Relationship"))
    rel.set("Id", f"rId{next_rel_id}")
    rel.set("Type", SLIDE_REL_TYPE)
    rel.set("Target", f"slides/slide{new_slide_number}.xml")
    rels_tree.write(pres_rels_path, encoding="UTF-8", xml_declaration=True)

    ct_tree = etree.parse(str(content_types_path))
    ct_root = ct_tree.getroot()
    override = etree.SubElement(ct_root, etree.QName(CT_NS, "Override"))
    override.set("PartName", f"/ppt/slides/slide{new_slide_number}.xml")
    override.set(
        "ContentType",
        "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    )
    ct_tree.write(content_types_path, encoding="UTF-8", xml_declaration=True)

    return next_slide_id + 1, next_rel_id + 1


def _max_rel_id(rels_path: Path) -> int:
    rels_tree = etree.parse(str(rels_path))
    rels_root = rels_tree.getroot()
    max_id = 0
    for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
        rel_id = rel.get("Id", "")
        match = re.match(r"rId(\d+)", rel_id)
        if match:
            max_id = max(max_id, int(match.group(1)))
    return max_id


def _max_slide_id(presentation_path: Path) -> int:
    pres_tree = etree.parse(str(presentation_path))
    pres_root = pres_tree.getroot()
    nsmap = {"p": PML_NS}
    max_id = 255
    for sld_id in pres_root.findall("p:sldIdLst/p:sldId", namespaces=nsmap):
        try:
            max_id = max(max_id, int(sld_id.get("id")))
        except (TypeError, ValueError):
            continue
    return max_id


def merge_pptx(inputs: list[Path], output: Path, allow_size_mismatch: bool) -> None:
    if len(inputs) == 1:
        if inputs[0].resolve() != output.resolve():
            shutil.copyfile(inputs[0], output)
        return

    with tempfile.TemporaryDirectory() as work_dir:
        work_root = Path(work_dir)
        base_dir = work_root / "base"
        base_dir.mkdir()
        _extract_pptx(inputs[0], base_dir)

        presentation_path = base_dir / "ppt" / "presentation.xml"
        pres_rels_path = base_dir / "ppt" / "_rels" / "presentation.xml.rels"
        content_types_path = base_dir / "[Content_Types].xml"

        base_size = _get_slide_size(presentation_path)
        base_media_hashes = _build_hash_index(base_dir / "ppt" / "media")
        merged_hashes: dict[str, str] = {}

        slide_files = sorted(
            (base_dir / "ppt" / "slides").glob("slide*.xml"),
            key=_slide_number,
        )
        max_slide_number = max((_slide_number(path) for path in slide_files), default=0)
        next_slide_number = max_slide_number + 1
        next_slide_id = _max_slide_id(presentation_path) + 1
        next_rel_id = _max_rel_id(pres_rels_path) + 1

        for index, src_path in enumerate(inputs[1:], start=1):
            src_dir = work_root / f"src_{index}"
            src_dir.mkdir()
            _extract_pptx(src_path, src_dir)

            if not allow_size_mismatch:
                src_size = _get_slide_size(src_dir / "ppt" / "presentation.xml")
                if base_size and src_size and src_size != base_size:
                    raise ValueError(
                        f"Slide size mismatch between {inputs[0]} and {src_path}."
                    )

            src_slide_dir = src_dir / "ppt" / "slides"
            src_slide_files = sorted(
                src_slide_dir.glob("slide*.xml"),
                key=_slide_number,
            )
            for slide_path in src_slide_files:
                _copy_slide(
                    src_dir,
                    base_dir,
                    slide_path,
                    next_slide_number,
                    base_media_hashes,
                    merged_hashes,
                )
                next_slide_id, next_rel_id = _update_presentation(
                    presentation_path,
                    pres_rels_path,
                    content_types_path,
                    next_slide_number,
                    next_slide_id,
                    next_rel_id,
                )
                next_slide_number += 1

        _zip_dir(base_dir, output)


def main() -> None:
    args = _parse_args()
    inputs = [Path(p).expanduser() for p in args.inputs]
    output = Path(args.out).expanduser()

    for pptx in inputs:
        if not pptx.exists():
            print(f"Missing input: {pptx}", file=sys.stderr)
            sys.exit(1)

    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        merge_pptx(inputs, output, args.allow_size_mismatch)
    except Exception as exc:
        print(f"merge_pptx failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
