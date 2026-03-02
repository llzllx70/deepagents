# HTML 幻灯片高级设计指南 (v4.0)

本文件是生成专业HTML演示文稿的**核心规范**。所有生成的幻灯片必须严格遵循本指南。

---

## 1. 核心设计原则

在编写任何代码之前，请牢记以下原则：

- **一页一观点**: 每张幻灯片只传达一个核心信息，避免信息过载。
- **留白即设计**: 充分利用空白区域，不要试图填满每一寸空间。留白能引导视线、提升高级感。
- **对比创层次**: 通过字号、字重、颜色的强对比来建立清晰的视觉层级（标题 vs 正文 vs 辅助文字）。
- **一致性**: 全篇使用统一的设计语言（字体、颜色、间距、圆角），不在不同页面使用不同风格。
- **节奏感**: 交替使用不同版式（全屏色块页、白底内容页、卡片页、引用页），避免所有页面看起来一样。

---

## 2. 全局CSS变量系统

**必须**将以下CSS变量置于 `<style>` 标签顶部。根据 `color_palettes.md` 中用户选择的配色方案替换颜色值。

```css
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
    /* === 色彩系统 (根据配色方案替换) === */
    --c-primary: #1A5276;       /* 主色调: 用于标题、强调 */
    --c-secondary: #2E86C1;     /* 辅助色: 用于副标题、链接 */
    --c-accent: #48C9B0;        /* 点缀色: 用于装饰、标签、图标 */
    --c-text: #1C2833;          /* 主要文字色 */
    --c-text-light: #5D6D7E;    /* 次要文字色 */
    --c-bg: #FAFBFC;            /* 页面浅灰背景 */
    --c-white: #FFFFFF;         /* 白色 */
    --c-border: #E8ECF0;        /* 边框色 */

    /* === 字体 === */
    --font-main: 'Inter', 'Noto Sans SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;

    /* === 间距 (8px基线网格) === */
    --s-xs: 4px; --s-sm: 8px; --s-md: 16px; --s-lg: 24px; --s-xl: 32px; --s-2xl: 48px; --s-3xl: 64px;

    /* === 页脚预留高度 === */
    --footer-reserve: 56px;

    /* === 圆角与阴影 === */
    --radius: 10px;
    --shadow: 0 2px 8px rgba(0,0,0,0.06);
}
```

> **`--footer-reserve` 说明**: 该变量定义了页脚区域的预留高度（包含页脚本身高度 + 上方分隔线 + 间距）。所有带页脚的幻灯片必须通过 `padding-bottom` 为页脚预留此空间，防止内容与页脚重叠。

**必须**在HTML `<head>` 中引入 Google Fonts:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
```

---

## 3. 布局与分页（关键）

**必须**使用固定 `cm` 单位。这是确保屏幕显示与PDF导出一致的唯一可靠方法。

```css
/* ===== 幻灯片容器 ===== */
.slide {
    width: 25.4cm;
    height: 14.29cm;
    padding: var(--s-2xl);
    padding-bottom: calc(var(--s-2xl) + var(--footer-reserve));  /* 为页脚预留空间 */
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    font-family: var(--font-main);
    color: var(--c-text);
    background-color: var(--c-white);
}

/* 封面页和结束页没有页脚，不需要额外预留空间 */
.slide.cover, .slide.end {
    padding-bottom: var(--s-2xl);
}

/* ===== 屏幕显示 ===== */
body {
    margin: 0;
    background-color: #E5E5E5;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 0;
    font-family: var(--font-main);
}
.slide { margin-bottom: 40px; border-radius: var(--radius); box-shadow: 0 4px 20px rgba(0,0,0,0.12); }

/* ===== PDF导出页面尺寸（关键：必须在顶层声明） ===== */
@page { size: 25.4cm 14.29cm; margin: 0; }

