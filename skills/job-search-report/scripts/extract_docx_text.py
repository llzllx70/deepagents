#!/usr/bin/env python3
"""Extract plain text from a .docx file without external dependencies."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def extract_docx_text(docx_path: Path) -> str:
    with zipfile.ZipFile(docx_path) as docx:
        xml_bytes = docx.read("word/document.xml")

    root = ET.fromstring(xml_bytes)
    ns = {"w": WORD_NAMESPACE}
    paragraphs: list[str] = []

    for para in root.findall(".//w:p", ns):
        parts: list[str] = []
        for run in para.findall(".//w:r", ns):
            for child in run:
                tag = child.tag.split("}")[-1]
                if tag == "t" and child.text:
                    parts.append(child.text)
                elif tag == "tab":
                    parts.append("\t")
                elif tag == "br":
                    parts.append("\n")
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)

    return "\n".join(paragraphs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract plain text from a .docx file")
    parser.add_argument("--input", required=True, help="Path to .docx file")
    parser.add_argument("--output", required=True, help="Output text file path")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    text = extract_docx_text(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
