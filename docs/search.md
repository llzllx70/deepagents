# 网络搜索方案汇总

本文档汇总 DeepAgents 项目中涉及网络搜索/信息检索的所有方案。

---

## 1. 核心搜索工具

### 1.1 web_search（Tavily）

- **位置**: `server/sessions.py:1394-1404`
- **提供方**: Tavily API（`tavily-python==0.7.14`）
- **启用条件**: `settings.has_tavily` 为 True 且配置了 `tavily_api_key`
- **参数**: `query`（搜索词）、`max_results`（最大结果数，默认 5）、`topic`、`include_raw_content`
- **HITL 审批**: 调用前需用户确认，提示 "WARNING: This will use Tavily API credits"（`server/agent.py:265-273`）
- **UI 显示**: 工具名映射为 "搜索"（`server/message_utils.py:12`）

### 1.2 fetch_url

- **位置**: `server/sessions.py:1394`（始终加载）
- **功能**: 抓取指定 URL 内容并转换为 Markdown
- **参数**: `url`、`timeout`（默认 30s）
- **HITL 审批**: 调用前需用户确认（`server/agent.py:276-284`）
- **UI 显示**: 映射为 "浏览"

### 1.3 http_request

- **位置**: `server/sessions.py:1394`（始终加载）
- **功能**: 底层 HTTP 请求能力，支持 GET/POST 等方法
- **UI 显示**: 映射为 "浏览"

---

## 2. 浏览器搜索（Playwright / CDP）

- **位置**: `server/browser_tools.py`、`server/browser_bridge.py`、`server/browser_router.py`
- **工具**:
  - `browser_request_snapshot` — 获取用户当前浏览器标签页快照
  - `browser_action` — 执行浏览器操作（click、type、scroll、open、wait）
- **原理**: 通过 Chrome 扩展与 CDP（Chrome DevTools Protocol）连接用户真实浏览器
- **适用场景**: 需要登录态的网站搜索、动态页面交互、表单填写、多步导航

---

## 3. 搜索相关 Skills

### 3.1 deep-research（深度研究）

- **位置**: `skills/deep-research/SKILL.md`
- **流程**: 研究计划 → `task` 工具派生子 Agent → 子 Agent 使用 `web_search` 检索（每子任务 3-5 次）→ 结果写入 findings 文件 → 主 Agent 综合生成报告
- **可用工具**: `web_search`、`fetch_url`、`write_file`、`read_file`、`list_files`、`task`
- **特点**: 支持最多 3 个子 Agent 并行检索，文件驱动的信息传递

### 3.2 xuegong-web-research（学工网站信息检索）

- **位置**: `skills/xuegong-web-research/SKILL.md`
- **目标**: 从高校学工/学生工作官方网站检索政策、通知与文件
- **流程**: 研究计划 → 子 Agent 检索（仅限 `web_search`、`fetch_url`、`write_file`）→ 主 Agent 生成 HTML 报告 → 可选转 PDF
- **约束**: 子 Agent 禁止调用 `html2pdf`；html2pdf 不可用时降级为仅 HTML 输出
- **输出**: `report.html`（必须）+ `report.pdf`（可选）

### 3.3 coze-search（Coze API 搜索）

- **位置**: `skills/coze-search/SKILL.md`、`skills/coze-search/scripts/coze_search.sh`
- **接口**: Coze 工作流 API（`https://api.coze.cn/v1/workflow/stream_run`）
- **配置**: 环境变量 `COZE_TOKEN`、`COZE_FLOW_ID`、`COZE_APP_ID`
- **用法**: `scripts/coze_search.sh "<关键词>"`
- **约束**: 使用此 Skill 时不得同时使用 `web_search` / Tavily
- **特点**: 支持流式 JSON 响应，适用于特定平台（如招聘网站）的定向搜索

### 3.4 arxiv-search（学术论文搜索）