/* ===== 打印/PDF导出样式 ===== */
@media print {
    body { margin: 0; padding: 0; background: transparent; display: block; }
    body { -webkit-print-color-adjust: exact !important; color-adjust: exact !important; print-color-adjust: exact !important; }
    .slide { margin: 0; box-shadow: none; border-radius: 0; overflow: hidden; }
    .slide { page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; }
    .slide:last-child { page-break-after: auto; break-after: auto; }
}
```

> **❗ 关键警告 — 页脚预留空间**: `.slide` 的 `padding-bottom` 必须使用 `calc(var(--s-2xl) + var(--footer-reserve))` 为页脚预留空间。由于页脚使用 `position: absolute` 脱离文档流，如果不预留空间，内容区域会与页脚重叠。封面页（`.cover`）和结束页（`.end`）没有页脚，需要用 `padding-bottom: var(--s-2xl)` 覆盖回正常值。

> **❗ 关键警告 — @page 必须在顶层声明**: `@page` 是 CSS 顶层规则，**禁止**嵌套在 `@media print` 内部。嵌套声明会导致 Chromium 忽略该规则，从而回退到默认的 A4 竖版尺寸，使 PDF 导出结果与幻灯片的横版设计不匹配。必须确保 `@page { size: 25.4cm 14.29cm; margin: 0; }` 单独作为顶层规则写在 `@media print` **之前**。

> **重要警告**: `overflow: hidden` 会裁剪超出容器的内容。如果需要装饰元素延伸到边缘，请使用 `position: absolute` 并确保其在容器内部。所有装饰性伪元素（`::before`, `::after`）的定位必须在 `.slide` 容器范围内。

---

## 4. 内容量硬性约束（最高优先级）

> **❗❗❗ 这是整个设计指南中最重要的章节。违反本章节的任何规则都会导致幻灯片在 PDF 导出时内容溢出、重叠或被裁剪，严重破坏演示效果。**

### 4.1 可用空间计算

每张幻灯片的物理尺寸固定为 **25.4cm × 14.29cm**（960px × 540px @96dpi）。扣除 padding 和页脚预留后，**实际可用内容区域**为：

| 区域 | 尺寸 |
| :--- | :--- |
| 幻灯片总高度 | 540px |
| 顶部 padding | -48px |
| 底部 padding + 页脚预留 | -104px (48px + 56px) |
| **可用内容高度** | **≈ 388px** |
| 标题区域（含下边框和间距） | -60px |
| **标题下方可用高度** | **≈ 328px** |

### 4.2 每种版式的硬性数量限制

以下是每种版式在一页中能容纳的**最大元素数量**，**绝对不可超出**：

| 版式 | 硬性上限 | 说明 |
| :--- | :--- | :--- |
| 卡片网格（单行） | **最多 3-4 张卡片** | 单行横排，每张卡片含 1 个标签 + 1 个标题 + 1-2 行描述 |
| 卡片网格（2行 wrap） | **最多 4 张卡片（2×2）** | 使用 `.card-grid.wrap`，每张卡片含 1 个标签 + 1 个标题 + 1 行描述 |
| 卡片网格（2行 wrap） | **最多 6 张卡片（2×3）** | 使用 `.card-grid.wrap`，每张卡片仅含 1 个标题 + 极短描述（15字以内） |
| 标准内容页 | **1 个标题 + 最多 5 个要点** | 或 1 个标题 + 1 段描述（3行）+ 3 个要点 |
| 两栏布局 | **每栏最多 4 个列表项** | 或每栏 1 个小标题 + 3 行文字 |
| 数据统计页 | **最多 3-4 个统计卡片** | 每个卡片 1 个数字 + 1 行标签 + 1 行描述 |
| 数据统计页 + 补充内容 | **禁止** | 统计卡片下方不可再添加列表、段落或总结框 |
| 目录页 | **最多 6 个目录项（3×2）** | 超过 6 个章节应拆分为两页目录 |

> **❗ 绝对禁止的做法：**
> - **禁止**在一页中放置超过 6 张卡片（即使是最精简的卡片）
> - **禁止**在统计数据页的统计卡片下方再添加列表、段落、总结框等额外内容
> - **禁止**在一页中混合使用两种以上的内容组件（如统计卡片 + 列表 + 总结框）
> - **禁止**使用 `flex-wrap: wrap` 产生超过 2 行的卡片布局

### 4.3 内容超出时的处理策略

当内容量超出单页限制时，**必须拆分为多页**，而非：
- ~~缩小字号~~
- ~~压缩间距~~
- ~~减少 padding~~
- ~~去掉页脚~~

**拆分示例：**

| 原始需求 | 错误做法 | 正确做法 |
| :--- | :--- | :--- |
| 展示 8 个岗位类型 | 在一页放 8 张卡片（2×4） | 拆分为 2 页，每页 4 张卡片（2×2） |
| 3 个统计数据 + 4 个要点 + 总结 | 全部塞在一页 | 第 1 页：3 个统计卡片；第 2 页：要点列表 + 总结 |
| 10 个目录项 | 在一页放 10 个目录卡片 | 拆分为 2 页目录，每页 5 个 |

### 4.4 自检清单

生成每一页 HTML 后，必须逐项检查：

1. ☐ 卡片数量是否 ≤ 4（wrap 布局）或 ≤ 4（单行布局）？
2. ☐ 使用 `flex-wrap: wrap` 时，卡片是否只产生了最多 2 行？
3. ☐ 统计数据页是否只包含统计卡片，没有额外的列表或段落？
4. ☐ 标准内容页的要点是否 ≤ 5 个？
5. ☐ 每张卡片的描述文字是否 ≤ 2 行（约 30-40 个中文字符）？
6. ☐ 页面中是否只有一种主要内容组件（不混合卡片+列表+统计）？
7. ☐ 如果内容超出限制，是否已拆分为多页？

---

## 5. 防溢出CSS机制

为了防止内容溢出幻灯片边界或与页脚重叠，**必须**在所有 flex 布局的内容区域应用以下防溢出规则：

```css
/* ===== 内容区域防溢出 ===== */

