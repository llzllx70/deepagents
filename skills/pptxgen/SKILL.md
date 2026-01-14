---
name: pptxgen
description: 当用户给出一段文本/大纲/结构化要点，比如markdown文件,自动排版成现代风格的 .pptx
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

- `modernLight`（默认，已针对中文报告优化）
- `modernDark`
- `techDark`（深色科技风，网格背景 + 霓虹强调）
- `eduLight`（教育/招生报告更偏“政务简洁风”）
- `eduDark`

## 深色科技风默认方案（必含封面/目录/过渡/致谢）

当用户未指定风格或明确要求“深色科技风”时，使用以下默认方案，确保全局一致性：

- 主题：`techDark`（深色底 + 霓虹强调 + 轻网格背景）
- 页面大小：`LAYOUT_16x9`
- 字体：标题/正文统一 `Microsoft YaHei`（可按需覆盖 `meta.theme.fonts`）
- 边距与安全区：左右 0.9 in，标题区 y=0.6 in，正文区 y=1.65 in，底部 0.55 in
- 色彩基调（RRGGBB）：背景 `070B14`，卡片 `0D1526`，正文 `E6F0FF`，弱化字 `9FB2D9`，主强调 `00D4FF`，次强调 `5B8CFF`
- 必含页面：封面、目录、过渡页（章节分隔）、内容页、致谢页

## 需求到 Deck 的标准流程（必须产出 md 大纲）

1) 设计原则与风格确认：受众/场景/语气 → 选择 `techDark` 并声明必含页面
2) 制定计划：生成 `workspace/deck-outline.md`（先大纲，再分页）
3) 分页设计：按“每页 1 个中心信息点”拆页，规划封面/目录/过渡/内容/致谢
4) 产出 Deck Spec：根据分页落 `slide.type` 与结构化字段
5) 生成 PPTX：运行 `spec2pptx.js` 验收

### `deck-outline.md` 模板（示例）

```md
# 标题：深色科技风主题报告

## 受众与目标
- 受众：
- 目标：

## 设计风格与规范
- 主题：techDark
- 页面大小：LAYOUT_16x9
- 字体：Microsoft YaHei
- 色彩：070B14 / 0D1526 / E6F0FF / 9FB2D9 / 00D4FF / 5B8CFF

## 目录（章节）
1. ...
2. ...
3. ...

## 分页计划
| 页码 | 类型 | 标题 | 核心信息点 | 可视化/素材 |
| --- | --- | --- | --- | --- |
| 1 | 封面 | ... | 主题与副标题 | 主视觉 |
| 2 | 目录 | ... | 章节列表 | 无 |
| 3 | 过渡 | ... | 章节引入 | 无 |
| 4 | 内容 | ... | 要点/数据 | 图表/表格 |
| N | 致谢 | ... | 结尾与联系信息 | Logo/二维码 |
```

## 分页定位与页面类型

- 封面页：`type: "title"`（主标题 + 副标题 + meta）
- 目录页：`type: "toc"`（`items` 或 `bullets`）
- 过渡页：`type: "transition"` 或 `type: "section"`（章节分隔）
- 内容页：`type: "content" | "chart" | "table" | "image"`
- 致谢页：`type: "thanks"`（结尾 + 联系方式）

## 页面专用 Prompt（不同页面用不同提示词）

- 封面页 prompt：只输出封面所需字段（title/subtitle/meta），强调“深色科技风 + 主题表达 + 简洁”
- 目录页 prompt：只输出章节标题列表（items 或 bullets），长度 ≤ 6，保证并列语义
- 过渡页 prompt：只输出章节标题 + 1 句引导语（subtitle），强调“章节切换”
- 内容页 prompt：仅 1 个中心信息点，3–6 条短句要点，必要时指定 chart/table
- 致谢页 prompt：只输出致谢标题 + 联系方式（meta 或 subtitle），避免长段落

## Deck Spec（JSON）结构

最小结构：

```json
{
  "meta": { "title": "示例标题", "author": "AI", "layout": "LAYOUT_16x9", "theme": "techDark" },
  "slides": [
    { "type": "title", "title": "封面标题", "subtitle": "一句副标题", "meta": "单位｜日期" },
    { "type": "content", "title": "核心要点", "bullets": ["要点 A", "要点 B", "要点 C"] }
  ]
}
```

支持的 `slide.type`：