- **位置**: `skills/arxiv-search/SKILL.md`、`skills/arxiv-search/arxiv_search.py`
- **接口**: arXiv API（免费，无需 API Key）
- **参数**: `query`（搜索词）、`--max-papers`（默认 10）
- **排序**: 按相关性排序
- **依赖**: `arxiv` Python 包（按需安装）
- **领域**: 物理、数学、计算机科学、定量生物学、金融、统计

### 3.5 job-search-report（招聘搜索报告）

- **位置**: `skills/job-search-report/SKILL.md`
- **搜索渠道**: 依赖 `coze-search` Skill（非直接使用 `web_search`）
- **目标平台**: Boss 直聘、智联招聘
- **流程**: 简历提取 → 职位搜索 → 匹配分析 → 报告生成
- **辅助脚本**: `extract_docx_text.py`（简历提取）、`build_job_charts.py`（图表生成）

---

## 4. 搜索结果处理机制

### 4.1 结果截断中间件

- **位置**: `server/tool_result_middleware.py`
- **类**: `ToolResultTruncationMiddleware`
- **阈值**: 30,000 字符（约 7,500 tokens）
- **策略**: 头尾保留截断（head_tail），保留首尾内容以维持上下文
- **触发时机**: 每轮模型推理前（`before_model`），对所有 `ToolMessage` 生效
- **作用范围**: `fetch_url`、`http_request`、`web_search`、MCP 工具的返回结果

### 4.2 搜索结果使用规范

- **位置**: `server/agent.py:208-218`（系统提示词）
- **规则**:
  1. 必须阅读并处理搜索结果，自然语言回复用户
  2. 禁止向用户直接展示原始 JSON
  3. 需综合多来源信息
  4. 引用相关来源（页面标题或 URL）
  5. 搜索无果时说明情况并追问

---

## 5. 方案对比

| 方案 | 搜索类型 | 是否需要 API Key | 适用场景 | 结果格式 |
|------|---------|-----------------|---------|---------|
| **web_search (Tavily)** | 通用网络搜索 | 是 | 通用信息检索 | 标题+URL+摘要 |
| **fetch_url** | 定向 URL 抓取 | 否 | 已知页面内容提取 | Markdown |
| **http_request** | HTTP 请求 | 否 | API 调用、数据获取 | 原始响应 |
| **browser 工具** | 浏览器交互 | 否 | 需登录/动态页面 | 页面快照 |
| **coze-search** | Coze 工作流 | 是 | 特定平台定向搜索 | 流式 JSON |
| **arxiv-search** | 学术论文搜索 | 否 | 学术论文检索 | 格式化文本 |
| **deep-research** | 多 Agent 协作研究 | 是(Tavily) | 复杂多源研究 | Markdown 报告 |

---

## 6. 配置要点

```yaml
# Tavily 配置（启用 web_search 的前提）
# 需在环境变量或 config 中设置 tavily_api_key

# Coze 配置
COZE_TOKEN: "your-token"
COZE_FLOW_ID: "your-flow-id"
COZE_APP_ID: "your-app-id"

# 调试
DEEPAGENTS_DEBUG_TOOL_CALLS: "1"  # 开启工具调用详细日志
```

---

## 7. 搜索工具在一次任务中如何协同工作

### 7.1 核心结论：提示词驱动，无运行时编排

**工具列表在会话创建时一次性确定，之后不再变化。** 任务执行过程中没有任何中间件或代码层会动态增删工具。Agent（LLM）根据系统提示词、Skill 指令和当前上下文自行决定调用哪个工具。

```
会话创建（sessions.py:1380-1446）
  │
  ├── 始终加载: http_request, fetch_url, browser_request_snapshot, browser_action
  ├── 条件加载: web_search（仅当 settings.has_tavily = True）
  ├── 动态发现: MCP 工具（如有配置）
  └── 沙箱工具: shell, execute, read_file, write_file ...
  │
  ▼
  工具列表冻结 → 传入 create_cli_agent() → 整个会话期间不变
```

