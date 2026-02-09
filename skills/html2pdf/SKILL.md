---
name: html2pdf
description: 将 HTML 文件转换为 PDF 的通用技能，基于 Playwright (Chromium)，完美支持 CSS @page 规则和复杂布局，内置中文字体支持。
---
# HTML 转 PDF Skill (html2pdf)

本 Skill 用于将 **HTML 文件转换为 PDF 文件**，基于 `Playwright` (Chromium 浏览器引擎) 实现，能够完美模拟浏览器打印效果，适用于：

- **PPT/幻灯片导出**: 能够正确处理 `html-ppt-designer` 生成的复杂 CSS 布局和分页控制。
- **报告类 HTML → PDF**: 确保图表、渐变背景等视觉元素正确渲染。
- **任何需要"所见即所得"的 HTML 转换场景**。

## 何时使用本技能

当你已经具备 **结构化 HTML 文件**，并需要输出 **高质量、高保真度** 的 PDF 时，使用本 Skill。

## 调用方式

```bash
python3 /skills/html2pdf/scripts/html2pdf_playwright.py input.html output.pdf
```

## 重要：首次运行前的准备

**首次运行**时，脚本会自动安装 Playwright pip 包和 Chromium 浏览器，大约需要 **3-5 秒**。为避免命令超时，建议在调用转换前先单独执行预安装：

```bash
pip3 install playwright -q && python3 -m playwright install chromium
```

预安装完成后，脚本会创建锁文件 `~/.playwright_installed`，后续运行将跳过安装步骤，转换耗时仅约 **1-2 秒**。

> **注意**: 安装命令不使用 `--with-deps` 参数，避免触发 `apt-get` 导致的锁冲突。Chromium headless shell 本身不需要额外的系统依赖即可正常运行。

## 技术实现

- **渲染引擎**: Playwright + Chromium，与用户浏览器渲染效果一致。
- **页面尺寸**: 默认优先使用 HTML 中定义的 `@page` 尺寸规则 (`prefer_css_page_size=True`)。
- **背景渲染**: 默认开启 `print_background=True`，确保渐变、背景色等正确输出。
- **自动安装**: 首次运行时自动安装依赖，不使用 `--with-deps` 避免 apt 锁冲突。
- **锁文件机制**: 安装成功后创建 `~/.playwright_installed` 锁文件，后续运行直接跳过安装。

## 与旧版 (WeasyPrint) 对比

| 特性 | Playwright (新版) | WeasyPrint (旧版) |
|:---|:---:|:---:|
| **渲染引擎** | Chromium | WeasyPrint |
| **CSS兼容性** | **高** (现代浏览器标准) | **中** (部分CSS属性不支持) |
| **分页控制** | **可靠** | **不可靠** (内容溢出时强制分页) |
| **`overflow:hidden`** | **支持** (裁剪内容) | **不支持** (忽略并分页) |
| **转换速度** | ~2秒 (已安装后) | ~3秒 |
| **适用场景** | 复杂、高保真度文档 | 简单、纯文本为主的文档 |
