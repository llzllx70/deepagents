
# skills/admission-advice/scripts/html2pdf.py

import os
import sys
from pathlib import Path

# ============================================================
# 【关键修复】macOS + deepagents / subprocess 下
# WeasyPrint 无法加载 libgobject / pango 的问题
#
# 必须放在 import weasyprint 之前
# ============================================================
os.environ.setdefault(
    "DYLD_LIBRARY_PATH",
    "/opt/homebrew/lib"
)

from weasyprint import HTML, CSS


def html_to_pdf(html_path: str, pdf_path: str):
    html_path = Path(html_path)
    pdf_path = Path(pdf_path)

    if not html_path.exists():
        raise FileNotFoundError(f"HTML 文件不存在: {html_path}")

    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    # === 中文字体 CSS（关键）===
    font_css = CSS(string="""
        @font-face {
            font-family: "NotoSansSC";
            src: local("Noto Sans SC"),
                 local("Source Han Sans SC"),
                 local("PingFang SC"),
                 local("Microsoft YaHei");
        }

        body {
            font-family: "NotoSansSC", "PingFang SC",
                         "Microsoft YaHei", sans-serif;
        }
    """)

    HTML(filename=str(html_path)).write_pdf(
        target=str(pdf_path),
        stylesheets=[font_css]
    )


if __name__ == "__main__":
    """
    用法:
        python html2pdf.py input.html output.pdf
    """
    if len(sys.argv) != 3:
        print("Usage: python html2pdf.py report.html report.pdf")
        sys.exit(1)

    html_to_pdf(sys.argv[1], sys.argv[2])
