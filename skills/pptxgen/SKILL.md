---
name: pptxgen
description: 基于 PptxGenJS 生成精美 PPTX：当用户给出一段文本/大纲/结构化要点，希望自动排版成现代风格的 .pptx，并需要插入 charts/images/media/shapes/tables/text 时使用；本技能提供 deck-spec(JSON) 到 pptx 的生成脚本与工作流
---

# PptxGenJS 精美 PPT 生成（pptxgen）

本 Skill 目标：把“用户给定文本（需求/大纲/要点）”转成 **结构化 deck spec（JSON）**，然后用 PptxGenJS 生成 **可直接交付的精美 .pptx**（含图表/图片/形状/表格/媒体/富文本）。

## 快速使用

1) 把用户文本整理成 `deck.spec.json`（见下方 Deck Spec 结构）
2) 运行生成器：

```bash
node skills/pptxgen/scripts/spec2pptx.js deck.spec.json output.pptx
```

3) 视觉验收（可选）：优先直接用 PowerPoint/Keynote 打开检查；或使用网格缩略图脚本（需要 Python 依赖 `python-pptx`）：

```bash
python skills/pptx/scripts/thumbnail.py output.pptx workspace/thumbnails --cols 4
```

可用主题（`meta.theme` 或 CLI `--theme`）：

- `modernLight`（默认）
- `modernDark`

## Deck Spec（JSON）结构

最小结构：

```json
{
  "meta": { "title": "示例标题", "author": "AI", "layout": "LAYOUT_16x9", "theme": "modernLight" },
  "slides": [
    { "type": "title", "title": "封面标题", "subtitle": "一句副标题", "meta": "单位｜日期" },
    { "type": "content", "title": "核心要点", "bullets": ["要点 A", "要点 B", "要点 C"] }
  ]
}
```

支持的 `slide.type`：

- `title`：封面
- `section`：章节页
- `content`：左要点 + 右侧卡片（可选 `aside`）
- `chart`：左要点 + 右侧图表卡片（`chart: { type, data, options }`）
- `table`：表格页（`table: { rows, options }`）
- `image`：大图页（`image: { path|data|link, x,y,w,h, sizing }`）
- `quote`：引用页（`quote` / `author`）
- `blank`：空白底页（便于你用 `elements` 自定义）

任意 slide 可附加：

- `notes`：speaker notes
- `elements`：低层 API（直接映射到 `slide.addText/addShape/addImage/addChart/addTable/addMedia`）

`elements` 示例（自定义形状 + 图片）：

```json
{
  "type": "blank",
  "elements": [
    { "type": "shape", "shape": "rect", "options": { "x": 0, "y": 0, "w": 13.33, "h": 7.5, "fill": { "color": "0B1220" }, "line": { "color": "0B1220" } } },
    { "type": "image", "options": { "path": "assets/hero.png", "x": 1, "y": 1, "w": 11.33, "h": 5.5, "sizing": { "type": "contain", "w": 11.33, "h": 5.5 } } }
  ]
}
```

## 生成“精美”排版的工作流（给 Agent 的硬约束）

- 先做“设计选择”：受众/场景/语气 → 主题色与信息层级（不要默认模板）。
- 把用户文本变成每页 1 个中心信息点；每页不超过 6 行要点（宁可拆页）。
- 默认用 `LAYOUT_16x9`；颜色统一用 `RRGGBB`（不要 `#`；脚本会尝试自动去掉 `#`）。
- 如果需要更细的 API 参数：只在需要时阅读 `skills/pptxgen/references/pptxgenjs-api.md`。

## 常见增强（建议优先用）

- 图表页：用 `chart` 类型，左侧要点解释，右侧图表占更大面积。
- 图片页：用 `image.sizing.type = "contain"|"cover"`，减少手算比例。
- 表格页：表头强调（`options.autoPage` / `options.fill` / `options.border` 等按需加）。