**这意味着**：即使某个 Skill 声明"禁止使用 web_search"，`web_search` 仍然在工具列表中。LLM 能否遵守取决于指令跟随能力，没有代码层面的强制执行。

### 7.2 工具激活条件

各搜索工具的激活取决于两个层次：**是否可用**（代码层）和 **是否应该用**（提示词层）。

#### 代码层：工具是否存在于工具列表

| 工具 | 激活条件 | 判断位置 |
|------|---------|---------|
| `http_request` | 始终可用 | `sessions.py:1394` |
| `fetch_url` | 始终可用 | `sessions.py:1394` |
| `browser_*` | 始终注册，但未连接 Chrome 扩展时调用会失败 | `sessions.py:1420` |
| `web_search` | `settings.has_tavily` 为 True 时加载，否则**不存在于工具列表** | `sessions.py:1400-1401` |
| `coze-search` | 非独立工具，Agent 通过 `shell`/`execute` 调用脚本 | `skills/coze-search/scripts/coze_search.sh` |

> `web_search` 是唯一有**硬性开关**的搜索工具 — 未配置 Tavily API Key 时，工具本身不存在，LLM 无法调用。

#### 提示词层：Skill 如何引导工具选择

Skill 通过 `SKILL.md` 中的自然语言约束引导 LLM 选择工具：

| Skill | 搜索工具偏好 | 约束原文 |
|-------|------------|---------|
| `deep-research` | 主 Agent 用 `fetch_url`；子 Agent 用 `web_search` | "Each subagent will have access to: web_search" |
| `coze-search` | 仅用 `coze-search` 脚本 | "Do not use `web_search` or `tavily` when this skill is requested" |
| `job-search-report` | 仅通过 `coze-search` 搜索 | "不要使用 web_search、http_request、fetch_url" |
| `xuegong-web-research` | 子 Agent 用 `web_search` + `fetch_url` | 可用工具白名单：`web_search`、`fetch_url`、`write_file` |
| 无 Skill（普通对话） | LLM 自行判断 | 仅有 `web_search` 使用规范（`agent.py:208-218`） |

**关键**：这些约束全部是文本形式的"建议"，没有代码强制。子 Agent 实际获得的工具列表与主 Agent 完全相同（通过 `SubAgentMiddleware` 的 `default_tools=tools` 传递）。

### 7.3 一次搜索任务的典型协作流程

以"帮我搜索 XX 的最新资讯并整理报告"为例，展示工具如何在单次任务中协作：

```
用户输入: "帮我搜索 XX 的最新资讯"
  │
  ├─ [1] 浏览器上下文注入（sessions.py:1085-1095）
  │     browser_bridge.is_connected() ?
  │     ├── 已连接 → 自动附加当前页面快照到用户消息中
  │     └── 未连接 → 不附加（Agent 也不知道浏览器状态）
  │
  ├─ [2] LLM 推理：选择工具
  │     系统提示词 + Skill 指令 + 工具描述 → LLM 决定调用哪个工具
  │     （没有任何路由逻辑，完全由 LLM 自主决定）
  │
  ├─ [3] 搜索阶段（通常选择 web_search）
  │     web_search(query="XX 最新资讯")
  │     ├── HITL 审批 → 用户确认 → 执行
  │     └── 返回: [{title, url, content}, ...]
  │
  ├─ [4] 深入抓取（LLM 判断摘要不够，需要全文）
  │     fetch_url(url="https://example.com/article")
  │     ├── HITL 审批 → 用户确认 → 执行
  │     └── 返回: Markdown 格式的完整页面内容
  │
  ├─ [5] 结果截断（ToolResultTruncationMiddleware）
  │     内容 > 30,000 字符时自动截断（head_tail 模式）
  │
  └─ [6] LLM 综合回答
        基于搜索结果 + 抓取内容生成回复
```

**Skill 场景下流程不同**。以 `job-search-report` 为例：

