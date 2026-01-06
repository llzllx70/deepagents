---
name: job-search-report
description: 个人就业岗位检索与图文报告生成技能。用于从简历出发，使用coze search在Boss直聘与智联招聘等平台检索岗位、整理过程文件、计算匹配度并输出含图表的求职分析报告。
---
# 个人就业岗位检索与报告 Skill

基于本地简历生成岗位检索过程文件、匹配度分析与图文报告。

## 输出目标

- 完整岗位检索过程文件（平台岗位清单、检索日志、结构化岗位数据）
- 匹配度排序与推荐清单
- 含表格的求职分析报告（默认不使用图表，除非能生成高质量效果图）

## 工作目录规范

统一在 `workspace/job_search/` 下建 case：

```
workspace/job_search/case_[姓名]_[目标职位]_[城市]/
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

## 核心流程（主代理 → 子代理 → 主代理）

### Step 1: 初始化 case 与计划（主代理）

1. 创建 case 目录与子目录
2. 写入 `analysis/analysis_plan.md`：
   - 目标岗位类型与城市
   - 拆分的子任务（2–4 个）
   - 需要的数据与产出
3. 写入 `analysis/todos.md`：执行顺序与负责人
4. 建立结构化输入：
   - `input/resume.docx`（默认来源：`个人就业/学生简历.docx`）
   - `input/resume_text.txt`
   - `input/candidate_profile.md`

### Step 2: 简历抽取与画像（主代理）

使用脚本提取简历文本：

```
python skills/job-search-report/scripts/extract_docx_text.py --input 个人就业/学生简历.docx --output input/resume_text.txt
```

然后基于 `input/resume_text.txt` 生成 `input/candidate_profile.md`，至少包含：

- 核心技能与项目关键词
- 目标岗位/城市/薪资偏好（缺失则标注“待确认”）
- 教育背景与实习/项目经历摘要

### Step 3: 平台检索与过程文件（子代理）

为每个平台创建子代理（Boss直聘、智联招聘）。每个子代理只做本平台检索与整理：

- 桧索必须使用 `coze-search` skill，你需要仔细阅读此skill，并遵照说明进行
- 输出文件：`infos/boss_jobs.md`、`infos/zhilian_jobs.md`
- 每条岗位至少包含：公司、岗位名、薪资、经验、学历、地点、链接、技能要求、信息来源
- 记录检索关键词、筛选条件、信息来源到 `analysis/search_log.md`

子代理模板：

```
任务：在[平台]检索与候选人匹配的岗位。
要求：最多 3-5 次 Coze search（使用 coze-search skill），整理岗位清单到 infos/[platform]_jobs.md。
输出：岗位列表、职位链接、薪资/经验/学历/地点/技能要求/信息来源。
禁止：再创建子代理。
```

如网络受限，优先请求授权或使用离线数据，再在报告中注明限制。

### Step 4: 结构化岗位数据与匹配度评分（主代理）

1. 将岗位信息整理为 `analysis/jobs_data.json` 或 `analysis/jobs_data.csv`
2. 字段规范见 `references/job-data-schema.md`
3. 评分规则见 `references/scoring-rubric.md`

### Step 5: 表格与图表生成（可选，默认不生成图表）

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

### Step 6: 报告撰写与输出（主代理）

1. 参考 `references/report-template.md` 生成 `draft/report.md`
2. 报告以表格为主；如使用图片，将 `charts/` 中图片复制到 `output/charts/`
3. 如果没有明确要求，默认生成pdf

## 过程文件要求（对齐示例目录）

请输出与 `个人就业/岗位检索分析过程文件` 类似的过程文件：

- `infos/boss_jobs.md`
- `infos/zhilian_jobs.md`
- `analysis/analysis_plan.md`
- `analysis/todos.md`
- `analysis/search_log.md`
- `analysis/jobs_data.json`
- `draft/report.md`
- `output/report.md`

## 可用脚本

- `skills/job-search-report/scripts/extract_docx_text.py`：从 docx 提取纯文本
- `skills/job-search-report/scripts/build_job_charts.py`：从结构化岗位数据生成图表（依赖 matplotlib）

## 子代理规则（必须遵守）

- 只接受主代理分配的单一子任务
- 禁止创建或指挥其他子代理
- 默认不访问互联网；除非主代理明确要求且环境允许
- 输出必须写入指定文件，不直接返回长文本
