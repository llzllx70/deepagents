---
name: html2pptx
description: 将 HTML 文件转换为 PPTX 的通用技能
---
# HTML转PPTX Skill

本 Skill 用于将 **HTML 文件转换为PPTX 文件**，适用于：

- 报告类 HTML → PDF
- 招生 / 学工 / 政策类正式文档导出
- AI Agent 自动生成可下载 PDF

---

## 何时使用本技能

当你已经具备以下条件时，使用本 Skill：

- 已生成结构化 **HTML 文件**
- 需要输出 **可下载 / 可打印 / 对外展示的 PDF**
- 运行环境为：
  - macOS（Apple Silicon / Intel）
  - Homebrew 安装的 cairo / pango / gobject
  - deepagents / LangGraph / subprocess 调用场景

## 调用方式

skills/html2pdf/scripts/html2pdf.py aaa.html aaa.pdf