```
用户输入: "帮我搜索 Python 后端岗位"
  │
  ├─ [1] LLM 识别匹配 job-search-report Skill
  │     → 调用 read_file 读取 SKILL.md 获取完整指令
  │
  ├─ [2] Skill 指令要求: 仅使用 coze-search，禁止 web_search/fetch_url/http_request
  │     （但这些工具仍在工具列表中，LLM 自觉遵守）
  │
  ├─ [3] 搜索阶段
  │     shell(command="scripts/coze_search.sh 'Python 后端'")
  │     ├── HITL 审批（shell 工具通用审批）
  │     └── 返回: Coze API 流式 JSON 响应
  │
  └─ [4] 后续处理（简历匹配、报告生成等）
```

### 7.4 子 Agent 场景的工具继承

当主 Agent 通过 `task` 工具派生子 Agent 时：

```
主 Agent
  │  tools = [http_request, fetch_url, web_search, browser_*, shell, ...]
  │
  ├── task(description="搜索 XX 相关论文")
  │     └── 子 Agent 继承完全相同的 tools 列表
  │         （SubAgentMiddleware 传递 default_tools=tools）
  │
  └── Skill 指令可能声明子 Agent "只能用 web_search + write_file"
      但实际上子 Agent 拥有所有工具，约束靠 LLM 自觉
```

### 7.5 浏览器工具的特殊性

浏览器工具与其他搜索工具的协作存在断层：

- **始终注册**：无论用户是否连接了 Chrome 扩展，`browser_request_snapshot` 和 `browser_action` 都在工具列表中
- **上下文有条件注入**：只有 `browser_bridge.is_connected()` 为 True 时，快照才会注入到用户消息中（`sessions.py:1085`）
- **未连接时无提示**：如果浏览器未连接，Agent 看不到任何关于浏览器状态的信息，也没有提示词建议它改用 `fetch_url`。Agent 可能尝试调用浏览器工具，得到错误后才知道不可用

### 7.6 HITL 审批对协作流程的影响

审批机制直接影响工具调用的流畅度（`server/agent.py:362-370`）：

| 工具 | 是否需要审批 | 对协作的影响 |
|------|------------|------------|
| `web_search` | 是 | 每次搜索需用户确认，搜索→抓取链路中第一步被拦截 |
| `fetch_url` | 是 | 搜索→抓取链路中第二步也被拦截，一次完整搜索至少需 2 次审批 |
| `http_request` | **否** | 可无审批发送任意 HTTP 请求 |
| `browser_*` | 否 | 浏览器操作无需审批 |
| `coze-search`（via shell） | 是（shell 通用审批） | 每次 Coze 搜索需确认 |

> 一次典型的"搜索+抓取"任务（`web_search` → `fetch_url`）至少需要用户**点击 2 次确认**。开启 `auto_approve` 可跳过。

---

## 8. 现存问题

### P1: HITL 审批不一致 — 安全等级倒挂

- **问题**: `fetch_url` 需要用户审批才能执行，但 `http_request`（支持 GET/POST/PUT/DELETE 等任意 HTTP 方法）却无需审批
- **涉及文件**: `server/agent.py:362-370`（`interrupt_on` 配置），`http_request` 未列入
- **影响**: Agent 可在无用户确认的情况下向任意 URL 发送 POST 请求，而仅读取网页内容的 `fetch_url` 反而需要审批。攻击面更大的工具审批要求更低，构成安全等级倒挂

### P2: 系统提示词缺少工具选择指导

- **问题**: 系统提示词中仅有 `web_search` 的使用说明（`server/agent.py:208-218`），未提供 `fetch_url`、`http_request`、`browser tools` 之间的选择策略
- **涉及文件**: `server/agent.py:208-218`
- **影响**: Agent 缺乏明确指导，可能在不恰当场景选择工具（如用 `http_request` 替代 `fetch_url` 抓取网页，丢失 Markdown 转换能力；或在浏览器已连接时仍用 `fetch_url` 而非 `browser_request_snapshot`）

### P3: fetch_url 与 http_request UI 显示名相同

