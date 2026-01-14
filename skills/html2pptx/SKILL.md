---
name: html2pptx
description: 基于 HTML 逐页生成并合并 PPTX 的工作流技能，涵盖深色科技风全局规范、plan.md 大纲、按页 HTML 生成、html2pptx 转换与多页合并；当需要用 HTML 生成多页 PPTX（含封面/目录/过渡/致谢）时使用
---

# HTML → PPTX（按页生成与合并）

## 输出位置（必须）
所有操作结果都保存到 `workspace/html2pptx/`。

建议结构：
- `workspace/html2pptx/plan.md`
- `workspace/html2pptx/slides/slide-001.html`
- `workspace/html2pptx/slides_pptx/slide-001.pptx`
- `workspace/html2pptx/final.pptx`

## 步骤 1：确定设计原则与全局规范（深色科技风）
按输入确认受众/语气，并固定以下风格与一致性规则：
- 主题：深色科技风
- 必含页面：封面、目录、过渡页、内容页、致谢页
- 页面大小：16:9，对应 HTML 固定为 1280x720
- 字体：`Microsoft YaHei`（优先）/ `PingFang SC` 作为备选
- 边距：左右 88px、上 64px、下 64px（可小幅调整但全局一致）
- 色彩基调（RRGGBB）：背景 `070B14`、卡片 `0D1526`、正文 `E6F0FF`、弱化 `9FB2D9`、主强调 `00D4FF`、次强调 `5B8CFF`

## 步骤 2：制定计划并生成大纲（plan.md）
根据输入内容生成 `workspace/html2pptx/plan.md`，先规划再落页。

模板示例：
```md
# 标题：xxx

## 受众与目标
- 受众：
- 目标：

## 设计风格与规范
- 主题：深色科技风
- 页面：1280x720（16:9）
- 字体：Microsoft YaHei / PingFang SC
- 边距：左右 88px，上下 64px
- 色彩：070B14 / 0D1526 / E6F0FF / 9FB2D9 / 00D4FF / 5B8CFF

## 目录（章节）
1. ...
2. ...

## 分页计划
| 页码 | 类型 | 标题 | 核心信息点 | 视觉/素材 |
| --- | --- | --- | --- | --- |
| 1 | 封面 | ... | 主题与副标题 | 主视觉 |
| 2 | 目录 | ... | 章节列表 | 无 |
| 3 | 过渡 | ... | 章节引入 | 无 |
| 4 | 内容 | ... | 1 个中心信息点 | 图表/表格 |
| N | 致谢 | ... | 结尾与联系信息 | Logo/二维码 |
```

## 步骤 3：确定分页设计方案与内容
按“每页 1 个中心信息点”拆页，保证每页信息密度可读、版式一致。

## 步骤 4：不同页面定位与不同 Prompt
每类页面使用不同 prompt（只输出 HTML，不要额外文字）：

- 封面页 prompt：生成深色科技风封面 HTML，含主标题/副标题/元信息，视觉简洁且强调主题。
- 目录页 prompt：生成目录页 HTML，仅输出 4–6 个章节标题列表，层级清晰。
- 过渡页 prompt：生成章节过渡页 HTML，只输出章节标题 + 1 句引导语。
- 内容页 prompt：生成内容页 HTML，围绕 1 个中心信息点，给 3–6 条要点；必要时添加图表/表格占位。
- 致谢页 prompt：生成致谢页 HTML，只输出致谢标题 + 联系方式。

## 步骤 5：生成 slide.html（编号递增）
按 `slide-001.html`, `slide-002.html` ... 写入 `workspace/html2pptx/slides/`。

HTML 基础模板（每页复用，保持全局一致）：
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      :root {
        --bg: #070B14;
        --card: #0D1526;
        --text: #E6F0FF;
        --muted: #9FB2D9;
        --accent: #00D4FF;
        --accent-2: #5B8CFF;
        --pad-x: 88px;
        --pad-y: 64px;
      }
      html, body {
        width: 1280px;
        height: 720px;
        margin: 0;
        padding: 0;
      }
      body {
        background: radial-gradient(1200px 600px at 20% 10%, rgba(0, 212, 255, 0.15), transparent 60%),
                    radial-gradient(900px 500px at 80% 20%, rgba(91, 140, 255, 0.12), transparent 55%),
                    var(--bg);
        color: var(--text);
        font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
      }
      .slide {
        box-sizing: border-box;
        width: 1280px;
        height: 720px;
        padding: var(--pad-y) var(--pad-x);
        position: relative;
      }
      .card {
        background: var(--card);
        border-radius: 16px;
        padding: 24px;
      }
      .muted { color: var(--muted); }
      .accent { color: var(--accent); }
    </style>
  </head>
  <body>
    <div class="slide">
      <!-- page content -->
    </div>
  </body>
</html>
```

HTML 约束（避免转换警告）：
- 用 `<div>` 承载背景色/边框/阴影，不要给 `<p>/<h*>` 直接加背景。
- 列表使用 `<ul>/<ol><li>`，不要手写 `•` 开头。
- 不要给 `<div>` 设置背景图片，图片请用 `<img>`。

## 步骤 6：逐页转换 PPTX
每页 HTML 转换为对应 PPTX（保持单页）：
```bash
node skills/html2pptx/scripts/html2pptx.js \
  --in workspace/html2pptx/slides/slide-001.html \
  --out workspace/html2pptx/slides_pptx/slide-001.pptx \
  --no-split \
  --max-slide-height-in 7.5
```

## 步骤 7：合并所有页面
```bash
python skills/html2pptx/scripts/merge_pptx.py \
  --out workspace/html2pptx/final.pptx \
  workspace/html2pptx/slides_pptx/slide-*.pptx
```

## 一键构建（可选）
使用脚本自动完成“逐页转换 + 合并”：
```bash
python skills/html2pptx/scripts/build_deck.py \
  --slides-dir workspace/html2pptx/slides \
  --out workspace/html2pptx/final.pptx
```
