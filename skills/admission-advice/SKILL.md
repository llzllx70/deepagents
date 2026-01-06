---
name: admission-advice
description: 用于高考志愿报考建议与专业选择分析的技能。
---

# 报考建议 Skill（Admission Advice Skill）

该技能用于高校招生志愿分析，强调结构化、可审计、信息丰富的深入研究。采用主代理统筹、子代理分工、主代理汇总的单层协作结构。

## 何时使用

- 需要基于本地招生数据进行深度分析
- 需要输出可追溯的数据依据与结论
- 需要构建冲刺 / 适中 / 稳妥的志愿方案

## 输入与数据源

- 用户输入文本
- 本地数据：`招生信息/*.xlsx`
- 注意：源 Excel 并非完全规范结构化，必须通过脚本提取为可读文本后再分析

## 工作目录规范

统一目录：

```
workspace/admission/
```

每个考生一个独立 case：

```
workspace/admission/case_[省份]_[选科]_[分数]/
```

必须包含以下结构：

```
case_xxx/
├── input/
├── infos/
├── analysis/
├── draft/
├── charts/
└── output/
```

## 研究与分析流程（main-agent → sub-agents → main-agent）

### Step 1: 建立 case 与研究计划（主代理）

1. 创建 case 目录及子目录
2. 分析问题，拆分为不重叠的子任务（建议 3–8 个，最多 10 个）
3. 写入 `analysis/analysis_plan.md`，内容必须包含：
   - 主问题与分析目标
   - 子任务列表与预期产出
   - 需要使用的数据文件清单
   - 合成输出方式
4. 生成 `analysis/todos.md`，列出子任务的执行顺序与负责人（主代理/子代理）
5. 初始化结构化输入：
   - `input/candidate_profile.md`
   - `input/data_contract.md`

### Step 2: 数据抽取与结构化（主代理，可分派给子代理）

对每个 Excel 文件执行以下脚本，输出到 `infos/`：

```
python skills/admission-advice/scripts/excel_to_llm_text.py --input path_2_excel/xxx.xlsx --output path_2_infos/xxx.txt
```

然后基于 `infos/*.txt` 填充：

- `input/candidate_profile.md`（考生画像）
- `input/data_contract.md`（数据字段说明、口径约定）

如使用子代理，仅允许执行数据抽取与摘要，输出仍写入 `infos/` 或 `input/`；禁止子代理再生成子代理。

### Step 3: 分析子任务执行（子代理）

为每个子任务创建一个子代理，输出文件必须为：

```
analysis/findings_<task>.md
```

子代理任务模板：

```
任务：<具体分析子题>
可用数据：infos/*.txt, input/*.md
输出文件：analysis/findings_<task>.md
要求：只做本子题分析，写清数据依据，禁止再生成子代理，默认不联网。
```

### Step 4: 汇总与输出（主代理）

1. 使用 `list_files` 确认 `analysis/` 下的 findings 文件
2. 使用 `read_file` 汇总全部子任务结果
3. 输出 `draft/report.md`，建议结构：
   - 结论总览
   - 冲刺 / 适中 / 稳妥 方案
   - 数据依据与关键指标
   - 风险提示与重要提醒
   - 其他补充建议

必要时将最终版本复制到 `output/` 目录。

## 可用工具

- `write_file`：生成计划、结构化输入与报告
- `read_file`：读取本地数据与子任务结果
- `list_files`：查看本地目录结构
- `task`：创建子代理执行子任务
- 本地脚本：`skills/admission-advice/scripts/excel_to_llm_text.py`

## 子代理规则（必须遵守）

- 只接受主代理分配的单一子任务
- 禁止创建或指挥其他子代理
- 默认不访问互联网；除非主代理明确要求且环境允许
- 输出必须写入指定文件，不直接返回长文本

## 最佳实践

- 先计划再分工，计划文件必须先于子任务生成
- 数据抽取步骤不可跳过，避免直接读 Excel 内容
- 子任务之间保持边界，避免内容重叠
- 汇总时必须引用具体数据来源
