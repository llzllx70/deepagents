# DeepAgents CodeTour 总览

本目录包含 **12 个 CodeTour**，覆盖 DeepAgents 的三大子系统：浏览器扩展（Extension）、后端服务（Server）、前端客户端（Web）。

## 如何使用

1. 安装 VS Code 插件 [CodeTour](https://marketplace.visualstudio.com/items?itemName=vsls-contrib.codetour)
2. 打开命令面板 `Cmd+Shift+P` → **CodeTour: Start Tour** → 选择任意 Tour
3. 或在左侧 Explorer 的 **CODETOURS** 区域点击播放按钮 ▷

---

## 系统架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器（用户端）                        │
│                                                         │
│  ┌─────────────────────┐    ┌────────────────────────┐  │
│  │  Extension (MV3)    │    │    Web Client (SPA)    │  │
│  │  background.js      │    │    app.js              │  │
│  │  content.js         │    │    app/network.js      │  │
│  │  lib/connection.js  │    │    app/messages.js     │  │
│  │  lib/snapshot.js    │    │    app/ui.js           │  │
│  │  lib/actions.js     │    │    app/auth.js         │  │
│  │  lib/cdp.js         │    │    app/history.js      │  │
│  └──────────┬──────────┘    └───────────┬────────────┘  │
│             │ WS /ws/browser            │ WS /ws/{id}   │
└─────────────┼───────────────────────────┼───────────────┘
              │                           │
┌─────────────▼───────────────────────────▼───────────────┐
│                  Server (FastAPI + LangGraph)            │
│                                                         │
│  app.py  ──►  sessions.py  ──►  agent.py               │
│                   │                                     │
│                   ▼                                     │
│            DockerSandboxPool  ──►  Container            │
│            (docker_pool.py)        /workspace           │
└─────────────────────────────────────────────────────────┘
```

---

## Tour 列表

### 🔌 Extension — 浏览器扩展

> 文件位置：`extension/`

| # | Tour 文件 | 标题 | 步骤数 |
|---|-----------|------|--------|
| 1 | `ext-1-连接建立.tour` | Extension 连接建立流程 | 10 |
| 2 | `ext-2-bridge自动配置.tour` | Extension Bridge 自动配置流程 | 6 |
| 3 | `ext-3-页面快照.tour` | Extension 页面快照流程 | 8 |
| 4 | `ext-4-浏览器操作.tour` | Extension 浏览器操作流程 | 10 |

---

#### ext-1 · Extension 连接建立流程

**调用链**：`onInstalled/onStartup` → `restoreAndConnect` → `connectWs` → `onopen` → `sendHello` + `startHeartbeat`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `extension/background.js:237` | [入口] onInstalled — 安装/更新后触发 restoreAndConnect |
| 2 | `extension/background.js:241` | [入口] onStartup — 浏览器冷启动时触发 |
| 3 | `extension/lib/connection.js:217` | restoreAndConnect() — 读取 storage，恢复 serverUrl/token |
| 4 | `extension/lib/connection.js:127` | connectWs() — 构建 URL，new WebSocket，注册四个回调 |
| 5 | `extension/lib/connection.js:146` | onopen — 握手成功，startHeartbeat + sendHello |
| 6 | `extension/lib/connection.js:268` | startHeartbeat() — 每 20s 发 ping，保持连接 |
| 7 | `extension/lib/connection.js:237` | sendHello() — 发送 browser.hello 握手消息 |
| 8 | `extension/lib/connection.js:167` | onmessage — 接收 Server 指令，路由到 handleServerMessage |
| 9 | `extension/lib/connection.js:154` | onclose — 断线，标记状态，调度重连 |
| 10 | `extension/lib/connection.js:197` | scheduleReconnect() — 指数退避：200ms→400ms→1s→2s→5s→10s→30s |

---

#### ext-2 · Extension Bridge 自动配置流程

**调用链**：`content.js init` → `observeBridgeConfig` → `readBridgeConfig` → `sendBridgeConfig` → `background` → `connectWs(force)`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `extension/content.js:615` | 主 frame 初始化 Bridge 监听 |
| 2 | `extension/content.js:601` | observeBridgeConfig() — MutationObserver 监听 meta 标签变化 |
| 3 | `extension/content.js:547` | readBridgeConfig() — 从 meta[name=deepagents-bridge] 读取配置 |
| 4 | `extension/content.js:579` | sendBridgeConfig() — 发送给 background |
| 5 | `extension/background.js:168` | 处理 bridge_config，保存配置并触发连接 |
| 6 | `extension/lib/connection.js:127` | connectWs(force) — 强制重连到新 serverUrl |

---

#### ext-3 · Extension 页面快照流程

**调用链**：`Server 请求` → `background handleServerMessage` → `requestSnapshotFromTab` → `content.js collectSnapshot` → `聚合` → `finalizeSnapshot`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `extension/lib/connection.js:167` | [入口] onmessage — 收到 Server browser.request_snapshot |
| 2 | `extension/background.js:75` | handleServerMessage(data) |
| 3 | `extension/background.js:81` | 路由到快照模块 |
| 4 | `extension/lib/snapshot.js:78` | requestSnapshotFromTab() — 向所有 frame 广播采集指令 |
| 5 | `extension/content.js:474` | [content.js] 收到 collect_snapshot |
| 6 | `extension/content.js:434` | collectSnapshot(mode) — 采集 DOM/截图数据 |
| 7 | `extension/background.js:142` | [background] 聚合各 frame 快照数据 |
| 8 | `extension/lib/snapshot.js:185` | finalizeSnapshot() — 汇总后回传 Server |

---

#### ext-4 · Extension 浏览器操作流程

**调用链**：`Server browser.action` → `handleAction` → `ensureDebugger(CDP)` → `resolveTargetRect` → `执行动作` → `可选快照回传`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `extension/background.js:88` | [入口] 路由到操作模块 |
| 2 | `extension/lib/actions.js:92` | handleAction(payload) — 操作入口路由（click/type/scroll/…）|
| 3 | `extension/lib/cdp.js:151` | ensureDebugger(tabId) — 确保 CDP 已 attach |
| 4 | `extension/lib/cdp.js:66` | attachDebugger(tabId) — chrome.debugger.attach |
| 5 | `extension/lib/cdp.js:122` | sendCDP(tabId, method, params) — 发送 CDP 协议命令 |
| 6 | `extension/lib/actions.js:405` | resolveTargetRect() — 4 级元素定位策略 |
| 7 | `extension/lib/actions.js:198` | performClick(tabId, target) — 模拟点击 |
| 8 | `extension/lib/actions.js:267` | performType(tabId, target, text) — 模拟键盘输入 |
| 9 | `extension/lib/snapshot.js:146` | [可选] getSnapshotOnce() — 操作后附带快照 |
| 10 | `extension/lib/cdp.js:89` | [可选] detachDebugger() — 释放 CDP 连接 |

---

### 🖥️ Server — 后端服务

> 文件位置：`server/`

| # | Tour 文件 | 标题 | 步骤数 |
|---|-----------|------|--------|
| 5 | `server-1-服务启动.tour` | Server 服务启动流程 | 6 |
| 6 | `server-2-会话创建.tour` | Server 会话创建流程 | 9 |
| 7 | `server-3-WebSocket消息循环.tour` | Server WebSocket 消息循环 | 7 |
| 8 | `server-4-Run执行流.tour` | Server Run 执行流 | 10 |

---

#### server-1 · Server 服务启动流程

**调用链**：`run()` → `uvicorn` → `lifespan` → `DockerSandboxPool` → `SessionManager`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `server/deepagents_server.py:16` | [入口] run() — uvicorn.run(app, port=8000) |
| 2 | `server/app.py:127` | lifespan — FastAPI 生命周期 async context manager |
| 3 | `server/app.py:130` | DockerPoolConfig.from_env() — 读取环境变量配置 |
| 4 | `server/app.py:136` | DockerSandboxPool 创建 & 预热容器池 |
| 5 | `server/app.py:138` | SessionManager 初始化，持有全局会话字典 |
| 6 | `server/app.py:150` | FastAPI 路由挂载：/files 静态文件、REST、WebSocket |

---

#### server-2 · Server 会话创建流程

**调用链**：`POST /sessions` → `create_session` → `Docker 容器` → `create_cli_agent` → `中间件栈` → `Session.start()`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `server/app.py:258` | [入口] POST /sessions — 验证 token，调用 manager.create_session |
| 2 | `server/sessions.py:1441` | SessionManager.create_session() — 会话工厂主流程 |
| 3 | `server/sessions.py:1492` | pool.acquire_for_session() — 从 Docker 池分配容器 |
| 4 | `server/sessions.py:1510` | create_cli_agent() 调用 |
| 5 | `server/agent.py:373` | create_cli_agent() — Agent 工厂函数 |
| 6 | `server/agent.py:443` | 中间件栈装配：Memory → Skills → Shell → Truncation → ToolArgs |
| 7 | `server/agent.py:540` | create_deep_agent() — 生成 LangGraph Pregel 图 |
| 8 | `server/sessions.py:1527` | Session 对象组装（agent、backend、sandbox、browser_bridge）|
| 9 | `server/sessions.py:599` | session.start() — 启动后台 _run_worker 协程 |

---

#### server-3 · Server WebSocket 消息循环

**调用链**：`/ws/{session_id}` → `认证` → `connections` → `receive_text` → `handle_client_message` → `enqueue_run` → `_run_worker`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `server/app.py:526` | [入口] @websocket /ws/{session_id} — token 校验，session 归属验证 |
| 2 | `server/app.py:550` | websocket.accept()，session.connections.add，activate_session |
| 3 | `server/app.py:556` | while True receive_text 消息接收循环 |
| 4 | `server/app.py:573` | handle_client_message() — 按 msg_type 路由 |
| 5 | `server/app.py:575` | msg_type == "run" — 构建 RunRequest |
| 6 | `server/sessions.py:633` | enqueue_run() — 入队 + 广播 run.queued |
| 7 | `server/sessions.py:603` | _run_worker() — 串行消费队列，await run_task |

---

#### server-4 · Server Run 执行流

**调用链**：`_execute_run` → `prompt 构建` → `agent.astream` → `消息路由` → `HITL 中断/恢复` → `run 完成`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `server/sessions.py:1120` | [入口] _execute_run() — 初始化 RunExecution，广播 run.started |
| 2 | `server/sessions.py:1135` | Prompt 构建：inject_file_context + 附件上下文 + 浏览器快照 |
| 3 | `server/sessions.py:1168` | stream_input 初始化（首轮 HumanMessage / 后续 Command(resume)）|
| 4 | `server/sessions.py:1216` | agent.astream() — LangGraph 流式执行，双模式：messages + updates |
| 5 | `server/sessions.py:1276` | _handle_ai_message() — 广播 assistant.delta / assistant.message |
| 6 | `server/sessions.py:1280` | _handle_tool_message() — 广播 tool.call.ended / file.op |
| 7 | `server/sessions.py:1235` | __interrupt__ 信号捕获 → pending_interrupts |
| 8 | `server/sessions.py:1287` | _process_interrupts() — auto_approve 或等待用户审批 Future |
| 9 | `server/sessions.py:1292` | Command(resume=hitl_response) — 恢复 LangGraph 执行 |
| 10 | `server/sessions.py:1299` | run.completed — 广播完成，current_run = None |

---

### 🌐 Web — 前端客户端

> 文件位置：`web/`

| # | Tour 文件 | 标题 | 步骤数 |
|---|-----------|------|--------|
| 9 | `web-1-应用初始化.tour` | Web 应用初始化流程 | 7 |
| 10 | `web-2-登录与会话建立.tour` | Web 登录与会话建立流程 | 8 |
| 11 | `web-3-发送消息流程.tour` | Web 发送消息流程 | 9 |
| 12 | `web-4-流式渲染与工具卡片.tour` | Web 流式渲染与工具卡片 | 8 |

---

#### web-1 · Web 应用初始化流程

**调用链**：`DOMContentLoaded` → `new DeepAgentsClient` → 模块装配 → `ui.init` → `tryRestoreAuth` → `loadHistory`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `web/app.js:75` | [入口] DOMContentLoaded — new DeepAgentsClient() |
| 2 | `web/app.js:10` | 构造器 — 初始化所有运行状态字段 |
| 3 | `web/app.js:55` | 六模块装配：Utils / Auth / History / Network / Ui / Message |
| 4 | `web/app.js:69` | ui.init() — cacheElements + setupEventListeners + tryRestoreAuth |
| 5 | `web/app/ui.js:41` | tryRestoreAuth() — localStorage token 24h 有效期恢复 |
| 6 | `web/app/ui.js:97` | cacheElements() — 所有 DOM id 映射到 app.elements |
| 7 | `web/app/ui.js:165` | setupEventListeners() — 绑定发送/登录/历史/附件等所有交互 |

---

#### web-2 · Web 登录与会话建立流程

**调用链**：`handleLogin` → `afterLogin` → `ensureSession` → `POST /sessions` → `connectWebSocket` → `onopen`

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `web/app/auth.js:114` | [入口] handleLogin() — POST /login，保存 token 到内存+localStorage |
| 2 | `web/app/auth.js:141` | applyLoggedInState() — 解锁输入框/按钮，隐藏登录表单 |
| 3 | `web/app/auth.js:172` | afterLogin() — loadUserConfig + loadHistory + renderHistory |
| 4 | `web/app/network.js:81` | ensureSession() — 防并发惰性创建会话 |
| 5 | `web/app/network.js:48` | createSession() — POST /sessions，setSessionId，connectWebSocket |
| 6 | `web/app/network.js:246` | connectWebSocket() — new WebSocket，注册四个回调 |
| 7 | `web/app/network.js:256` | onopen — 同步 auto_approve，flush 积压消息 |
| 8 | `web/app/network.js:293` | onclose — 1008 清空会话 / 其他触发指数退避重连 |

---

#### web-3 · Web 发送消息流程

**调用链**：`sendMessage` → 用户气泡 → runId 初始化 → AI 占位 → `network.send` → `handleMessage` 路由 → run 生命周期

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `web/app/messages.js:586` | [入口] sendMessage() — 前置检查，确保会话存在 |
| 2 | `web/app/messages.js:603` | 用户气泡渲染 + 附件 |
| 3 | `web/app/messages.js:623` | generateRunId()，初始化 runState / runIdToChatId |
| 4 | `web/app/messages.js:632` | AI 占位气泡 + showThinkingIndicator |
| 5 | `web/app/messages.js:645` | network.send({type:'run'})，离线时缓入 pendingMessages |
| 6 | `web/app/messages.js:10` | handleMessage() — switch(eventType) 路由全部 WS 事件 |
| 7 | `web/app/messages.js:85` | handleRunStarted() — isRunning=true，显示取消按钮 |
| 8 | `web/app/messages.js:111` | handleRunEnded() — 重置状态，移除思考动效，finalize UI |
| 9 | `web/app/messages.js:656` | cancelRun() — send cancel，显示「正在取消…」提示 |

---

#### web-4 · Web 流式渲染与工具卡片

**调用链**：`assistant.delta` → 去重 → Markdown 渲染 | `tool.call.started/ended` → 工具卡片 | `interrupt.request` → 审批弹窗

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `web/app/messages.js:179` | handleAssistantDelta() — 收到增量 token |
| 2 | `web/app/messages.js:534` | ingestAssistantText() — 流式/全量去重，返回真实增量 |
| 3 | `web/app/messages.js:561` | appendAssistantText() — 写入 segment，整段 Markdown 重渲 |
| 4 | `web/app/messages.js:189` | handleToolCallStarted() — 创建工具卡片，处理父子任务嵌套 |
| 5 | `web/app/messages.js:346` | handleToolCallEnded() — 更新状态/摘要/结果内容 |
| 6 | `web/app/messages.js:440` | handleFileOp() — 文件操作卡片（diff、行数指标）|
| 7 | `web/app/messages.js:475` | handleTodosUpdated() — 更新任务抽屉 Badge 和进度列表 |
| 8 | `web/app/messages.js:501` | handleInterruptRequest() — HITL 审批弹窗，用户决策后发 interrupt_response |

---

## 跨系统调用对照

下表展示同一功能在三个子系统中的对应位置，方便端到端追踪：

| 功能 | Extension | Server | Web |
|------|-----------|--------|-----|
| WS 连接建立 | `connection.js:127 connectWs` | `app.py:526 /ws/{id}` | `network.js:246 connectWebSocket` |
| 发送用户消息 | — | `sessions.py:633 enqueue_run` | `messages.js:645 network.send` |
| LLM 文字输出 | — | `sessions.py:1276 _handle_ai_message` → `assistant.delta` | `messages.js:561 appendAssistantText` |
| 工具调用 | — | `sessions.py:1280 _handle_tool_message` → `tool.call.ended` | `messages.js:346 handleToolCallEnded` |
| HITL 审批 | — | `sessions.py:1287 _process_interrupts` → `interrupt.request` | `messages.js:501 handleInterruptRequest` |
| 页面快照 | `snapshot.js:78 requestSnapshotFromTab` | `browser_bridge.py` | — |
| 浏览器操作 | `actions.js:92 handleAction` | `browser_tools.py` | — |
