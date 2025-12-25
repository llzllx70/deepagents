---
name: admission-advice
description: 用于高考志愿报考建议与专业选择分析的技能。 
---

# 报考建议 Skill（Admission Advice Skill）

## 一、技能定位（Skill Positioning）

Admission Advice Skill 是一套 **面向高校招生** 的志愿报考分析技能。

设计目标：

* 基于本地招生信息目录下的数据
* 分析过程结构化、可解释、可审计、信息丰富、有深度
* 输出标准化md文件

适用于：

* 高校招生系统（内网 / 私有化部署）
* 志愿填报辅助系统
* 招生咨询 AI 智能体的分析子能力

## 二、适用场景（Use Cases）

* 为单一考生生成定制化志愿填报建议
* 基于近 1–3 年录取数据进行分析
* 构建 冲刺 / 适中 / 稳妥 多梯度志愿方案
* 支持高校招生季批量咨询场景

## 三、输入约束（Input Constraints）

* 用户输入的文本信息
* 招生信息目录下的xlsx文件

## 四、工作目录规范（Workspace Convention）

统一工作目录：

```
workspace/admission/
```

每个考生使用独立case目录：

```
workspace/admission/case_[省份]_[选科]_[分数]/
```

### 强制目录结构

```
case_xxx/
├── input/
├── infos/
├── analysis/
├── draft/
├── charts/
└── output/
```

## 五、数据源

默认数据文件：

```
招生信息/*.xlsx
```
注意，源excel文件中并不是完全规范的结构化信息，你需要借助LLM提取相关信息

## 六、分析流程（Workflow）

### Step 0：初始化目录

创建 input / infos / analysis / draft / charts / output

### Step 1: 关键数据提取 (务必遵守下面的方式)

1. 对每个excel调用excel_to_llm_text.py提取数据，所有xxx.txt要保存在infos 目录下
```
python skills/admission-advice/scripts/excel_to_llm_text.py --input path_2_excel/xxx.xlsx --output path_2_infos/xxx.txt
```
2. 分析所有xxx.txt中的数据，提取与本问题相关的信息

### Step 2：结构化输入

* input/candidate_profile.md
* input/data_contract.md

### Step 3：分析计划

生成 analysis/analysis_plan.md

### Step 4：分析子任务（≤10 个）

依据用户问题，设计不同的分析任务，比如：
1. 报考学生所在省份招生政策解读
2. 源数据中省控线对⽐
3. 三年录取分数趋势
4. 报考可能性分析
5. 重要提醒
6. 其他相关的分析任务

每个子任务输出：

```
analysis/findings_<task>.md
```

所有的分析要尽可能多的包含具体的数据

## 结果输出

- 汇总子任务的结果，生成draft/report.md 

