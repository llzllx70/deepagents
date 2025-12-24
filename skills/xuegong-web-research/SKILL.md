---
name: xuegong-web-research
description: 从高校学工/学生工作官方网站检索政策、通知与文件，生成结构化 HTML 报告，并在主 Agent 阶段可选转换为 PDF（依赖 html2pdf 技能）
---

学工网站信息检索与整理 Skill（Xuegong Web Research）

重要说明（必须遵守）
1. 本 Skill 依赖外部技能 html2pdf
2. html2pdf 只能在主 Agent 的最终交付阶段调用
3. 使用 task 创建的子 Agent 严禁调用 html2pdf
4. 若 html2pdf 不可用，流程必须降级，仅输出 HTML，不得报错中断

Skill 目标
本 Skill 用于从高校以下官方栏目检索信息并整理交付：
- 学工处
- 学生工作部
- 学生事务中心
- 党委学工部
- 学生处

支持典型场景：
- 奖学金 / 助学金 / 国家资助
- 评奖评优
- 勤工助学
- 心理健康
- 宿舍管理 / 学风建设
- 征兵入伍
- 学生处分管理办法
- 表格 / 附件下载

最终交付物：
- report.html（必须）
- report.pdf（可选，依赖 html2pdf）

工作目录规范（强制）
所有文件必须写入当前项目可写目录：
./workspace/xuegong/

单次研究任务目录：
./workspace/xuegong/research_xuegong_[topic_name]/

禁止写入任何绝对路径（例如 /research_xxx）。

研究与输出流程

Step 1：创建研究计划（主 Agent 执行）
主 Agent 必须：
1. 创建任务目录
mkdir -p ./workspace/xuegong/research_xuegong_[topic_name]

2. 使用 write_file 写入：
./workspace/xuegong/research_xuegong_[topic_name]/research_plan.md

研究计划必须包含：
- 用户原始问题
- 标准化研究目标
- 子任务拆解（2–5 个）
- 最终 HTML 报告结构大纲

Step 2：信息检索（task 子 Agent 执行）
对每个子任务，主 Agent 使用 task 创建子 Agent。

子 Agent 严格约束（必须全部满足）：
- 仅允许使用：web_search、fetch_url、write_file
- 禁止调用 html2pdf
- 禁止生成 HTML 或 PDF

子 Agent 输出要求：
仅写入 findings 文件：
./workspace/xuegong/research_xuegong_[topic_name]/findings_[subtopic].md

必须记录：
- 标题
- 发布日期
- 发布部门
- 关键政策要点
- 原文链接
- 附件下载链接（如有）
- 是否需要登录或校内网

Step 3：综合整理与交付（仅主 Agent 执行）
主 Agent 必须：
1. 使用 read_file 读取全部 findings_*.md
2. 生成结构化 HTML 报告：
./workspace/xuegong/research_xuegong_[topic_name]/report.html

3. 检查 html2pdf 技能是否可用：
- 若可用：调用 html2pdf 生成 report.pdf
- 若不可用：仅输出 report.html，并在文末注明“PDF 未生成：当前运行环境未注入 html2pdf 技能”

html2pdf 不可用不得导致流程失败。

输出规范

信息总结型输出必须包含：
- 结论摘要
- 政策或通知列表（按时间倒序）
- 条件、材料、流程、时间节点
- 来源链接
- report.html（必须）
- report.pdf（可选）

文件定位或下载型输出必须包含：
- 文件准确名称
- 发布日期与发布部门
- 原文入口页链接
- 附件下载链接
- 访问限制说明
- report.html（必须）
- report.pdf（可选）

最佳实践
1. 子 Agent 只做检索与落盘
2. 主 Agent 只做汇总与交付
3. HTML 是第一交付物，PDF 是增强交付
4. 工具不可用必须降级，而不是失败
5. 永远不要假设子 Agent 拥有全部技能
