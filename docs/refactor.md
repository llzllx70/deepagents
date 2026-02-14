# DeepAgents 代码重构优化清单

> 生成日期：2026-02-14
> 分析范围：server/、web/、test/、scripts/（排除 skills/ 外部导入模块）

---

## 一、Server 端 (Python)

### 1.1 超长函数拆分 [高优先级]

**文件:** `server/sessions.py:661` — `_execute_run()` 方法约 640 行（661–1300）

**问题:** 单个方法承担了流处理、消息处理、工具调用缓冲、中断处理、上下文管理等多个职责，违反单一职责原则。下一个同级方法 `_emergency_context_truncation()` 在第 1301 行。

**建议:** 拆分为以下子方法：
- `_process_stream_chunks()` — 流数据处理
- `_handle_ai_message()` — AI 消息处理
- `_handle_tool_message()` — 工具消息处理
- `_process_interrupts()` — 中断处理逻辑

---

### 1.2 Tool Call 参数提取逻辑重复 [高优先级]

**文件:**
- `server/sessions.py:312-324`（2 处 fallback 循环）
- `server/tool_args_middleware.py:24-33`（2 处 fallback 循环）
- `server/tool_stream.py:118-129`（2 处 fallback 循环）

**问题:** 以下代码模式在 3 个文件中出现共 **6 次**：
```python
tool_name = tool_call.get("name") or tool_call.get("tool_name")
raw_args = tool_call.get("args")
if raw_args in (None, "", {}):
    for key in ("arguments", "input", "parameters", "params"):
        if key in tool_call:
            raw_args = tool_call.get(key)
            break
```

**建议:** 在 `message_utils.py` 中提取 `extract_tool_call_info(tool_call)` 统一调用。

---

### 1.3 Docker 子进程操作重复 [高优先级]

**文件:** `server/docker_pool.py`（第 339、356、366、378、391 行）、`server/docker.py:114`

**问题:** `docker_pool.py` 中 `_create_container()`、`_rename_container(:355)`、`_remove_container(:365)`、`_pause_container(:377)`、`_unpause_container(:390)` 以及 `docker.py` 的 `_set_pause_state(:114)` 均使用相同的 `subprocess.run()` + 错误处理模式。共 5 处 `subprocess.run` 调用。

**建议:** 提取 `_run_docker_command(args, allow_errors=[])` 包装函数，消除重复。

---

### 1.4 API 授权检查重复 [高优先级]

**文件:** `server/app.py:270, 295, 401, 477, 536`

**问题:** 以下授权模式在 `delete_session`、`upload_attachments`、`delete_attachment` 等 **5 处** 重复：
```python
owner = await get_session_owner(session_id)
if owner and owner != username:
    raise HTTPException(status_code=403, detail="Forbidden")
```

**建议:** 提取 `_authorize_session_access(username, session_id)` 辅助函数。

---

### 1.5 文本截断函数重复 [中优先级]

**文件:** 4 个文件中存在 **6 个** 功能类似的截断函数：
- `server/message_utils.py:56` — `truncate_for_log(text, limit=2000)`
- `server/message_utils.py:162` — `truncate_text(text, limit)`
- `server/message_utils.py:172` — `_truncate_inline(text, limit=TOOL_DISPLAY_LIMIT)`
- `server/sandbox_tool_utils.py:27` — `_truncate_text(text, limit=4000)`
- `server/sandbox_tools.py:112` — 内联 `_truncate(text)` lambda
- `server/tool_result_middleware.py:23` — `_truncate_tool_result(content, max_chars=30000)`

**问题:** 截断策略不统一（有的只保留头部，有的保留头尾），limit 硬编码在各处。

**建议:** 统一为 `truncate_string(text, limit, mode="head"|"head_tail", suffix="...")` 单一函数，各处通过参数区分策略。

---

### 1.6 LLM 配置加载重复 [中优先级]

**文件:**
- `server/qwen_tools.py:63` — `_load_model_config()`
- `server/qwen_tools.py:78` — `_load_scene_config()`
- `test/test_outer_model.py:18` — `load_models_config()`（被 3 处调用：52、94、134 行）
- `test/test_qwen_image.py:51` — `_load_models_config()`
- `test/test_playwright_vlm_click.py:379` — `_load_models_config()`