/* 主内容容器：flex: 1 填满剩余空间，min-height: 0 允许收缩 */
.slide-body, .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;  /* 关键：允许 flex 子元素在空间不足时收缩 */
}

/* 可伸缩的子容器（卡片网格、列表等）也需要 min-height: 0 */
.card-grid, .toc-grid, .stats-row, .cols {
    min-height: 0;
}

/* 卡片内部的描述文字：防止溢出 */
.card p, .card .desc {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;    /* 最多显示2行，超出部分用省略号 */
    -webkit-box-orient: vertical;
}
```

> **❗ 为什么需要 `min-height: 0`**: 在 CSS Flexbox 中，flex 子元素的默认 `min-height` 是 `auto`（即内容的最小高度），这意味着即使设置了 `flex: 1`，子元素也不会收缩到比其内容更小。设置 `min-height: 0` 允许子元素在空间不足时收缩，从而防止内容溢出容器。

> **`-webkit-line-clamp` 说明**: 这是最后一道防线。即使 AI 生成了过长的描述文字，CSS 也会自动截断为 2 行并显示省略号，防止文字溢出卡片边界。但这不应该被视为正常行为——正确的做法是在生成内容时就控制好文字量。

---

## 6. 排版系统

```css
/* 标题层级 */
h1 { font-size: 2.4em; font-weight: 800; color: var(--c-primary); line-height: 1.15; letter-spacing: -1px; margin: 0 0 var(--s-lg); }
h2 { font-size: 1.8em; font-weight: 700; color: var(--c-primary); line-height: 1.25; margin: 0 0 var(--s-md); }
h3 { font-size: 1.15em; font-weight: 600; color: var(--c-text); line-height: 1.35; margin: 0 0 var(--s-sm); }

/* 正文 */
p { font-size: 0.95em; line-height: 1.7; color: var(--c-text-light); margin: 0 0 var(--s-md); }
li { font-size: 0.95em; line-height: 1.7; color: var(--c-text-light); margin-bottom: var(--s-sm); }
ul { list-style: none; padding: 0; margin: 0; }

/* 自定义列表圆点 */
ul li { padding-left: 20px; position: relative; }
ul li::before { content: ''; position: absolute; left: 0; top: 10px; width: 7px; height: 7px; border-radius: 50%; background: var(--c-accent); }

