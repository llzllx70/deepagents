---
name: job-search-report
description: 个人就业岗位检索与图文报告生成技能。用于从简历出发，使用 coze-search 在 Boss 直聘与智联招聘等平台检索岗位、整理过程文件、计算匹配度并输出求职分析报告。
---
# 个人就业岗位检索与报告 Skill

基于本地简历生成岗位检索过程文件、匹配度分析与图文报告。

## When to Use This Skill

Use this skill when you need to:

- 依据简历在多个招聘平台检索岗位并整理过程文件
- 进行岗位匹配度评分与推荐清单输出
- 生成以表格为主的求职分析报告（可选图表）

## Research Process

### Step 1: Create and Save Case Plan

统一在 `workspace/job_search/` 下建 case：
`workspace/job_search/case_[姓名]_[目标职位]_[城市]/`

参考结构：

```
case_xxx/
├── input/
├── infos/
├── analysis/
├── draft/
├── charts/
└── output/
```

在 `analysis/analysis_plan.md` 写入：

- 目标岗位类型与城市
- 拆分的子任务（2–4 个）
- 需要的数据与产出

在 `analysis/todos.md` 写入执行顺序与负责人。

建立结构化输入：

- `input/resume.docx`（默认来源：`个人就业/学生简历.docx`）
- `input/resume_text.txt`
- `input/candidate_profile.md`

### Step 2: Extract Resume and Candidate Profile

使用脚本提取简历文本：

```
python skills/job-search-report/scripts/extract_docx_text.py --input 个人就业/学生简历.docx --output input/resume_text.txt
```

基于 `input/resume_text.txt` 生成 `input/candidate_profile.md`，至少包含：

- 核心技能与项目关键词
- 目标岗位/城市/薪资偏好（缺失则标注“待确认”）
- 教育背景与实习/项目经历摘要

### Step 3: Platform Search and Process Files

按平台分别检索（Boss 直聘、智联招聘等），检索必须使用 `coze-search` skill：

- 岗位检索使用coze search, 不要使用web_search、http_request、fetch_url
- 输出文件：`infos/boss_jobs.md`、`infos/zhilian_jobs.md`
- 每条岗位至少包含：公司、岗位名、薪资、经验、学历、地点、链接、技能要求、信息来源
- 记录检索关键词、筛选条件、信息来源到 `analysis/search_log.md`

如网络受限，优先请求授权或使用离线数据，并在报告中注明限制。

### Step 4: Structure Job Data and Scoring

1. 将岗位信息整理为 `analysis/jobs_data.json` 或 `analysis/jobs_data.csv`
2. 字段规范见 `references/job-data-schema.md`
3. 评分规则见 `references/scoring-rubric.md`

### Step 5: Tables and Charts (Optional)

默认使用表格呈现分析结果。仅在能够生成高质量效果图时才使用脚本生成图表：

```
python skills/job-search-report/scripts/build_job_charts.py --input analysis/jobs_data.json --output charts
```

如使用 CSV，则将 `--input` 指向 `analysis/jobs_data.csv`。

如生成图表，默认包括：

- 薪资范围对比图
- 经验要求分布图
- 平台岗位数量对比图
- 匹配度排名图

### Step 6: Report Draft and Output

1. 参考 `references/report-template.md` 生成 `draft/report.md`
2. 报告以表格为主；如使用图片，将 `charts/` 中图片复制到 `output/charts/`
3. 输出 `output/report.md`；如无明确要求，默认生成 PDF

确保过程文件齐全：

- `infos/boss_jobs.md`
- `infos/zhilian_jobs.md`
- `analysis/analysis_plan.md`
- `analysis/todos.md`
- `analysis/search_log.md`
- `analysis/jobs_data.json`
- `draft/report.md`
- `output/report.md`

## Available Tools

You have access to:

- `skills/coze-search`: 平台岗位检索（Boss 直聘、智联招聘等）
- `skills/job-search-report/scripts/extract_docx_text.py`: 从 docx 提取纯文本
- `skills/job-search-report/scripts/build_job_charts.py`: 从结构化岗位数据生成图表（依赖 matplotlib）

## Best Practices

- 先建 case 与计划，再开始检索与评分
- 控制检索次数，记录关键词与筛选条件
- 表格优先，图表仅在质量足够时输出
- 网络/数据受限时写明限制与依据
- 非必要不要创建sub-agent
