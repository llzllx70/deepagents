# Context 管理方案分析与改进

## 一、当前方案架构

当前 context 管理采用 **三层防线** 设计，核心逻辑在 `deepagents` pip 包的 `SummarizationMiddleware` 中：

```
用户消息 → Middleware Stack → [参数截断] → [摘要化] → 模型调用
                                  ↓ 失败
                              无任何兜底 → BadRequestError → 会话崩溃
```

### 第一层：工具参数截断（Argument Truncation）

- **触发条件**：context 达到 `max_input_tokens` 的 85%
- **操作**：截断旧消息中 `write_file`/`edit_file` 的大参数，保留前 20 字符 + `"...(argument truncated)"`
- **保护范围**：最近 10% context window 内的消息不动
- **限制**：仅处理两种工具，其他工具的大返回值不受影响

**源码位置**：`deepagents/middleware/summarization.py:377-453`

### 第二层：对话摘要（Summarization）

- **触发条件**：context 达到 `max_input_tokens` 的 85%（fraction 模式）
- **操作**：
  1. 先将旧消息 offload 到 backend 的 `/conversation_history/{thread_id}.md`（追加写入）
  2. 用 LLM 自身生成摘要（SESSION INTENT / SUMMARY / ARTIFACTS / NEXT STEPS）
  3. 用 `RemoveMessage(REMOVE_ALL_MESSAGES)` + 摘要 HumanMessage + 保留消息 替换原始历史
- **保留策略**：保留最近 10% context window 的消息
- **摘要输入**：`trim_tokens_to_summarize=None`（不裁剪，所有旧消息全量送给 LLM 做摘要）
- **安全机制**：offload 失败时放弃摘要，保留原始消息
- **AI/Tool 消息配对保护**：`_find_safe_cutoff_point()` 确保不会将 AIMessage 和其对应的 ToolMessage 拆分

**源码位置**：`deepagents/middleware/summarization.py:600-758`

#### Offload 文件路径

历史消息 offload 到 backend 上而非本地文件系统：

```
thread_id 生成链路:
  SessionState.__init__()                    # deepagents_cli/config.py:386
    → self.thread_id = str(uuid.uuid4())     # 每个 session 一个随机 UUID

  _execute_run()                             # server/sessions.py:658-659
    → config = {"configurable": {"thread_id": self.session_state.thread_id}}
    → agent.astream(stream_input, config=config)

  SummarizationMiddleware._get_thread_id()   # summarization.py:198-220
    → get_config()["configurable"]["thread_id"]  # 从 langgraph contextvar 获取

  _get_history_path()                        # summarization.py:222-231
    → f"/conversation_history/{thread_id}.md"

  _offload_to_backend()                      # summarization.py:455-524
    → backend.write(path, content)           # 写入 CompositeBackend
```

**实际文件位置**：`workspace/{session_id}/conversation_history/{thread_id}.md`
- 在 Docker 模式下，对应容器内 `/workspace/conversation_history/{thread_id}.md`
- 如果对话从未触发摘要（不够长），该文件不会被创建

#### 摘要 Prompt 模板

```
<role>Context Extraction Assistant</role>
<primary_objective>
  Extract the highest quality/most relevant context from the conversation history.
</primary_objective>
<instructions>
  结构化输出：
  ## SESSION INTENT - 用户的主要目标
  ## SUMMARY - 最重要的上下文信息
  ## ARTIFACTS - 创建/修改/访问的文件和资源
  ## NEXT STEPS - 剩余待完成的任务
</instructions>
```

**源码位置**：`langchain/agents/middleware/summarization.py:33-74`

### 第三层：Token 计数

- 使用 `count_tokens_approximately`（字符估算法）
- Claude: 3.3 字符/token，其他模型: ~4 字符/token
- 每条消息额外 +3 token 开销
- **不支持图片 token 计算**

**源码位置**：`langchain_core/messages/utils.py`

### 模型 Profile 配置

- `sessions.py` 中 `_MODEL_MAX_INPUT_TOKENS` 硬编码了已知模型的 context window
- `_configure_model_profile()` 在 session 创建时设置 `model.profile["max_input_tokens"]`
- **无 profile 时的 fallback**：trigger=170k tokens, keep=6 条消息

**源码位置**：
- 阈值配置: `deepagents/graph.py:144-162`
- Profile 设置: `server/sessions.py:192-219`

### 阈值配置详情