- **问题**: 两个功能不同的工具在前端均显示为 "浏览"
- **涉及文件**: `server/message_utils.py:13-14`（`"fetch_url": "浏览"`, `"http_request": "浏览"`）
- **影响**: 用户在 HITL 审批或工具调用日志中无法区分 Agent 正在执行的是 URL 抓取还是原始 HTTP 请求，降低了操作透明度

### P4: coze-search 脚本缺少错误处理

- **问题**: `coze_search.sh` 中的 `curl` 调用无超时设置、无重试机制、无结构化错误输出
- **涉及文件**: `skills/coze-search/scripts/coze_search.sh:36-39`
- **影响**: 网络异常时脚本可能无限挂起；API 返回错误时（如 token 过期、限流），Agent 收到的是原始错误响应而非结构化的错误信息，难以做出合理的降级决策

### P5: 浏览器工具无连接感知策略

- **问题**: `browser_request_snapshot` 和 `browser_action` 始终注册到工具列表（`server/sessions.py:1420`），但实际工作依赖 Chrome 扩展的 WebSocket 连接。未连接时调用会超时失败
- **涉及文件**: `server/sessions.py:1415-1420`，`server/browser_bridge.py`
- **影响**: Agent 不知道浏览器是否可用，可能尝试调用不可用的浏览器工具，浪费推理轮次并产生无意义的超时等待。虽然快照注入（`sessions.py:1085`）会检查 `is_connected()`，但工具注册本身不会根据连接状态动态调整

### P6: 结果截断策略一刀切

- **问题**: `ToolResultTruncationMiddleware` 对所有 `ToolMessage` 使用同一截断策略（30k 字符，head_tail 模式），不区分工具类型和结果格式
- **涉及文件**: `server/tool_result_middleware.py:22-27`
- **影响**: 不同工具返回不同格式的结果：`web_search` 返回结构化 JSON（截断可能破坏 JSON 结构）、`fetch_url` 返回 Markdown（中间截断可能丢失关键段落）、`http_request` 返回原始响应（可能是二进制数据）。统一的 head_tail 截断对某些格式并非最优策略

### P7: 无统一搜索策略层

- **问题**: 各 Skill 以自然语言在各自的 `SKILL.md` 中定义排他规则（如 `coze-search` 禁用 `web_search`，`job-search-report` 仅用 `coze-search`），Agent 需从分散的指令中推断工具选择
- **涉及文件**: `skills/coze-search/SKILL.md`，`skills/job-search-report/SKILL.md`，`server/skills_middleware.py`
- **影响**: 规则分散且无强制执行，LLM 可能忽略约束导致不期望的工具调用。不同 Skill 间的规则可能冲突（如同时激活 `deep-research` 和 `coze-search`），无统一协调机制

---

## 9. 改进建议

### 阶段一：立即修复（低风险，高收益）

#### 1A: 为 http_request 添加 HITL 审批

- **涉及文件**: `server/agent.py`
- **实现思路**: 在 `_build_interrupt_on_config()` 函数的返回字典中（`agent.py:362-370`）增加 `"http_request"` 条目，添加对应的 `_format_http_request_description` 格式化函数，展示请求方法、URL 和请求体摘要
- **优先级**: 高 — 修复安全等级倒挂问题（P1）

#### 1B: 区分 fetch_url 与 http_request 的 UI 显示名

- **涉及文件**: `server/message_utils.py:13-14`
- **实现思路**: 将 `http_request` 的显示名从 `"浏览"` 改为 `"HTTP 请求"`，保留 `fetch_url` 为 `"浏览"`
- **优先级**: 高 — 修复用户无法区分操作的问题（P3）

#### 1C: 系统提示词增加工具选择指导