- `title`：封面
- `section`：章节页
- `transition`：过渡页（章节分隔，等同 `section`，可用 `label` 定义提示语）
- `toc`：目录页（也会自动识别 `title=目录/大纲/议程` 且 `bullets` 为“`一、...`”格式的 `content`）
- `content`：左要点 + 右侧卡片（可选 `aside`）
- `chart`：左要点 + 右侧图表卡片（`chart: { type, data, options }`）
- `table`：表格页（`table: { rows, options }`）
- `image`：大图页（`image: { path|data|link, x,y,w,h, sizing }`）
- `quote`：引用页（`quote` / `author`）
- `thanks`：致谢页（大标题 + 联系方式）
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
- 把用户文本变成每页 1 个中心信息点；优先 **短句** 与 **数据点**；要点过长就拆页/改表格/改图。
- 默认用 `LAYOUT_16x9`；颜色统一用 `RRGGBB`（不要 `#`；脚本会尝试自动去掉 `#`）。
- 如果需要更细的 API 参数：只在需要时阅读 `skills/pptxgen/references/pptxgenjs-api.md`。

## 适应性设计原则（让 LLM 动态生成不同排版）

目标：同一套视觉语言（字体/色板/卡片/标题样式一致），但不同页面用不同的版式组合来适配内容密度，避免“强行左右两栏”。

### 版式选择（建议的决策树）

- **目录/议程**：`type: "toc"`（或 `title=目录/大纲/议程` + `bullets` 形如 `一、...`）
- **章节分隔**：`type: "section"`
- **过渡页**：`type: "transition"`（可用 `label` 显示“TRANSITION/章节”等提示语）
- **解释性要点**（3–6 条短句）：`type: "content"` + `layout: "tiles"`（会自动做卡片网格）
- **解释性要点**（长句/信息密集）：`type: "content"` + `layout: "oneCol"`（增加宽度减少换行）
- **需要一句话结论**：`type: "content"` + `aside.text: "核心结论：..."`（短则自动变成右上角徽章；长则转为侧栏）
- **需要图表**：`type: "chart"`（左解释右图；脚本会自动修正“单类目+多系列导致窄图”的常见错误）
- **需要表格**：`type: "table"`（表头高亮+斑马纹；对“保底/冲刺/不建议”等标签自动上色）
  - 如果首行不是表头：设置 `table.headerRows: 0`（或 `table.options.headerRows: 0`）避免误染色
 - **致谢收尾**：`type: "thanks"`（标题 + 联系方式）

### 防溢出（最重要）

- 先控制内容：每页不超过 5–7 条要点；单条要点尽量 ≤ 25 字（太长就拆成两条或改表格）。
- 如果你无法控制内容长度：让脚本兜底分页/缩小字号：
  - `content` 页会根据盒子高度 **自动缩字**，必要时自动拆成 `（续）` 多页。
  - 你也可以手动指定：`slide.style.bulletFontSize`（例如 14/16）。

## 示例：从“任意大纲文本”动态生成 deck spec（伪代码）

核心思路：先把输入拆成“章节→页面→块”，再选择最合适的 `slide.type/layout`。

```js
function toSlides(outline) {
  const slides = [];
  slides.push({ type: 'title', title: outline.title, subtitle: outline.subtitle, meta: outline.meta });
  slides.push({ type: 'toc', title: '目录', items: outline.sections.map(s => s.title) });

  for (const sec of outline.sections) {
    slides.push({ type: 'transition', title: sec.title, subtitle: sec.subtitle });
    for (const block of sec.blocks) {
      if (block.kind === 'chart') slides.push({ type: 'chart', title: block.title, bullets: block.takeaways, chart: block.chart });
      else if (block.kind === 'table') slides.push({ type: 'table', title: block.title, table: block.table });
      else {
        const isShort = block.bullets.every(t => t.length <= 18) && block.bullets.length <= 6;
        slides.push({
          type: 'content',
          title: block.title,
          bullets: block.bullets,
          layout: isShort ? 'tiles' : 'oneCol',
          aside: block.conclusion ? { text: `核心结论：${block.conclusion}` } : undefined
        });
      }
    }
  }
  slides.push({ type: 'thanks', title: '感谢聆听', subtitle: outline.contact });
  return slides;
}
```

## 常见增强（建议优先用）

- 图表页：用 `chart` 类型，左侧要点解释，右侧图表占更大面积。
- 图片页：用 `image.sizing.type = "contain"|"cover"`，减少手算比例。
- 表格页：表头强调（`options.autoPage` / `options.fill` / `options.border` 等按需加）。

## Aside（右侧卡片）常用字段

- `aside.text`：一句话结论（建议写成 `“核心结论：...”`，会自动拆成标签 + 正文）
- `aside.emphasis: true`：加粗/更醒目
- `aside.warning: true`：警示色样式（适合风险、提醒）
