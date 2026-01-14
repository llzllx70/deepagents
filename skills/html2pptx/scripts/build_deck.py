#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert slide HTML files to PPTX and merge into a single deck."
    )
    parser.add_argument(
        "--slides-dir",
        default="workspace/html2pptx/slides",
        help="Directory containing slide-###.html files.",
    )
    parser.add_argument(
        "--pptx-dir",
        default="workspace/html2pptx/slides_pptx",
        help="Directory to store per-slide PPTX files.",
    )
    parser.add_argument(
        "--out",
        default="workspace/html2pptx/final.pptx",
        help="Output PPTX path.",
    )
    parser.add_argument(
        "--html2pptx",
        default="skills/html2pptx/scripts/html2pptx.js",
        help="Path to html2pptx.js script.",
    )
    parser.add_argument(
        "--merge-script",
        default="skills/html2pptx/scripts/merge_pptx.py",
        help="Path to merge_pptx.py script.",
    )
    parser.add_argument(
        "--max-slide-height-in",
        type=float,
        default=7.5,
        help="Max slide height in inches for html2pptx.",
    )
    parser.add_argument(
        "--scale",
        type=float,
        default=None,
        help="Scale factor for html2pptx.",
    )
    parser.add_argument(
        "--split",
        action="store_true",
        help="Allow html2pptx to split long slides (default: no split).",
    )
    parser.add_argument(
        "--allow-size-mismatch",
        action="store_true",
        help="Allow merging slides with different sizes.",
    )
    return parser.parse_args()


def _slide_sort_key(path: Path) -> tuple[int, str]:
    match = re.search(r"(\d+)", path.stem)
    if match:
        return (int(match.group(1)), path.name)
    return (sys.maxsize, path.name)


def _run(cmd: list[str]) -> None:
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)


def build_deck(args: argparse.Namespace) -> None:
    slides_dir = Path(args.slides_dir)
    pptx_dir = Path(args.pptx_dir)
    html2pptx_script = Path(args.html2pptx)
    merge_script = Path(args.merge_script)
    out_path = Path(args.out)

    if not slides_dir.exists():
        raise FileNotFoundError(f"Slides directory not found: {slides_dir}")

    html_files = sorted(slides_dir.glob("*.html"), key=_slide_sort_key)
    if not html_files:
        raise FileNotFoundError(f"No HTML slides found in {slides_dir}")

    pptx_dir.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    pptx_files = []
    for html_path in html_files:
        pptx_path = pptx_dir / f"{html_path.stem}.pptx"
        cmd = [
            "node",
            str(html2pptx_script),
            "--in",
            str(html_path),
            "--out",
            str(pptx_path),
            "--max-slide-height-in",
            str(args.max_slide_height_in),
        ]
        if args.scale is not None:
            cmd.extend(["--scale", str(args.scale)])
        cmd.append("--split" if args.split else "--no-split")
        _run(cmd)
        pptx_files.append(pptx_path)

    merge_cmd = [
        sys.executable,
        str(merge_script),
        "--out",
        str(out_path),
    ]
    if args.allow_size_mismatch:
        merge_cmd.append("--allow-size-mismatch")
    merge_cmd.extend([str(pptx) for pptx in pptx_files])
    _run(merge_cmd)


def main() -> None:
    args = _parse_args()
    try:
        build_deck(args)
    except subprocess.CalledProcessError as exc:
        print(f"Command failed: {exc}", file=sys.stderr)
        sys.exit(exc.returncode or 1)
    except Exception as exc:
        print(f"build_deck failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