- **涉及文件**: `server/agent.py`（系统提示词区域，`agent.py:208` 附近）
- **实现思路**: 在 `### Web Search Tool Usage` 之后追加工具选择指南，说明：
  - `fetch_url`：用于已知 URL 的内容提取（自动转 Markdown）
  - `http_request`：用于 API 调用或需要指定 HTTP 方法/请求头/请求体的场景
  - `browser_request_snapshot` / `browser_action`：用于需要登录态或动态交互的网页
  - 优先级建议：已知 URL → `fetch_url`；需登录 → `browser tools`；需搜索 → `web_search`；API 调用 → `http_request`
- **优先级**: 中 — 减少不恰当的工具选择（P2）

### 阶段二：短期改进

#### 2A: coze_search.sh 增加超时和错误处理

- **涉及文件**: `skills/coze-search/scripts/coze_search.sh:36-39`
- **实现思路**:
  - 为 `curl` 添加 `--connect-timeout 10 --max-time 60` 参数
  - 捕获 `curl` 退出码，非零时输出结构化错误 JSON：`{"error": "...", "exit_code": N}`
  - 检查 HTTP 状态码，非 2xx 时输出错误信息
- **优先级**: 中 — 修复潜在的无限挂起风险（P4）

#### 2B: 浏览器工具增加连接状态感知

- **涉及文件**: `server/sessions.py`（工具注册区域），`server/agent.py`（系统提示词）
- **实现思路**:
  - 方案 A（轻量）：在系统提示词中动态标注浏览器连接状态。已有快照注入逻辑（`sessions.py:1085-1095`）可扩展：未连接时在提示词中注明 "浏览器未连接，请使用 `fetch_url` 替代"
  - 方案 B（彻底）：未连接时不注册浏览器工具，连接后通过 `aupdate_state` 动态添加（需评估 LangGraph 是否支持运行时工具变更）
- **优先级**: 中 — 减少无效工具调用（P5）

#### 2C: 结果截断支持按工具名配置

- **涉及文件**: `server/tool_result_middleware.py`
- **实现思路**:
  - `ToolResultTruncationMiddleware.__init__` 接受 `per_tool_config: dict[str, TruncationConfig]` 参数
  - `TruncationConfig` 包含 `max_chars` 和 `mode`（`head_tail`、`head_only`、`json_safe` 等）
  - 默认保持现有行为（30k，head_tail），允许为 `web_search` 配置 `json_safe` 模式（确保截断不破坏 JSON 结构）
- **优先级**: 低 — 优化结果质量（P6）

### 阶段三：长期架构

#### 3A: 新建 SearchAdvisorMiddleware

- **涉及文件**: 新建 `server/search_advisor_middleware.py`，修改 `server/agent.py` 注册中间件
- **实现思路**:
  - 实现 `before_model` 钩子，在每轮推理前注入搜索上下文
  - 上下文内容：当前可用搜索工具列表、浏览器连接状态、当前 Skill 的搜索偏好（如 `coze-search` 排他要求）
  - 将分散在各 `SKILL.md` 中的搜索约束统一收拢到中间件层，减少 LLM 的推断负担
- **解决问题**: P2、P5、P7

#### 3B: coze-search 从 shell 脚本迁移为 Python 工具

- **涉及文件**: 新建 `skills/coze-search/scripts/coze_search.py`，修改 `skills/coze-search/SKILL.md`
- **实现思路**:
  - 用 Python `httpx` 替代 `curl`，内置超时、重试、错误处理
  - 解析流式 JSON 响应，输出结构化结果
  - 可选：注册为原生 Python 工具而非 Skill 脚本，获得更好的类型安全和错误传播
- **解决问题**: P4

#### 3C: 搜索结果格式归一化层

- **涉及文件**: 新建 `server/search_result_normalizer.py`，修改 `server/tool_result_middleware.py`
- **实现思路**:
  - 在截断之前增加归一化步骤：将不同工具的结果转换为统一的中间格式
  - 统一格式包含：`source`（工具名）、`format`（json/markdown/text/binary）、`content`、`metadata`（URL、状态码等）
  - 截断策略根据 `format` 字段选择最优模式
- **解决问题**: P6
