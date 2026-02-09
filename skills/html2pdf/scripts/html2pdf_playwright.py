#!/usr/bin/env python3
"""
html2pdf_playwright.py — 使用 Playwright (Chromium) 将 HTML 转换为 PDF

特点:
- 完美支持 CSS @page 规则、overflow:hidden、page-break 分页控制
- 仅在缺少 Playwright/Chromium 时自动安装，已安装则跳过
- 移除 --with-deps 避免 apt 锁冲突

用法:
    python html2pdf_playwright.py input.html output.pdf
"""

import sys
import subprocess
from pathlib import Path

LOCK_FILE = Path.home() / ".playwright_installed"

def _install_playwright_package() -> bool:
    """安装 playwright pip 包。"""
    try:
        print("[html2pdf] 正在安装 Playwright pip 包...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "playwright", "-q"],
            check=True,
            timeout=120,
        )
        print("[html2pdf] Playwright pip 包安装成功。")
        return True
    except subprocess.TimeoutExpired as e:
        print(f"[html2pdf] 错误: 安装 Playwright pip 包超时。 {e}", file=sys.stderr)
        return False
    except subprocess.CalledProcessError as e:
        print(
            f"[html2pdf] 错误: 安装 Playwright pip 包失败 (exit code {e.returncode})。\n{e.stderr}",
            file=sys.stderr,
        )
        return False


def _install_chromium() -> bool:
    """安装 Chromium 浏览器 (不含系统依赖)。"""
    try:
        print("[html2pdf] 正在安装 Chromium 浏览器...")
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True,
            timeout=300,
            capture_output=True,  # 静默安装，因为不再需要 apt 输出
            text=True,
        )
        print("[html2pdf] Chromium 浏览器安装成功。")
        return True
    except subprocess.TimeoutExpired as e:
        print(f"[html2pdf] 错误: 安装 Chromium 超时。 {e}", file=sys.stderr)
        return False
    except subprocess.CalledProcessError as e:
        print(
            f"[html2pdf] 错误: 安装 Chromium 失败 (exit code {e.returncode})。\n{e.stderr}",
            file=sys.stderr,
        )
        return False


def ensure_playwright() -> bool:
    """
    只有在确实缺少 Playwright 时才安装。

    说明:
    - 之前用 LOCK_FILE 作为“首次运行”判断，但它可能和当前 Python 环境不一致。
    - 现在以 import 结果为准，只在需要时触发安装。
    """
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
        return True
    except ModuleNotFoundError:
        print("[html2pdf] 检测到 Playwright 未安装，正在准备环境...")

    # 若之前成功装过，则锁文件作为优化，避免重复安装浏览器
    # 但对于 pip 包缺失，锁文件不能作为跳过条件。
    if not _install_playwright_package():
        return False
    if not _install_chromium():
        return False

    try:
        LOCK_FILE.touch()
    except Exception as e:
        print(f"[html2pdf] 警告: 无法写入锁文件 {LOCK_FILE}: {e}", file=sys.stderr)

    print("[html2pdf] 环境准备完成。")
    return True


def _looks_like_missing_chromium(err: Exception) -> bool:
    msg = str(err).lower()
    # Playwright 常见提示: "Executable doesn't exist" / "Please run: playwright install"
    if "executable doesn't exist" in msg:
        return True
    if "playwright install" in msg and "chromium" in msg:
        return True
    return False

def html_to_pdf(html_path: str, pdf_path: str):
    """使用 Playwright (Chromium) 将 HTML 转换为 PDF"""
    if not ensure_playwright():
        print("[html2pdf] Playwright 环境设置失败，无法继续。", file=sys.stderr)
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
        try:
            browser = p.chromium.launch()
        except Exception as e:
            # Playwright 包存在但浏览器未安装时，才触发安装并重试一次。
            if _looks_like_missing_chromium(e):
                if LOCK_FILE.exists():
                    # 锁文件可能不准确，但可以提示用户发生了偏差
                    print("[html2pdf] 提示: 检测到锁文件存在但 Chromium 仍缺失，正在修复安装...")
                if not _install_chromium():
                    print("[html2pdf] Chromium 安装失败，无法继续。", file=sys.stderr)
                    sys.exit(1)
                try:
                    LOCK_FILE.touch()
                except Exception:
                    pass
                browser = p.chromium.launch()
            else:
                raise
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
