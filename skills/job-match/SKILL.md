---
name: job-match
description: 基于学生成绩数据、职业技能树与专业知识图谱生成职业匹配诊断与建议报告。用于学生能力体检、目标岗位匹配度评估、差距分析与选课/提升建议输出
---

# 职业匹配智能体 Skill

基于学生成绩、岗位技能树与专业知识图谱进行多维度能力对标，输出职业匹配诊断报告与提升建议。

## Inputs and Sources

- 学生成绩来源：`职业匹配/中等生-大三.docx` 或 `references/student-grades.md`
- 岗位技能树来源：`职业匹配/前端工程师技能树（带课程）.docx` 或 `references/frontend-skill-tree.md`
- 专业知识图谱来源：`职业匹配/计算机专业知识图谱.docx` 或 `references/cs-knowledge-graph.md`

如用户指定其他岗位，要求提供对应岗位技能树文档，再替换技能树映射。

## Workflow

### Step 1: Create Case Folder

在 `workspace/job_match/` 下创建 case：
`workspace/job_match/case_[姓名]_[目标岗位]/`

推荐结构：

```
case_xxx/
├── input/
├── analysis/
├── draft/
└── output/
```

### Step 2: Parse Inputs

1. 解析成绩数据，输出 `input/student_grades.csv`，字段至少包含 `course`, `score`.
2. 解析技能树与知识图谱，输出：
   - `input/role_skill_tree.md`（岗位技能树）
   - `input/major_knowledge_graph.md`（专业知识图谱）
3. 构建课程映射：
   - `input/skill_course_map.md`：技能节点 -> 关联课程
   - `input/competency_course_map.md`：毕业要求/指标点 -> 支撑课程

成绩转换规则：若分数为“优/良/中/及格”，分别换算为 90/80/70/60。

如需快速抽取 docx 文本，可使用以下 Python 片段（仅示意，按需调整输出路径）：

```python
import zipfile
import re
from pathlib import Path

def extract_docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    xml = xml.replace("</w:p>", "\n").replace("</w:br>", "\n")
    text = re.sub(r"<[^>]+>", "", xml)
    return re.sub(r"\n{2,}", "\n", text).strip()
```

### Step 3: Build Scoring Dataset

1. 建立 `analysis/course_scores.csv`，字段建议：
   - `course`, `score`, `skill_domain`, `skill_node`, `competency`, `weight`
2. 权重规则：
   - 核心技能对应课程：1.2
   - 通用基础课：1.0
   - 相关度低的选修课：0.8
3. 维度聚合：
   - 硬技能（Hard Skills）：聚合“基本技能与能力”+“基本知识”
   - 软技能（Soft Skills）：聚合“职业素养”+“沟通协作”+“业务效能”（如含“持续进化”，并入软技能）
4. 总匹配度：
   - `Total = Hard * 0.6 + Soft * 0.4`

### Step 4: Gap Analysis

输出 `analysis/gap_matrix.md`，按以下阈值标注：

- 85+：优势领域（S 级匹配）
- 70-84：达标领域（A 级匹配）
- 60-69：风险领域（B 级风险）
- <60：关键缺失（C 级缺失）

### Step 5: Report Draft and Output

生成 `draft/report.md`，最终输出 `output/report.md`。报告至少包含：

1. 核心诊断摘要（目标岗位、总匹配度、一句话结论）
2. 能力维度评分表（硬技能/软技能/子维度）
3. 能力雷达图（Mermaid）
4. 差距分析与风险提醒
5. 课程重修/加强建议（按优先级）
6. 3-6 个月提升路径（学习/实践/项目）

Mermaid 雷达图示例：

```
radar
  title 能力维度分布
  axes: 编程语言, 数据库, 系统架构, 工程素养, 沟通协作
  data: [80, 75, 60, 85, 70]
```

### Step 6: Quality Checks

- 核对课程名称是否与技能树/图谱一致，必要时建立同义映射表
- 明确数据缺失与假设，避免“无数据推断”

## References

- 学生成绩：`references/student-grades.md`
- 计算机专业知识图谱：`references/cs-knowledge-graph.md`
- 前端工程师技能树：`references/frontend-skill-tree.md`