**问题:** `config/model.yml` 的 YAML 配置加载逻辑在 5 处重复实现，命名不一致（有/无下划线前缀）。

**建议:** 抽取为独立的 `config_loader.py` 模块，提供统一的带缓存的配置加载接口。测试文件可改为导入或放入 `test/conftest.py`。

---

### 1.7 文件上传错误响应重复 [中优先级]

**文件:** `server/app.py:319, 341, 358, 382`

**问题:** `AttachmentUploadItem` 错误响应在 **4 处** 以相同结构构造（不支持的文件类型、保存失败、上传到沙箱失败、通用错误）。

**建议:** 提取 `_create_upload_error_item(filename, error_msg)` 辅助函数。

---

### 1.8 Tool Call 缓冲逻辑重复 [中优先级]

**文件:** `server/tool_stream.py:118-129`、`server/sessions.py:312-324`

**问题:** 工具调用分片缓冲和组装逻辑在两个文件中重复实现，均包含 name/tool_name 判断和 args fallback 循环。

**建议:** 保留 `tool_stream.py` 中的实现，`sessions.py` 中改为导入调用。

---

### 1.9 Qwen 图像提取函数重复 [中优先级]

**文件:** `server/qwen_runner.py`

**问题:** 4 个相似的图像提取方法：
- `_extract_image_from_results()` (第 62 行)
- `_extract_image_from_content()` (第 75 行)
- `_extract_image_from_part()` (第 85 行)
- `_extract_image_from_multimodal()` (第 110 行)

调用点在第 124、294、296、369 行，相互调用关系复杂。

**建议:** 合并为 `_extract_first_image(data)` 并通过格式检测自动分发。

---

### 1.10 Session Owner 管理函数重复 [中优先级]

**文件:** `server/app.py:181`

**问题:** `get_session_owner()`、`set_session_owner()`、`clear_session_owner()` 三个函数内部都有相似的 JSON 读写模式。

**建议:** 封装为通用的 session owner 存储辅助类。

---

### 1.11 魔法数字散落 [低优先级]

**文件:** 多个文件

**问题:**
- `server/message_utils.py` — `TOOL_DISPLAY_LIMIT = 160`
- `server/sandbox_tool_utils.py:27` — 硬编码 `limit=4000`
- `server/tool_result_middleware.py:20` — 硬编码 `_MAX_TOOL_RESULT_CHARS = 30000`
- `server/sessions.py` — 硬编码 `50000`

**建议:** 集中到 `constants.py` 模块。

---

## 二、Web 前端 (JavaScript)

### 2.1 文件类型检测逻辑重复 [高优先级]

**文件:** `web/app/ui.js`

**问题:** 3 个函数使用几乎相同的扩展名判断逻辑：
- `getFileTypeIcon()` (第 2140 行)
- `getFileTypeClass()` (第 2203 行)
- `getFileTypeLabel()` (第 2234 行)

每个函数都重复判断 `pdf/ppt/pptx/doc/xls/txt` 等扩展名，调用点在第 877、890、937、1032、1044、1068 行。

**建议:** 创建 `detectFileType(filename, contentType)` 返回 `{ type, icon, label, cssClass }`，三个函数改为调用此函数。

---

### 2.2 附件预览创建重复 [高优先级]

**文件:** `web/app/ui.js`

**问题:** `addUploadingPreview()` (第 867 行) 和 `addAttachmentPreview()` (第 1021 行) 两个方法结构几乎一致：
- 都创建 `item`、`visual`、`meta` 元素
- 都调用 `getFileTypeClass()` 和 `getFileTypeIcon()`
- 都包含相同的图片预览逻辑

**建议:** 抽取 `createAttachmentItem(file, status)` 共享方法，两处改为调用。

---

### 2.3 Fetch/Auth 请求模板重复 [中优先级]

**文件:** `web/app/network.js:26, 86, 112, 149, 396, 426`

