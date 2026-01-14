---
name: html2pptx
description: 将本地 HTML 文件转换为 PPTX，适用于长滚动页面与报告导出；支持按最大 slide 高度拆分为多页并合并输出可编辑 PPTX
---
# HTML 转 PPTX

使用本技能将本地 HTML 文件转换为 PPTX。默认在页面过长时按最大高度拆分为多页并合并输出。

## 使用方式

node skills/html2pptx/scripts/html2pptx.js --in input.html --out output.pptx [options]

## 常用参数

- --max-slide-height-in <n>  设置每页最大高度（英寸），超过则拆分（默认 7.5，适合 16:9 放映）
- --scale <n>                在拆分前按比例缩放（默认 1）
- --no-split                 强制单页输出；未指定 --scale 时会自动缩放以适配 max 高度
- --tmp-dir <dir>            临时目录
- --debug                    保留临时图片

## 拆分页规则（默认开启）

- 优先按内容边界分页，避免在元素中间切分
- 表格与图片尽量保持完整
- 标题会与紧随内容放在同一页；整节内容在可容纳时会保持同页（依赖 H1-H6 标签识别章节）
- 若单个区块高度超过页高，会提示并可能裁剪，可用 --scale 或提高 --max-slide-height-in 调整
