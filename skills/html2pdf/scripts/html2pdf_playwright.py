#!/usr/bin/env python3
"""
html2pdf_playwright.py — 使用 Playwright (Chromium) 将 HTML 转换为 PDF

特点:
- 完美支持 CSS @page 规则、overflow:hidden、page-break 分页控制
- 首次运行自动安装 Playwright 和 Chromium，后续运行跳过安装
- 移除 --with-deps 避免 apt 锁冲突

用法:
    python html2pdf_playwright.py input.html output.pdf
"""

import sys
import os
import subprocess
from pathlib import Path

LOCK_FILE = Path.home() / ".playwright_installed"

def setup_playwright():
    """检查并安装 Playwright 和 Chromium。使用锁文件跳过重复安装。"""
    if LOCK_FILE.exists():
        return True

    print("[html2pdf] 首次运行，正在准备 Playwright 环境...")

    try:
        # 步骤 1: 安装 playwright pip 包
        print("[html2pdf] 正在安装 Playwright pip 包...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "playwright", "-q"],
            check=True,
            timeout=120
        )
        print("[html2pdf] Playwright pip 包安装成功。")

        # 步骤 2: 安装 Chromium 浏览器 (不含系统依赖)
        print("[html2pdf] 正在安装 Chromium 浏览器...")
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True,
            timeout=300,
            capture_output=True, # 静默安装，因为不再需要 apt 输出
            text=True
        )
        print("[html2pdf] Chromium 浏览器安装成功。")

        # 步骤 3: 创建锁文件
        LOCK_FILE.touch()
        print("[html2pdf] 环境准备完成。")
        return True

    except subprocess.TimeoutExpired as e:
        print(f"[html2pdf] 错误: 安装超时。 {e}", file=sys.stderr)
        return False
    except subprocess.CalledProcessError as e:
        print(f"[html2pdf] 错误: 安装失败 (exit code {e.returncode})。\n{e.stderr}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[html2pdf] 错误: {e}", file=sys.stderr)
        return False

def html_to_pdf(html_path: str, pdf_path: str):
    """使用 Playwright (Chromium) 将 HTML 转换为 PDF"""
    if not setup_playwright():
        print("[html2pdf] 环境设置失败，无法继续。", file=sys.stderr)
        sys.exit(1)

    from playwright.sync_api import sync_playwright

    html_file = Path(html_path).resolve()
    pdf_file = Path(pdf_path).resolve()

    if not html_file.exists():
        print(f"[html2pdf] 错误: HTML 文件不存在: {html_file}", file=sys.stderr)
        sys.exit(1)

    pdf_file.parent.mkdir(parents=True, exist_ok=True)

    print(f"[html2pdf] 正在转换: {html_file.name} -> {pdf_file.name}")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        page.goto(f"file://{html_file}", wait_until="networkidle", timeout=60000)

        page.pdf(
            path=str(pdf_file),
            prefer_css_page_size=True,
            print_background=True,
            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"}
        )

        browser.close()
    print(f"[html2pdf] PDF 已成功生成: {pdf_file}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法: python html2pdf_playwright.py input.html output.pdf")
        sys.exit(1)

    html_to_pdf(sys.argv[1], sys.argv[2])
