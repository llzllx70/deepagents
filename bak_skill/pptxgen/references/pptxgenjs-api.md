# PptxGenJS API 速查（面向 pptxgen skill）

官方文档（优先以官方为准）：

- Charts: https://gitbrent.github.io/PptxGenJS/docs/api-charts/
- Images: https://gitbrent.github.io/PptxGenJS/docs/api-images/
- Media: https://gitbrent.github.io/PptxGenJS/docs/api-media/
- Shapes: https://gitbrent.github.io/PptxGenJS/docs/api-shapes/
- Tables: https://gitbrent.github.io/PptxGenJS/docs/api-tables/
- Text: https://gitbrent.github.io/PptxGenJS/docs/api-text/

## 关键约束（很重要）

- 颜色：PptxGenJS **不要用 `#RRGGBB`**，用 `RRGGBB`（例如 `FF0000`）。
- 坐标单位：`x/y/w/h` 默认是 **英寸**（inches）。

## Text（slide.addText）

常用形态：

- `slide.addText("字符串", options)`
- `slide.addText([{ text, options }, ...], options)`（富文本 runs；可用 `breakLine` 换行、可在 run 上设置 `bullet`）

常用 `options`：

- `x, y, w, h`
- `fontFace, fontSize, bold, italic, underline`
- `color`（`RRGGBB`）
- `align`：`left|center|right|justify`
- `valign`：`top|mid|bottom`
- `margin`：`[left, right, bottom, top]`

## Shapes（slide.addShape）

- `slide.addShape('rect' | 'roundRect' | 'ellipse' | 'line' | ... , options)`
- `options.fill = { color: 'RRGGBB', transparency?: 0-100 }`
- `options.line = { color: 'RRGGBB', width?: number, transparency?: 0-100 }`

## Images（slide.addImage）

三种来源：

- `{ path: '/abs/or/rel.png', x,y,w,h }`
- `{ data: 'data:image/png;base64,...', x,y,w,h }`
- `{ link: 'https://...' }`（需要网络）

`sizing`（把图片“装入”一个盒子，避免手算比例）：

```js
slide.addImage({
  path: 'img.png',
  x: 1, y: 1, w: 10, h: 5,
  sizing: { type: 'contain', w: 10, h: 5 }
})
```

## Charts（slide.addChart）

- `slide.addChart('bar'|'line'|'pie'|'doughnut'|..., data, options)`
- `data` 通常是数组（series）：`[{ name, labels:[], values:[] }, ...]`

## Tables（slide.addTable）

- `slide.addTable(tableRows, options)`
- `tableRows`：二维数组（row -> cell），cell 既可以是 `{ text, options }` 也可以是纯文本（取决于你构造方式）

## Media（slide.addMedia）

用于音频/视频：

- `slide.addMedia({ type: 'video'|'audio', path: 'file.mp4', x,y,w,h })`

