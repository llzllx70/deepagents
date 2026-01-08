# HTML to PPTX Converter

将HTML报告转换为可编辑的PPTX演示文稿，完整保留原HTML的字体、颜色、布局、表格、图片等效果。

## 功能特点

- **完整保留样式**：渐变背景、颜色主题、表格样式、卡片布局
- **图片嵌入**：自动识别并嵌入HTML中引用的图片
- **表格转换**：保留表头样式、交替行颜色、badge颜色标记
- **可编辑输出**：生成的PPTX文件可在PowerPoint/WPS中编辑
- **智能分页**：自动将HTML内容分割为多个幻灯片

## 环境要求

- Python 3.8+
- 依赖库：
  - python-pptx
  - beautifulsoup4
  - lxml

## 安装

```bash
pip install python-pptx beautifulsoup4 lxml
```

## 使用方法

### 命令行使用

```bash
python html_to_pptx.py <input.html> [output.pptx]
```

**参数说明：**
- `input.html`：输入的HTML文件路径（必需）
- `output.pptx`：输出的PPTX文件路径（可选，默认与输入文件同名）

**示例：**
```bash
# 基本用法
python html_to_pptx.py report.html

# 指定输出文件名
python html_to_pptx.py report.html presentation.pptx
```

### 代码调用

```python
from html_to_pptx import HTMLToPPTXConverter

# 创建转换器
converter = HTMLToPPTXConverter('report.html', 'output.pptx')

# 执行转换
output_path = converter.convert()
print(f"转换完成：{output_path}")
```

## 支持的HTML元素

| HTML元素 | PPTX效果 |
|---------|---------|
| `<h1>` | 标题页主标题 |
| `<h2>` | 章节标题 |
| `<h3>` | 内容标题 |
| `<table>` | 表格（保留样式） |
| `<img>` | 嵌入图片 |
| `.summary-box` | 渐变背景摘要框 |
| `.stat-card` | 统计数据卡片 |
| `.job-card` | 岗位推荐卡片 |
| `.timeline` | 时间线布局 |
| `.info/.warning/.recommendation` | 信息提示框 |
| `.badge` | 状态标签（颜色） |

## 自定义配置

可以通过修改 `HTMLToPPTXConverter` 类的属性来自定义转换效果：

```python
converter = HTMLToPPTXConverter('report.html')

# 自定义幻灯片尺寸（默认16:9宽屏）
converter.slide_width = Inches(10)
converter.slide_height = Inches(7.5)

# 自定义边距
converter.margin_left = Inches(0.5)
converter.margin_right = Inches(0.5)

# 自定义颜色
converter.colors['primary'] = RGBColor(52, 152, 219)

# 自定义字体
converter.fonts['title'] = 'Arial'
converter.fonts['body'] = 'Microsoft YaHei'

converter.convert()
```

## 输出示例

转换后的PPTX包含以下幻灯片类型：

1. **标题页** - 渐变背景，居中标题
2. **核心结论** - 渐变背景摘要框
3. **统计概览** - 数据卡片网格
4. **图表页** - 嵌入图片
5. **数据表格** - 格式化表格
6. **岗位卡片** - 双栏卡片布局
7. **时间线** - 分阶段计划
8. **策略建议** - 三栏优先级
9. **结论展望** - 摘要+卡片
10. **感谢页** - 渐变背景结束页

## 注意事项

1. **图片路径**：HTML中的图片路径应为相对路径，相对于HTML文件所在目录
2. **字体支持**：默认使用"Microsoft YaHei"字体，如系统不支持会使用默认字体
3. **复杂布局**：对于非常复杂的CSS布局，可能需要手动调整转换后的PPTX

## 许可证

MIT License

## 更新日志

### v1.0.0 (2026-01-08)
- 初始版本
- 支持基本HTML元素转换
- 支持表格、图片、卡片布局
- 支持渐变背景和颜色主题