**问题:** **6+ 处** 使用相同的 fetch 模式：
```javascript
await app.auth.authFetch(`${app.serverUrl}/path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
});
```

**建议:** 封装 `apiCall(method, path, data)` 方法消除模板代码。

---

### 2.4 Session 认证校验重复 [中优先级]

**文件:** `web/app/network.js:18, 58, 74, 101, 147, 244, 383, 394, 423`

**问题:** 以下模式出现 **9 次**：
```javascript
if (!app.auth.isAuthenticated()) {
    app.auth.setLoginStatus('请先登录', 'error');
    throw new Error('未登录');
}
```

**建议:** 提取 `ensureAuthenticated()` 方法。

---

### 2.5 Modal 管理模式重复 [中优先级]

**文件:** `web/app/ui.js:280, 285, 347, 468, 492, 1374, 1383`

**问题:** 多处重复的 Modal 显示/隐藏逻辑：
```javascript
modal.classList.add('active');
modal.classList.remove('active');
```

涉及删除确认、清空历史确认、中断审批等 **7 处**。

**建议:** 创建 `ModalManager` 工具类，提供 `show(modalId)` / `hide(modalId)` 方法。

---

### 2.6 localStorage 管理分散 [中优先级]

**文件:**
- `web/app/utils.js:38-58` — 6 处 setItem/removeItem
- `web/app/ui.js:36-61` — 6 处 getItem/removeItem
- `web/app/ui.js:1880` — 1 处 setItem
- `web/index.html:17` — 1 处 getItem
- `web/extension/popup.js:28` — 1 处 getItem
- `web/extension/content.js:131` — 1 处 getItem

**问题:** localStorage 操作散布在 **6 个文件共 16+ 处**，key 字符串硬编码在各处（`deepagents_auth_token`、`deepagents_session_id`、`cortexai-theme` 等）。

**建议:** 创建 `StorageManager` 工具类，集中管理所有 localStorage 操作和 key 常量。

---

### 2.7 Run State 清理重复 [中优先级]

**文件:**
- `web/app/history.js:538-539` — `runStates.delete` + `messageBuffer.delete`
- `web/app/history.js:665-666` — 同上
- `web/app/ui.js:728` — `messageBuffer.delete`

**问题:** 以下模式出现多次：
```javascript
app.runStates.delete(runId);
app.messageBuffer.delete(runId);
```

**建议:** 提取 `cleanupRunState(runId)` 方法。

---

### 2.8 Upload Preview 状态更新重复 [低优先级]

**文件:** `web/app/ui.js`

**问题:** `updateUploadPreviewSuccess()` 和 `updateUploadPreviewFailed()` 包含相同的元素操作模式。

**建议:** 合并为 `updateUploadPreviewStatus(tempId, status, metadata)`。

---

### 2.9 疑似死代码 [低优先级]

**文件:** `web/app/ui.js`（第 2330-2443 行）

**问题:** 以下方法在项目内无外部调用者（仅相互调用）：
- `extractFileLinks()` (第 2330 行)
- `isFileUrl()` (第 2362 行) — 仅被 `extractFileLinks` 调用
- `getFileIconClass()` (第 2374 行) — 仅被 `renderFileCards` 调用
- `getFileTypeFromUrl()` (第 2389 行) — 仅被 `renderFileCards` 调用
- `renderFileCards()` (第 2420 行) — 无调用者

**建议:** 确认是否仍在使用，若无调用者则移除。

---

### 2.10 Extension 代码 WebSocket URL 构建重复 [低优先级]

**文件:** `web/extension/popup.js`、`web/extension/background.js`

**问题:** WebSocket URL 构建逻辑在两个文件中重复实现。

**建议:** 抽取到共享工具文件。

---

## 三、测试与脚本

### 3.1 YAML 配置解析重复（测试） [中优先级]

**文件:**
- `test/test_outer_model.py:18` — `load_models_config()`（无下划线前缀）
- `test/test_qwen_image.py:51` — `_load_models_config()`（有下划线前缀）
- `test/test_playwright_vlm_click.py:379` — `_load_models_config()`（有下划线前缀）

**问题:** 3 个测试文件中包含几乎相同的 YAML 配置加载函数，命名不一致。

**建议:** 抽取到 `test/conftest.py` 或与 1.6 中的 `config_loader.py` 合并。

---

### 3.2 run.sh 内嵌 Python YAML 解析重复 [中优先级]

**文件:** `scripts/run.sh`

**问题:** 5 个 shell 函数中内嵌了相似的 Python YAML 解析逻辑（通过 heredoc）：
- `load_env_config()` (第 61 行)
- `scene_config_value()` (第 103 行)
- `model_config_value()` (第 143 行)
- `model_config_keys()` (第 186 行)
- `model_exists()` (第 214 行)

核心解析逻辑（缩进检测、引号剥离）在各处重复。

**建议:** 抽取为独立的 `scripts/config_parser.py` 工具脚本，shell 函数改为调用此脚本。

---

### 3.3 CLI 参数解析方式不统一 [低优先级]

**文件:** 多个脚本文件

**问题:** 部分脚本使用 `argparse`，部分直接检查 `sys.argv`，错误信息格式不一致。

**建议:** 统一使用 `argparse`。

---

## 四、重构路线图

### Phase 1 — 高优先级（高收益，可独立执行）

| 编号 | 优化项 | 涉及文件 | 预计收益 |
|------|--------|---------|---------|
| 1.1 | 拆分 `_execute_run()` 超长函数 | `sessions.py` | 可维护性大幅提升 |
| 1.2 | 统一 Tool Call 参数提取 | 3 文件 6 处 | 消除 ~60 行重复 |
| 1.3 | Docker 子进程操作包装 | `docker_pool.py`, `docker.py` | 消除 ~80 行重复 |
| 1.4 | API 授权检查提取 | `app.py` 5 处 | 消除 ~30 行重复 |
| 2.1 | 文件类型检测合并 | `ui.js` 3 函数 | 消除 ~100 行重复 |
| 2.2 | 附件预览创建合并 | `ui.js` 2 函数 | 消除 ~100 行重复 |

### Phase 2 — 中优先级（中等收益）

| 编号 | 优化项 | 涉及文件 | 预计收益 |
|------|--------|---------|---------|
| 1.5 | 文本截断函数统一 | 4 文件 6 函数 | 消除 ~50 行，统一策略 |
| 1.6 | LLM 配置加载统一 | `qwen_tools.py` + 3 测试文件 | 消除 ~60 行 |
| 1.7 | 文件上传错误响应提取 | `app.py` | 消除 ~20 行 |
| 1.8 | Tool Call 缓冲逻辑去重 | `tool_stream.py`, `sessions.py` | 消除 ~40 行 |
| 1.9 | Qwen 图像提取函数合并 | `qwen_runner.py` | 减少 ~40 行 |
| 2.3 | Fetch 请求模板统一 | `network.js` 6 处 | 消除 ~50 行 |
| 2.4 | 认证校验提取 | `network.js` 9 处 | 消除 ~30 行 |
| 2.5 | Modal 管理统一 | `ui.js` 7 处 | 消除 ~30 行 |
| 2.6 | localStorage 管理集中 | 6 文件 16+ 处 | 减少维护负担 |
| 3.1 | 测试 YAML 解析去重 | 3 测试文件 | 消除 ~60 行 |
| 3.2 | run.sh YAML 解析重构 | `run.sh` 5 函数 | 消除 ~100 行 |

### Phase 3 — 低优先级（代码整洁）

| 编号 | 优化项 | 说明 |
|------|--------|------|
| 1.10 | Session Owner 管理封装 | 减少 JSON 读写模板代码 |
| 1.11 | 魔法数字集中管理 | 统一到 `constants.py` |
| 2.7 | Run State 清理提取 | 消除分散的状态清理代码 |
| 2.8 | Upload 状态更新合并 | 两函数合一 |
| 2.9 | 清理疑似死代码 | `ui.js` 5 个未调用方法 |
| 2.10 | Extension WebSocket URL 去重 | 提取到共享文件 |
| 3.3 | CLI 参数解析统一 | 全部使用 argparse |

---

## 五、重构原则

1. **不改变外部行为** — 所有重构仅消除冗余，不引入功能变更
2. **逐步推进** — 每个优化项可独立提交，便于 review 和回滚
3. **测试先行** — 重构前确保现有测试通过，重构后验证无回归
4. **保持向后兼容** — 抽取函数时保留原有函数签名作为薄包装（过渡期）
