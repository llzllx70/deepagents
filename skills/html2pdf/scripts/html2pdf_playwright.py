#!/usr/bin/env python3
"""
html2pdf_playwright.py — 使用 Playwright (Chromium) 将 HTML 转换为 PDF

特点:
- 完美支持 CSS @page 规则、overflow:hidden、page-break 分页控制
- 自动从 HTML 中解析 @page 尺寸，作为 Playwright API 层面的回退保障
- 仅在缺少 Playwright/Chromium 时自动安装，已安装则跳过
- 移除 --with-deps 避免 apt 锁冲突

用法:
    python html2pdf_playwright.py input.html output.pdf
"""

import re
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
    - 之前用 LOCK_FILE 作为"首次运行"判断，但它可能和当前 Python 环境不一致。
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


def _css_length_to_inches(value: str) -> float | None:
    """将 CSS 长度值转换为英寸。支持 cm, mm, in, px, pt。"""
    value = value.strip().lower()
    conversions = {
        "cm": 1 / 2.54,
        "mm": 1 / 25.4,
        "in": 1.0,
        "px": 1 / 96.0,
        "pt": 1 / 72.0,
    }
    for unit, factor in conversions.items():
        if value.endswith(unit):
            try:
                return float(value[: -len(unit)].strip()) * factor
            except ValueError:
                return None
    return None


def _detect_page_size(html_content: str) -> dict | None:
    """
    从 HTML 的 <style> 中解析 @page { size: W H; } 规则，
    返回 Playwright page.pdf() 可用的 width/height 字符串（英寸单位）。

    解析策略：
    1. 提取所有 <style> 标签内容
    2. 移除 CSS 注释
    3. 在顶层和 @media print 内部同时查找 @page 规则
    4. 解析 size 属性中的宽高值
    """
    # 提取所有 <style> 内容
    style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", html_content, re.DOTALL | re.IGNORECASE)
    if not style_blocks:
        return None

    css_text = "\n".join(style_blocks)

    # 移除 CSS 注释
    css_text = re.sub(r"/\*.*?\*/", "", css_text, flags=re.DOTALL)

    # 匹配 @page { ... size: W H; ... }
    # 同时匹配顶层和 @media print 内部的 @page
    page_matches = re.findall(r"@page\s*\{([^}]*)\}", css_text)
    if not page_matches:
        return None

    # 取最后一个 @page 规则（CSS 层叠：后声明的优先）
    for page_block in reversed(page_matches):
        size_match = re.search(r"size\s*:\s*([^;]+)", page_block)
        if not size_match:
            continue

        size_value = size_match.group(1).strip()

        # 处理关键字 landscape / portrait
        if "landscape" in size_value.lower():
            # 如果只有 landscape 关键字（如 "A4 landscape"），不做精确解析
            # 但至少知道是横版
            return None  # 让 prefer_css_page_size 处理

        # 解析两个长度值: "25.4cm 14.29cm"
        parts = size_value.split()
        if len(parts) >= 2:
            w = _css_length_to_inches(parts[0])
            h = _css_length_to_inches(parts[1])
            if w is not None and h is not None:
                return {"width": f"{w:.4f}in", "height": f"{h:.4f}in"}

        # 单个长度值（正方形）
        if len(parts) == 1:
            side = _css_length_to_inches(parts[0])
            if side is not None:
                return {"width": f"{side:.4f}in", "height": f"{side:.4f}in"}

    return None


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

    # 预读 HTML，解析 @page 尺寸作为回退保障
    html_content = html_file.read_text(encoding="utf-8", errors="ignore")
    detected_size = _detect_page_size(html_content)

    if detected_size:
        print(f"[html2pdf] 检测到 @page 尺寸: {detected_size['width']} x {detected_size['height']}")
    else:
        print("[html2pdf] 未检测到 @page 尺寸，将依赖 CSS prefer_css_page_size 或使用默认尺寸。")

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

        # 构建 pdf() 参数
        # 双重保障策略:
        #   1. prefer_css_page_size=True 让 Chromium 优先使用 CSS @page 规则
        #   2. 同时通过 width/height 参数传入解析到的尺寸作为回退
        #      当 Chromium 无法识别 CSS @page 时（如旧版本或嵌套声明），
        #      Playwright API 的 width/height 参数仍能确保正确的页面尺寸
        pdf_options = {
            "path": str(pdf_file),
            "prefer_css_page_size": True,
            "print_background": True,
            "margin": {"top": "0", "right": "0", "bottom": "0", "left": "0"},
        }

        # 如果从 HTML 中检测到了 @page 尺寸，同时设置 width/height 作为双重保障
        if detected_size:
            pdf_options["width"] = detected_size["width"]
            pdf_options["height"] = detected_size["height"]

        page.pdf(**pdf_options)

        browser.close()
    print(f"[html2pdf] PDF 已成功生成: {pdf_file}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法: python html2pdf_playwright.py input.html output.pdf")
        sys.exit(1)

    html_to_pdf(sys.argv[1], sys.argv[2])