```python
# 有 model profile 时 (graph.py:148-155):
trigger = ("fraction", 0.85)       # context 达 85% 时触发摘要
keep = ("fraction", 0.10)          # 保留最近 10% 的消息
truncate_args_settings = {
    "trigger": ("fraction", 0.85), # 参数截断也在 85% 触发
    "keep": ("fraction", 0.10),
}

# 无 model profile 时 (graph.py:156-162):
trigger = ("tokens", 170000)       # 170k tokens 触发
keep = ("messages", 6)             # 保留最近 6 条消息
truncate_args_settings = {
    "trigger": ("messages", 20),   # 20 条消息时触发参数截断
    "keep": ("messages", 20),      # 保留最近 20 条（实际上不截断）
}
```

---

## 二、问题分析

### P1 [严重] 无 Context Overflow 错误恢复

**位置**：`server/sessions.py:745-751`（`agent.astream()` 调用处）

当 token 估算不准导致实际 token 超限时，LLM API 返回 `BadRequestError(context_length_exceeded)`。当前代码的处理：

```python
# sessions.py:549-563 (_run_worker)
except Exception as exc:
    logger.exception("Run failed: ...")
    self.run_status[run_request.run_id] = "failed"
    await self.broadcast({"type": "run.failed", ...})
```

整个 run 直接标记为 failed，用户看到通用错误信息，**没有任何重试或降级逻辑**。

### P2 [严重] 单条消息超限无保护

**场景**：`fetch_url`、`http_request`、`web_search`、MCP 工具返回超大结果

- `sessions.py:1007-1010` 的截断（50k 字符）仅用于 WebSocket **展示**，完整内容仍进入 agent 消息历史
- 如果单条 ToolMessage 就超过 context window，SummarizationMiddleware 无法处理（摘要的"保留消息"已超限）
- `read_file` 工具内部有截断，但 `fetch_url`、`http_request`、`web_search`、MCP 工具无限制

### P3 [中等] Token 估算误差导致 85% 触发阈值失效

- 字符估算法对中文内容误差大（中文 ~1.5-2 字符/token，而不是默认的 4）
- 对 JSON 工具调用参数、base64 编码内容误差也大
- 图片 token 完全不计算
- 85% 阈值 + 30% 估算误差 = 实际可能在 110% 时才触发

### P4 [中等] 摘要请求本身可能超限

`trim_tokens_to_summarize=None` 意味着待摘要的全部消息不经裁剪就发给 LLM。如果旧消息有 100k token，摘要请求本身就会因为 context 超限而失败，`_create_summary()` 返回错误字符串 `"Error generating summary: ..."`，但摘要流程仍然继续——旧消息被删除，只留下一条错误信息。

### P5 [中等] System Message 在摘要后丢失

摘要后原始 SystemMessage 被 `RemoveMessage(REMOVE_ALL_MESSAGES)` 删除。虽然 MemoryMiddleware、SkillsMiddleware 等中间件每轮都会重新注入 system prompt，但 `create_deep_agent()` 传入的原始 `system_prompt` 不会被重新注入——它只在图创建时设置一次。

### P6 [中等] 摘要响应大小不可控

LLM 生成的摘要没有长度限制。复杂会话可能生成很长的摘要，加上保留消息，新 context 可能立即再次接近阈值，导致连续摘要循环。

### P7 [低] 缺少可观测性

- 不记录当前 token 使用量、context 利用率
- 不记录摘要触发事件
- 出问题时难以诊断

### P8 [低] 硬编码模型列表难以维护

`_MODEL_MAX_INPUT_TOKENS` 是硬编码 dict，新增模型需要改代码。更好的方式是从 `config/model.yml` 读取。

---

## 三、改进方案

### 改进 1：Context Overflow 错误恢复（解决 P1）

**文件**：`server/sessions.py` — `_execute_run()` 方法

在 `agent.astream()` 调用处添加 catch-and-retry 逻辑：

```python
# 在 while True 循环内，包裹 agent.astream() 调用
try:
    async for chunk in self.agent.astream(...):
        ...
except (openai.BadRequestError, anthropic.BadRequestError) as exc:
    error_str = str(exc).lower()
    if "context_length" in error_str or "token" in error_str or "maximum" in error_str:
        logger.warning("Context overflow detected, forcing emergency truncation: %s", exc)
        # 强制截断：只保留最近 N 条消息
        await self._emergency_context_truncation(config)
        # 重试一次（设置标志防止无限循环）
        continue
    raise
```

