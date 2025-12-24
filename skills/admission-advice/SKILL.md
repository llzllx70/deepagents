---
name: admission-advice
description: 用于高考志愿报考建议与专业选择分析的技能。 
---

# 报考建议 Skill（Admission Advice Skill）

## 一、技能定位（Skill Positioning）

Admission Advice Skill 是一套 **面向高校招生 B 端场景** 的志愿报考分析技能。

设计目标：

* 完全不依赖外部网络搜索
* 仅基于本地招生信息目录下的数据
* 分析过程结构化、可解释、可审计
* 输出标准化 HTML + PDF 报告
* 报告中必须包含可视化图表

适用于：

* 高校招生系统（内网 / 私有化部署）
* 志愿填报辅助系统
* 招生咨询 AI 智能体的分析子能力

---

## 二、适用场景（Use Cases）

* 为单一考生生成定制化志愿填报建议
* 基于近 1–3 年录取数据进行分析
* 构建 冲刺 / 适中 / 稳妥 多梯度志愿方案
* 支持高校招生季批量咨询场景

---

## 三、输入约束（Input Constraints）

⚠️ 本 Skill **严禁任何形式的网络搜索**。

仅允许使用：

* 用户输入的文本信息
* 用户上传或 workspace 中已有的本地文件
* 招生信息目录下的xlsx文件

---

## 四、工作目录规范（Workspace Convention）

统一工作目录：

```
workspace/admission/
```

每个考生使用独立 case 目录：

```
workspace/admission/case_[省份]_[选科]_[分数]/
```

### 强制目录结构

```
case_xxx/
├── input/
├── analysis/
├── draft/
├── charts/
└── output/
```

---

## 五、数据字段契约（Excel）

默认数据文件：

```
招生信息/*.xlsx
```

### 推荐字段

* 年份：year / 年份
* 省份：province / 省份
* 科类：subject / 选科 / 科类
* 学校：school / 院校
* 专业：major / 专业
* 录取最低分：min_score / 最低分

### 字段兜底规则

* year ← 年份(批次) / batch / 从字符串中解析年份
* major ← 专业名称 / specialty
* min_score ← 投档线 / 分数线

---

## 六、分析流程（Workflow）

### Step 0：初始化目录

创建 input / analysis / draft / charts / output

---

### Step 1：结构化输入

* input/candidate_profile.md
* input/data_contract.md

---

### Step 2：分析计划

生成 analysis/analysis_plan.md

---

### Step 3：分析子任务（≤3 个）

每个子任务输出：

```
analysis/findings_<task>.md
```

---

## 七、图表生成（强制）

- 先在charts目录中生成png图片，再在html中通过路径引用
- 要能够正常显示中文，使用'Hiragino Sans GB'字体，一定
- 这类复杂图片不要用直接用html/css/js的方式生成图, 切记
- 生成的图要依据实际需要，不局限于某几类，如趋势图，拆线图，柱状图，生成后要对图表进行说明
- 如果是柱状图，要有一定的区分度

### 图表一：重点专业 2022–2024 录取分数趋势

```
charts/major_trend_2022_2024.png
```

要求：

* 折线图
* 含“您的分数”虚线

---

### 图表二：2024 年各专业录取分数对比

```
charts/major_score_2024.png
```

分级规则：

* 稳妥：≤ user_score − 15（绿色）
* 适中：≤ user_score + 5（黄色）
* 冲刺：> user_score + 5（红色）

---

## 八、HTML 报告生成

生成：

```
draft/report.html
```

必须嵌入：

* ../charts/major_trend_2022_2024.png
* ../charts/major_score_2024.png

---

## 九、HTML → PDF

* [ ] 调用

```
skills/admission-advice/scripts/html2pdf.py draft/report.html output/report.pdf
```

---

## 十、最终交付物

* charts/*.png
* draft/report.html
* output/report.pdf

---

## 十一、免责声明

本 Skill 仅作为志愿填报辅助工具，不构成录取承诺。