/* 小号辅助文字 */
.small-text { font-size: 0.8em; color: var(--c-text-light); }
```

---

## 7. 版式蓝图与CSS

以下是核心版式。生成幻灯片时，**必须**根据内容特点选择合适的版式，并交替使用以创造节奏感。

### 7.1 封面页 (Cover)

视觉冲击力最强的页面。使用渐变背景、大标题、装饰性元素。**封面页没有页脚**。

```css
.cover { justify-content: center; align-items: center; text-align: center; padding: var(--s-3xl) 80px; background: linear-gradient(135deg, var(--c-primary) 0%, var(--c-secondary) 70%, var(--c-accent) 100%); }
.cover::before { content: ''; position: absolute; top: -30%; right: -10%; width: 420px; height: 420px; border-radius: 50%; background: rgba(255,255,255,0.06); pointer-events: none; }
.cover::after { content: ''; position: absolute; bottom: -25%; left: -8%; width: 350px; height: 350px; border-radius: 50%; background: rgba(255,255,255,0.04); pointer-events: none; }
.cover h1 { font-size: 2.8em; color: white; position: relative; z-index: 1; }
.cover .divider { width: 60px; height: 3px; background: var(--c-accent); margin: var(--s-lg) auto; border-radius: 2px; position: relative; z-index: 1; }
.cover .subtitle { font-size: 1.2em; color: rgba(255,255,255,0.85); font-weight: 400; position: relative; z-index: 1; }
.cover .meta { font-size: 0.85em; color: rgba(255,255,255,0.55); margin-top: var(--s-md); position: relative; z-index: 1; }
```

### 7.2 目录页 (TOC)

使用网格卡片展示章节列表，数字用点缀色突出。**最多 6 个目录项（3行×2列）**。

```css
.toc h2 { margin-bottom: var(--s-xl); }
.toc-grid { display: flex; flex-wrap: wrap; gap: var(--s-md); flex: 1; align-content: flex-start; min-height: 0; }
.toc-item { flex: 1 1 calc(50% - var(--s-md)); background: var(--c-bg); border-radius: var(--radius); padding: var(--s-lg) var(--s-xl); display: flex; align-items: center; gap: var(--s-lg); border: 1px solid var(--c-border); }
.toc-item .num { font-size: 2em; font-weight: 800; color: var(--c-accent); min-width: 50px; }
.toc-item .label { font-size: 1em; font-weight: 600; color: var(--c-text); }
```

### 7.3 章节过渡页 (Section Divider)

简洁有力，用于章节间的视觉分隔。大号半透明数字作为背景装饰。

```css
.section-divider { justify-content: center; background: var(--c-bg); padding-left: 80px; }
.section-divider .big-num { font-size: 8em; font-weight: 800; color: var(--c-accent); opacity: 0.12; position: absolute; top: 50%; left: 60px; transform: translateY(-55%); line-height: 1; }
.section-divider .section-body { position: relative; z-index: 1; padding-left: 90px; }
.section-divider .section-body h2 { font-size: 2.2em; }
.section-divider .section-body p { font-size: 1em; color: var(--c-text-light); max-width: 500px; margin-top: var(--s-sm); }
```

### 7.4 标准内容页 (Content)

最常用的版式。标题带装饰色条，内容区域灵活。**最多 1 个标题 + 5 个要点**。

```css
.content .slide-header { display: flex; align-items: center; gap: var(--s-md); margin-bottom: var(--s-lg); padding-bottom: var(--s-md); border-bottom: 2px solid var(--c-border); flex-shrink: 0; }
.content .slide-header .bar { width: 4px; height: 28px; background: var(--c-accent); border-radius: 2px; flex-shrink: 0; }
.content .slide-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
```

### 7.5 卡片网格页 (Card Grid)

将并列信息以卡片形式展示。

> **❗ 卡片数量硬性限制：**
> - **单行布局**（不使用 wrap）：最多 **3-4 张**卡片
> - **两行布局**（使用 `.card-grid.wrap`）：最多 **4 张**卡片（2×2），极端精简时最多 6 张（2×3）
> - **绝对禁止**超过 2 行的卡片布局（即禁止 2×4、3×3 等）
> - 每张卡片描述文字不超过 **30 个中文字符**

```css
.card-grid { display: flex; gap: var(--s-lg); flex: 1; align-items: stretch; min-height: 0; }
.card-grid.wrap { flex-wrap: wrap; }
.card { flex: 1; background: var(--c-bg); border-radius: var(--radius); padding: var(--s-lg); border: 1px solid var(--c-border); display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.card-grid.wrap .card { flex: 1 1 calc(50% - var(--s-lg)); }
.card .tag { display: inline-block; background: var(--c-accent); color: white; padding: 3px 14px; border-radius: 20px; font-size: 0.7em; font-weight: 600; margin-bottom: var(--s-sm); align-self: flex-start; flex-shrink: 0; }
.card h3 { color: var(--c-secondary); font-size: 1.05em; flex-shrink: 0; }
.card p { font-size: 0.85em; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
```

### 7.6 两栏对比页 (Two Column)

左右分栏，适合对比、图文混排。可将一栏设为高亮色块。**每栏最多 4 个列表项**。

```css
.two-col .cols { display: flex; gap: var(--s-xl); flex: 1; align-items: stretch; min-height: 0; }
.two-col .col { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.two-col .col-highlight { flex: 1; background: linear-gradient(135deg, var(--c-primary), var(--c-secondary)); border-radius: var(--radius); padding: var(--s-xl); color: white; display: flex; flex-direction: column; min-height: 0; }
.two-col .col-highlight h3 { color: white; }
.two-col .col-highlight p, .two-col .col-highlight li { color: rgba(255,255,255,0.85); }
.two-col .col-highlight ul li::before { background: var(--c-accent); }
```

### 7.7 数据/统计页 (Stats)

用大号数字突出关键数据。**最多 3-4 个统计卡片，禁止在统计卡片下方添加任何额外内容**。

> **❗ 统计页专用规则：** 统计页的全部内容就是标题 + 统计卡片行。如果需要补充说明文字或列表，必须放在**下一页**，而非塞在同一页的统计卡片下方。

```css
.stats-row { display: flex; gap: var(--s-lg); flex: 1; align-items: stretch; min-height: 0; }
.stat-box { flex: 1; text-align: center; padding: var(--s-xl) var(--s-lg); background: var(--c-bg); border-radius: var(--radius); border: 1px solid var(--c-border); display: flex; flex-direction: column; justify-content: center; }
.stat-box .number { font-size: 2.8em; font-weight: 800; color: var(--c-secondary); line-height: 1; }
.stat-box .line { width: 30px; height: 3px; background: var(--c-accent); margin: var(--s-sm) auto; border-radius: 2px; }
.stat-box .label { font-size: 0.85em; font-weight: 600; color: var(--c-text); margin-top: var(--s-sm); }
.stat-box .desc { font-size: 0.75em; color: var(--c-text-light); margin-top: var(--s-xs); }
```

### 7.8 引用页 (Quote)

居中展示关键引言，用大号引号装饰。

```css
.quote { justify-content: center; align-items: center; text-align: center; background: var(--c-bg); padding: var(--s-3xl) 100px; }
.quote .mark { font-size: 6em; color: var(--c-accent); opacity: 0.2; line-height: 0.5; margin-bottom: var(--s-lg); }
.quote blockquote { font-size: 1.5em; font-weight: 600; line-height: 1.5; color: var(--c-primary); border: none; padding: 0; margin: 0; }
.quote .author { font-size: 0.9em; color: var(--c-text-light); margin-top: var(--s-xl); }
```

### 7.9 结束页 (End)

与封面呼应，使用相同的渐变背景。**结束页没有页脚**。

```css
.end { justify-content: center; align-items: center; text-align: center; background: linear-gradient(135deg, var(--c-primary) 0%, var(--c-secondary) 70%, var(--c-accent) 100%); }
.end::before { content: ''; position: absolute; top: -30%; right: -10%; width: 400px; height: 400px; border-radius: 50%; background: rgba(255,255,255,0.05); pointer-events: none; }
.end h2 { font-size: 2.8em; color: white; position: relative; z-index: 1; }
.end .divider { width: 50px; height: 3px; background: var(--c-accent); margin: var(--s-lg) auto; border-radius: 2px; position: relative; z-index: 1; }
.end p { color: rgba(255,255,255,0.65); font-size: 1em; position: relative; z-index: 1; }
```

### 7.10 页脚

所有非全屏色块页（封面、结束页除外）都应包含页脚。页脚使用绝对定位固定在底部。

```css
.footer { position: absolute; bottom: var(--s-lg); left: var(--s-2xl); right: var(--s-2xl); display: flex; justify-content: space-between; align-items: center; font-size: 0.7em; color: var(--c-text-light); opacity: 0.5; }
.footer .pg { width: 26px; height: 26px; border-radius: 50%; background: var(--c-primary); color: white; display: flex; align-items: center; justify-content: center; font-size: 0.7em; font-weight: 600; opacity: 1; }
```

> **❗ 页脚与内容不重叠的保障**: 页脚使用 `position: absolute` 脱离文档流，因此 `.slide` 容器的 `padding-bottom: calc(var(--s-2xl) + var(--footer-reserve))` 是唯一的防重叠保障。生成代码时务必确保此 padding 值正确。

---

## 8. 装饰元素技巧

以下是可以用纯CSS实现的装饰手法，用于提升设计感：

- **渐变色块背景**: 封面和结束页使用 `linear-gradient` 创造深度感。
- **半透明几何圆**: 使用 `::before` / `::after` 伪元素创建大型半透明圆形，增加层次。
- **色条装饰**: 标题旁的细色条（4px宽，accent色），用于标记章节标题。
- **标签胶囊**: 小型圆角标签（`border-radius: 20px`），用于分类标记。
- **分隔线**: 标题下方的细线（`border-bottom: 2px solid var(--c-border)`），用于区分标题区和内容区。
- **大号背景数字**: 章节页使用超大号半透明数字（`opacity: 0.1-0.15`）作为背景装饰。
- **渐变色条**: 页面侧边的渐变色条（`linear-gradient`），用于章节过渡页的视觉引导。

> **注意**: 由于 `.slide` 设置了 `overflow: hidden`，所有装饰元素必须使用 `position: absolute` 并确保其主体在容器范围内。超出部分会被自动裁剪，这是预期行为。