新增 `_emergency_context_truncation()` 方法：通过 checkpointer 读取当前 state，只保留最近 6 条消息（保持 AI/Tool 配对完整），写回 state。

### 改进 2：工具结果大小限制（解决 P2）

**文件**：`server/sessions.py` — 工具结果处理处

在工具结果进入消息历史之前，添加全局大小限制：

```python
_MAX_TOOL_RESULT_CHARS = 30000  # ~7.5k tokens

def _truncate_tool_result(content: str, max_chars: int = _MAX_TOOL_RESULT_CHARS) -> str:
    if len(content) <= max_chars:
        return content
    half = max_chars // 2
    return content[:half] + f"\n\n... (truncated {len(content) - max_chars} chars) ...\n\n" + content[-half:]
```

应用位置：在 `ToolMessage` 进入 state 之前截断。由于工具执行在 deepagents 包内部，最可行的方式是通过 **自定义 Middleware** 在 `before_model()` 中截断当前轮的 ToolMessage 内容。

### 改进 3：增大安全边际（解决 P3）

**文件**：`server/sessions.py` — `_configure_model_profile()`

将 profile 中的 `max_input_tokens` 设置为实际值的 **75%** 而非 100%，让 SummarizationMiddleware 的 85% 触发阈值实际对应真实 context 的 ~64%，留出足够安全边际：

```python
if model_name and model_name in _MODEL_MAX_INPUT_TOKENS:
    actual_limit = _MODEL_MAX_INPUT_TOKENS[model_name]
    # 设置为 75% 以补偿 token 估算误差
    profile["max_input_tokens"] = int(actual_limit * 0.75)
```

### 改进 4：关键日志点（解决 P7）

**文件**：`server/sessions.py`

在 `_execute_run()` 中添加：
- 每轮 stream 开始前，用 `count_tokens_approximately` 估算当前消息总量并 log
- 捕获到 context overflow 时的详细日志（消息数量、估算 token 数）

### 改进 5：从配置文件读取 max_input_tokens（解决 P8）

**文件**：`server/sessions.py`, `config/model.yml`

在 `config/model.yml` 的模型配置中支持 `max_input_tokens` 字段：

```yaml
models:
  kimi:
    api_key: "..."
    base_url: "..."
    model: "kimi-k2.5"
    max_input_tokens: 131072  # 新增
```

`_configure_model_profile()` 优先从配置文件读取，fallback 到硬编码 dict。

---

## 四、优先级与实施顺序

| 顺序 | 改进 | 解决问题 | 复杂度 | 影响 |
|------|------|---------|--------|------|
| 1 | 错误恢复 | P1 | 中 | 消除会话崩溃 |
| 2 | 工具结果限制 | P2 | 低 | 防止单条消息超限 |
| 3 | 增大安全边际 | P3 | 低 | 一行改动 |
| 4 | 关键日志 | P7 | 低 | 提高可观测性 |
| 5 | 配置文件读取 | P8 | 低 | 提高可维护性 |

P4（摘要请求超限）、P5（System Message 丢失）、P6（摘要响应不可控）属于 deepagents pip 包内部逻辑，无法在 server/ 层面完美修复，建议后续向上游提 issue。

---

## 五、关键文件

| 文件 | 角色 | 修改 |
|------|------|------|
| `server/sessions.py` | 执行循环、模型配置、错误恢复 | 是 |
| `server/agent.py` | Agent 创建、middleware 组装 | 可能（自定义 middleware） |
| `config/model.yml` | 模型配置 | 是（添加 max_input_tokens） |
| `deepagents/middleware/summarization.py` | 摘要核心逻辑 | 否（pip 包，仅参考） |
| `deepagents/graph.py` | 阈值配置 | 否（pip 包，仅参考） |
| `langchain/agents/middleware/summarization.py` | 基类实现 | 否（pip 包，仅参考） |

## 六、验证方式

1. **错误恢复测试**：构造超长对话触发 context overflow，验证 emergency truncation 生效并重试成功
2. **工具结果限制测试**：用 `fetch_url` 抓取大页面，验证 ToolMessage 被截断
3. **安全边际测试**：检查日志中摘要触发时的 token 估算值是否在安全范围内
4. **日志验证**：长对话中观察 token 使用量日志输出
5. **配置读取测试**：在 model.yml 中设置 max_input_tokens，验证优先级正确
