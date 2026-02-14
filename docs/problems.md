# DeepAgents 项目问题分析

> 生成日期：2026-02-14
> 分析范围：后端服务器、前端客户端、部署脚本、配置文件

---

## 一、严重安全问题 (CRITICAL)

### 1. API 密钥明文暴露

**涉及文件**：
- `config/model.yml`（第 3、8-9、15、20、24、28、32 行）
- `config/deepagents.yml`（第 3、5、7-9 行）

**问题描述**：
多个 LLM 提供商的 API 密钥以明文形式硬编码在配置文件中，包括 Kimi、GLM、Qwen、Claude、OpenRouter 等。`config/deepagents.yml` 中同样包含 LangSmith API key、AlphaVantage API key 和 Coze Token 等敏感凭证。

```yaml
# config/model.yml 示例
models:
  kimi:
    api_key: "sk-02l9SPb..."    # 明文 API 密钥
  claude:
    api_key: "sk-H8O86c..."    # 明文 API 密钥
```

**风险说明**：
- 密钥可能通过 Git 历史泄漏
- 任何有代码库访问权限的人都可获取所有 API 密钥
- 密钥泄漏可导致大量 API 费用和数据安全问题

**修复建议**：
- 将所有 API 密钥迁移到环境变量或密钥管理服务（如 HashiCorp Vault）
- 配置文件中使用占位符引用：`api_key: "${KIMI_API_KEY}"`
- 将 `config/model.yml` 和 `config/deepagents.yml` 加入 `.gitignore`
- 立即轮换所有已暴露的密钥

---

### 2. 硬编码弱密码认证

**涉及文件**：`server/auth.py`（第 8-19 行）

**问题描述**：
所有用户凭证以明文字典的形式硬编码，且用户名与密码完全相同（如 `"xh1": "xh1"`），共 10 个账户。

```python
USERS: dict[str, str] = {
    "xh1": "xh1",
    "xh2": "xh2",
    # ...
    "xh10": "xh10",
}
```

**风险说明**：
- 密码等于用户名，极易被暴力破解
- 明文存储密码，无任何哈希保护
- 无登录失败次数限制，无法防御暴力攻击
- `verify_credentials()` 函数（第 22-25 行）直接进行明文比对

**修复建议**：
- 使用 bcrypt 或 Argon2 进行密码哈希
- 将用户凭证存储在数据库中，而非代码中
- 增加登录失败速率限制（如 5 次失败后锁定 15 分钟）
- 要求密码满足最低复杂度要求

---

### 3. XSS 漏洞 — 大量 innerHTML 使用

**涉及文件**：
- `web/app/messages.js`（第 407、415、571 行等，共 3 处）
- `web/app/ui.js`（第 942、945、1076、1078、2027、2051、2060、2110 行等，共 44 处）
- `web/app/utils.js`（1 处）
- `web/app/history.js`（3 处）

**问题描述**：
前端代码中共有 **51 处** `innerHTML` 赋值操作。虽然部分位置使用了 `escapeHtml()` 进行转义，但许多位置直接拼接用户可控数据或服务器返回内容到 HTML 中，未经充分过滤。

```javascript
// web/app/messages.js:415
resultContent.innerHTML = app.utils.formatToolResult(toolContent);

// web/app/ui.js:2110
content.innerHTML = `<div class="task-drawer-items">${itemsHtml}</div>`;
```

**风险说明**：
- 恶意用户可通过注入脚本窃取其他用户的 Token
- 服务器返回的工具执行结果可能包含恶意 HTML
- LLM 生成内容中可能包含注入脚本

**修复建议**：
- 使用 `textContent` 替代 `innerHTML` 设置纯文本
- 使用 `DOMPurify` 库清理所有动态 HTML 内容
- 对 Markdown 渲染结果进行 sanitize 处理
- 建立统一的 DOM 创建工具函数，避免直接拼接 HTML

---

## 二、高危问题 (HIGH)

### 4. CORS 配置过于宽松

**涉及文件**：`server/app.py`（第 154-160 行）

**问题描述**：
CORS 中间件配置允许所有来源访问，且同时允许携带凭证：

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # 允许任何域名
    allow_credentials=True,    # 允许携带凭证
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**风险说明**：
- 任何外部网站都可以代表已认证用户发起 API 请求
- 结合 `allow_credentials=True`，构成完整的 CSRF 攻击向量
- 注释标注 "for development" 但在生产环境中未修改

**修复建议**：
- 将 `allow_origins` 设置为具体的前端域名列表
- 在生产环境中禁用 `allow_credentials` 或使用白名单
- 通过环境变量配置 CORS 来源

---

### 5. /files 路由无认证保护

**涉及文件**：`server/app.py`（第 151 行）

**问题描述**：
静态文件挂载在 `/files` 路径下，无需任何认证即可访问所有工作区文件：

```python
app.mount("/files", StaticFiles(directory=WORKSPACE_DIR), name="files")
```

**风险说明**：
- 任何知道文件路径的人都可以下载工作区中的所有文件
- 工作区可能包含敏感的用户数据、代码和 AI 生成内容
- 结合 CORS 宽松配置，外部站点也可直接获取文件

**修复建议**：
- 添加认证中间件，要求有效 Token 才能访问 `/files`
- 实现基于 session 的文件访问控制（用户只能访问自己的工作区文件）
- 使用签名 URL 机制替代直接的静态文件服务

---

### 6. WebSocket Token 通过 URL 传递

**涉及文件**：`web/app/network.js`（第 164-167 行）

**问题描述**：
WebSocket 连接时，认证 Token 作为 URL 查询参数传递：

```javascript
const tokenParam = app.authToken ? `?token=${encodeURIComponent(app.authToken)}` : '';
app.wsUrl = `${wsProtocol}//${wsHost}/ws/${app.sessionId}${tokenParam}`;
```

**风险说明**：
- Token 出现在 URL 中，会被记录在浏览器历史、服务器日志、代理日志中
- HTTP Referer 头可能泄漏带有 Token 的 URL
- 不符合 OWASP 安全最佳实践

**修复建议**：
- 改用 WebSocket 子协议（`Sec-WebSocket-Protocol`）传递 Token
- 或在 WebSocket 连接建立后，通过首条消息进行认证
- 确保服务器日志不记录查询参数

---

### 7. 缺少 CSRF 保护

**涉及文件**：`server/app.py`（全局）

**问题描述**：
所有 POST/PUT/DELETE 请求仅依赖 `X-Auth-Token` 头部进行认证，没有 CSRF Token 机制。结合 CORS `allow_origins=["*"]` 配置，CSRF 攻击完全可行。

**风险说明**：
- 攻击者可构造恶意页面，在用户已登录的浏览器中发起请求
- 可代表用户创建会话、执行代码、删除数据

**修复建议**：
- 实施 CSRF Token 机制（如 Double Submit Cookie 模式）
- 修复 CORS 配置后，CSRF 风险可部分缓解
- 对敏感操作添加二次确认

---

### 8. 无速率限制

**涉及文件**：`server/app.py`（全局）

**问题描述**：
服务器端所有端点均无请求频率限制，包括登录接口 `/login`、会话创建 `/sessions`、文件上传等。

**风险说明**：
- 登录接口可被暴力破解
- 可通过高频请求消耗服务器资源（DoS）
- 可批量创建会话，耗尽 Docker 容器池

**修复建议**：
- 使用 `slowapi` 或 `fastapi-limiter` 实施速率限制
- 登录接口：每 IP 每分钟最多 5 次
- API 接口：每用户每分钟最多 60 次
- 文件上传：每用户每小时最多 100 个文件

---

## 三、资源泄漏与并发问题 (MEDIUM)

### 9. WebSocket 连接无空闲超时

**涉及文件**：`server/app.py`（第 524-569 行 WebSocket 处理逻辑）

**问题描述**：
WebSocket 连接建立后，没有空闲超时检测机制。客户端可以保持连接无限期打开，即使没有任何活动。

**风险说明**：
- 长期空闲连接占用服务器资源（文件描述符、内存）
- 恶意客户端可通过大量连接消耗服务器资源

**修复建议**：
- 实现心跳（ping/pong）机制，超过 30 秒无响应则断开
- 设置空闲超时（如 30 分钟无消息则关闭连接）
- 限制每用户最大 WebSocket 连接数

---

### 10. Docker 容器清理竞态条件

**涉及文件**：`server/docker_pool.py`（第 156-163 行、第 365-375 行）

**问题描述**：
`shutdown()` 方法在锁外执行容器删除操作。如果某个容器删除失败，不会阻止继续删除其他容器，但失败的容器会成为孤儿：

```python
async def shutdown(self) -> None:
    async with self._lock:
        all_ids = list(self._idle | self._in_use)
        self._idle.clear()      # 先清空集合
        self._in_use.clear()
    for container_id in all_ids:
        await asyncio.to_thread(self._remove_container, container_id)  # 可能失败
```

`_remove_container()`（第 365-375 行）在删除失败时仅记录警告日志，不会重试：

```python
def _remove_container(self, container_id: str) -> None:
    result = subprocess.run(["docker", "rm", "-f", container_id], ...)
    if result.returncode != 0:
        logger.warning(...)  # 仅记录警告，容器变为孤儿
```

**风险说明**：
- Docker daemon 短暂不可用时，所有容器清理失败
- 孤儿容器持续消耗宿主机资源
- 反复发生后可导致容器数量失控

**修复建议**：
- 对失败的容器删除实施指数退避重试（最多 3 次）
- 实现定期清理任务（cron），扫描带有 `deepagents.managed=1` 标签的孤儿容器
- 将失败的容器 ID 记录到持久化存储，下次启动时重新清理

---

### 11. Session 关闭缺少超时

**涉及文件**：`server/sessions.py`（Session.shutdown 方法）

**问题描述**：
Session 关闭时等待 worker task 完成，但没有超时限制。如果 worker 卡住（例如 LLM API 无响应），整个关闭过程会无限期阻塞。

**风险说明**：
- 服务器优雅关闭（shutdown）可能永远无法完成
- 单个卡住的 Session 可阻塞所有其他 Session 的清理

**修复建议**：
- 为 `await self.worker_task` 添加超时（如 `asyncio.wait_for(..., timeout=30)`）
- 超时后强制取消并记录错误日志

---

### 12. 上传文件无大小限制

**涉及文件**：`server/app.py`（第 332 行）

**问题描述**：
文件上传端点直接调用 `await upload.read()` 读取全部文件内容，未检查文件大小：

```python
content = await upload.read()  # 无大小检查
size = len(content)
```

**风险说明**：
- 攻击者可上传超大文件耗尽服务器内存
- 可快速填满磁盘空间
- 多个大文件并发上传可导致 OOM

**修复建议**：
- 在读取前检查 `Content-Length` 头部
- 设置最大文件大小限制（如 100MB）
- 使用流式读取替代一次性全量读取
- 在 Nginx/反向代理层设置 `client_max_body_size`

---

### 13. 运行队列无上限

**涉及文件**：`server/sessions.py`（run_queue 定义）

**问题描述**：
每个 Session 的运行队列使用默认的无界 `asyncio.Queue`，没有最大容量限制：

```python
run_queue: asyncio.Queue[RunRequest] = field(default_factory=asyncio.Queue)
```

**风险说明**：
- 客户端可快速发送大量运行请求，导致队列无限增长
- 内存消耗不可控，可能导致 OOM

**修复建议**：
- 设置队列最大容量：`asyncio.Queue(maxsize=10)`
- 队列满时返回 429（Too Many Requests）或拒绝新请求

---

### 14. InMemorySaver 无持久化

**涉及文件**：`server/sessions.py`（agent 状态管理）

**问题描述**：
LangGraph agent 使用 `InMemorySaver` 作为 checkpointer，所有对话状态仅保存在内存中。

**风险说明**：
- 服务器重启后所有对话历史丢失
- 长时间运行后内存持续增长，无法 GC 已结束的会话状态
- 无法实现故障恢复或跨实例迁移

**修复建议**：
- 使用持久化 checkpointer（如 `SqliteSaver` 或 `PostgresSaver`）
- 实现定期清理过期会话状态的机制
- 为内存中的状态设置 TTL（如 2 小时无活动则清除）

---

### 15. JSON 文件并发写入损坏风险

**涉及文件**：`server/storage.py`（第 29-31 行）

**问题描述**：
JSON 文件的写入操作不是原子性的。`write_json_file()` 直接覆写目标文件，如果写入过程中断（进程崩溃、磁盘满），文件会损坏：

```python
async def write_json_file(path: Path, payload: Any) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    await asyncio.to_thread(path.write_text, serialized, encoding="utf-8")
```

此外，`auth.py` 中的 `create_auth_token()`（第 28-33 行）存在 read-modify-write 模式。虽然 `AUTH_LOCK`（第 12 行）提供了 asyncio 级别的互斥，但锁在读取和写入之间被释放（`read_auth_sessions` 和 `write_auth_sessions` 分别加锁）：

```python
async def create_auth_token(username: str) -> str:
    token = uuid.uuid4().hex
    sessions = await read_auth_sessions()    # 读取时加锁然后释放
    sessions[token] = {"username": username, "created_at": time.time()}
    await write_auth_sessions(sessions)      # 写入时重新加锁
    return token
```

**风险说明**：
- 写入中断导致 JSON 文件内容损坏（不完整或空白）
- read-modify-write 间隙可能导致并发修改丢失
- 服务不可用（认证会话数据损坏后无法登录）

**修复建议**：
- 使用原子写入模式：先写入临时文件，再 `os.rename()` 替换
- 将 `create_auth_token` 中的 read 和 write 放在同一个锁的上下文中
- 考虑使用 SQLite 替代 JSON 文件，获得事务性保障
- 保留最近一次的备份文件

---

### 16. Token 无过期机制

**涉及文件**：`server/auth.py`（第 28-33 行、第 36-45 行）

**问题描述**：
认证 Token 在创建时记录了 `created_at` 时间戳，但在验证时（`get_user_for_token()`）完全不检查时间，Token 永不过期：

```python
async def create_auth_token(username: str) -> str:
    token = uuid.uuid4().hex
    sessions[token] = {"username": username, "created_at": time.time()}  # 记录了时间
    ...

async def get_user_for_token(token: str | None) -> str | None:
    ...
    entry = sessions.get(token)
    if isinstance(entry, dict):
        username = entry.get("username")  # 不检查 created_at
        ...
```

**风险说明**：
- Token 泄漏后永久有效，无法自然失效
- 用户无法通过"等待过期"来保护被盗 Token
- 违反最小权限和纵深防御原则

**修复建议**：
- 在 `get_user_for_token()` 中添加过期检查（如 24 小时）
- 实现 Token 刷新机制
- 提供管理端点用于撤销指定用户的所有 Token

---

## 四、前端问题 (MEDIUM)

### 17. localStorage 存储敏感 Token

**涉及文件**：
- `web/app/utils.js`（第 52-53 行）
- `web/app/ui.js`（第 36、50 行）

**问题描述**：
认证 Token 存储在 `localStorage` 中：

```javascript
// web/app/utils.js:53
localStorage.setItem('deepagents_auth_token', token);

// web/app/ui.js:36 - 启动时读取
const savedToken = localStorage.getItem('deepagents_auth_token');
```

此外，Token 还通过 `dataset` 属性暴露到 DOM 中（`web/app/utils.js` 第 30-31 行）：

```javascript
doc.dataset.daToken = token;  // Token 出现在 HTML 属性中
```

**风险说明**：
- `localStorage` 中的数据可被同源下的任何 JavaScript 访问
- XSS 漏洞可直接读取 Token（结合问题 #3）
- Token 存储在 DOM 的 `data-` 属性中，同样可被脚本读取

**修复建议**：
- 使用 `HttpOnly` + `Secure` + `SameSite=Strict` 的 Cookie 存储 Token
- 如必须使用 localStorage，至少在存储前加密
- 从 DOM 属性中移除敏感 Token

---

### 18. 大量 innerHTML 使用（51 处）

**涉及文件**：`web/app/messages.js`、`web/app/ui.js`、`web/app/utils.js`、`web/app/history.js`

**问题描述**：
前端 JavaScript 文件中共有 51 处 `innerHTML` 赋值。详细分布：
- `web/app/ui.js`：44 处
- `web/app/messages.js`：3 处
- `web/app/history.js`：3 处
- `web/app/utils.js`：1 处

大部分使用模板字符串拼接 HTML，部分包含用户可控内容或服务器返回数据。

**风险说明**：
- 即使大部分场景目前安全，代码维护中容易引入新的 XSS 漏洞
- 攻击面广泛，审计成本高

**修复建议**：
- 引入 `DOMPurify` 库，在所有 `innerHTML` 赋值处使用 `DOMPurify.sanitize()`
- 逐步将 `innerHTML` 替换为 DOM API（`createElement`、`textContent`）
- 建立代码规范：禁止裸 `innerHTML`，要求通过 sanitize 工具函数

---

### 19. 缺少 CSP 安全策略

**涉及文件**：`web/index.html`

**问题描述**：
HTML 页面未设置 Content Security Policy（CSP）响应头或 `<meta>` 标签。

**风险说明**：
- 浏览器不会限制内联脚本、外部脚本加载和动态代码执行
- XSS 攻击的危害无法被 CSP 缓解
- 无法防止未授权的资源加载

**修复建议**：
- 在 Nginx 配置中添加 CSP 头部：
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  ```
- 或在 `index.html` 中添加 `<meta http-equiv="Content-Security-Policy">` 标签
- 逐步消除对 `'unsafe-inline'` 和 `'unsafe-eval'` 的依赖

---

### 20. WebSocket 错误静默丢弃

**涉及文件**：`web/app/network.js`（第 319 行）

**问题描述**：
WebSocket 错误仅 `console.error` 到控制台，不向用户显示任何反馈：

```javascript
ws.onerror = (error) => {
    console.error('WebSocket 错误：', error);
    // 无用户可见的错误提示
};
```

**风险说明**：
- 用户不知道连接出现了问题，可能继续等待永不到来的响应
- 调试困难，关键错误信息仅在控制台可见

**修复建议**：
- 在 UI 中显示连接错误提示（如状态栏变红）
- 记录错误类型和重连状态
- 提供"重新连接"按钮

---

## 五、部署与配置问题 (MEDIUM)

### 21. 服务器绑定 0.0.0.0

**涉及文件**：`server/deepagents_server.py`（第 17 行）

**问题描述**：
服务器默认监听所有网络接口：

```python
uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info", access_log=False)
```

**风险说明**：
- 服务对整个网络可见，包括公网（如果在云服务器上）
- 结合前述认证弱点，攻击者可直接访问服务

**修复建议**：
- 开发环境绑定 `127.0.0.1`
- 生产环境通过反向代理（Nginx）对外暴露，后端仅监听 localhost
- 通过环境变量配置监听地址：`host = os.environ.get("BIND_HOST", "127.0.0.1")`

---

### 22. 访问日志被禁用

**涉及文件**：`server/deepagents_server.py`（第 17 行）

**问题描述**：
Uvicorn 的 HTTP 访问日志被显式禁用：

```python
uvicorn.run(..., access_log=False)
```

**风险说明**：
- 无法审计 HTTP 请求，无法检测攻击行为
- 安全事件发生后无法追溯访问记录
- 不符合安全合规要求

**修复建议**：
- 启用访问日志：`access_log=True`
- 配置日志格式包含客户端 IP、请求路径、响应状态码、用户标识
- 在 Nginx 反向代理层也启用访问日志

---

### 23. Docker 容器无默认资源限制

**涉及文件**：`server/docker_pool.py`（第 24-26 行、第 327-335 行）

**问题描述**：
Docker 容器的 CPU、内存和 PID 限制均为可选参数，默认值为 `None`。如果不在环境变量中显式配置，容器将不受资源约束运行：

```python
@dataclass
class DockerPoolConfig:
    cpus: str | None = None        # 默认无限制
    memory: str | None = None      # 默认无限制
    pids_limit: str | None = None  # 默认无限制
```

```python
# 第 327-335 行：仅在配置存在时才设置限制
if self._config.cpus:
    args += ["--cpus", self._config.cpus]
if self._config.memory:
    args += ["--memory", self._config.memory]
```

**风险说明**：
- 容器内的代码（用户通过 AI 生成执行）可消耗宿主机所有 CPU 和内存
- Fork bomb 可导致宿主机进程表满
- 单个恶意用户可影响所有其他用户的服务可用性

**修复建议**：
- 设置默认资源限制：`cpus="1"`, `memory="512m"`, `pids_limit="100"`
- 在 `_create_container()` 中始终添加 `--pids-limit` 和 `--memory` 参数
- 添加 `--read-only` 选项和 `--tmpfs` 配置以限制写入

---

### 24. 环境变量泄漏到容器

**涉及文件**：`server/docker_pool.py`（第 294-302 行）

**问题描述**：
特定环境变量被直接传递到 Docker 容器中：

```python
passthrough_env = ["COZE_TOKEN", "COZE_FLOW_ID", "COZE_APP_ID"]
for key in passthrough_env:
    value = os.environ.get(key)
    if value:
        env_args += ["-e", f"{key}={value}"]
```

**风险说明**：
- 容器内运行的用户代码可以读取这些凭证
- `COZE_TOKEN` 是敏感 API 凭证，可被滥用
- 容器内的任何进程都可通过 `/proc/self/environ` 或 `env` 命令获取

**修复建议**：
- 仅在确实需要的容器中注入凭证
- 使用 Docker secrets 机制而非环境变量传递敏感信息
- 为每个 session 生成限时临时凭证

---

### 25. run.sh 中危险的 shell 模式

**涉及文件**：`scripts/run.sh`（第 392-395 行、第 416-419 行）

**问题描述**：
脚本中使用了 `eval` 来恢复 trap 处理器：

```bash
trap 'kill "$tail_pid" >/dev/null 2>&1 || true; wait "$tail_pid" >/dev/null 2>&1 || true; eval "$prev_trap"; return 0' INT
# ...
eval "$prev_trap"
```

**风险说明**：
- `eval` 执行任意字符串为代码，如果 `$prev_trap` 被污染可导致命令注入
- 虽然在当前上下文中风险有限（`prev_trap` 来自 `trap -p`），但属于不安全编程模式

**修复建议**：
- 避免使用 `eval`，改用函数封装 trap 逻辑
- 如必须使用，确保输入来源可信且经过验证

---

### 26. pkill -f 可能误杀进程

**涉及文件**：`scripts/run.sh`（第 301 行）

**问题描述**：
使用 `pkill -f` 通过命令行模式匹配来停止服务器：

```bash
pkill -f "server.deepagents_server" >/dev/null 2>&1 || true
```

**风险说明**：
- `-f` 标志匹配完整命令行，可能误杀包含 "server.deepagents_server" 字符串的其他进程
- 例如：正在编辑该文件的编辑器、grep 该字符串的搜索命令等
- 在多实例部署场景下，可能停止错误的实例

**修复建议**：
- 使用 PID 文件机制：启动时记录 PID，停止时仅 kill 该 PID
- 或使用更精确的匹配模式：`pkill -f "^python -m server.deepagents_server"`
- 或使用 systemd 等进程管理器

---

## 六、测试与质量问题 (LOW)

### 27. 测试覆盖不足

**涉及文件**：`test/` 目录

**问题描述**：
当前测试文件列表：
- `test_chrome_devtools_mcp.py` — Chrome DevTools MCP 集成测试
- `test_crawl4ai_script.py` — 爬虫脚本测试
- `test_kimi_tool_args.py` — Kimi 工具参数测试
- `test_outer_model.py` — 外部模型测试
- `test_playwright_smoke.py` — Playwright 冒烟测试
- `test_playwright_vlm_click.py` — Playwright VLM 点击测试
- `test_query_crawler_script.py` — 查询爬虫测试
- `test_qwen_image.py` — Qwen 图片测试

**问题**：
- 无单元测试覆盖核心模块（`auth.py`、`sessions.py`、`storage.py`、`docker_pool.py`）
- 所有测试都是集成测试，依赖外部服务（Playwright、API key、Docker）
- 无前端测试
- 无 API 端点测试
- 无安全测试（如 SQL 注入、XSS、CSRF）

**修复建议**：
- 为核心模块添加单元测试（mock 外部依赖）
- 添加 API 集成测试（使用 FastAPI `TestClient`）
- 引入代码覆盖率工具（`pytest-cov`），目标覆盖率 80%+
- 添加安全扫描到 CI 流程（如 `bandit` for Python）

---

### 28. 无健康检查端点

**涉及文件**：`server/app.py`（全局）

**问题描述**：
服务器没有提供健康检查（health check）端点。无法方便地判断服务是否存活和各组件状态。

**修复建议**：
- 添加 `GET /health` 端点，返回服务状态
- 包含 Docker 池状态（空闲/使用中容器数）、数据库/存储连通性检查
- 用于负载均衡器和监控系统

---

### 29. 无密钥轮换机制

**涉及文件**：`config/model.yml`、`config/deepagents.yml`、`server/auth.py`

**问题描述**：
API 密钥和用户凭证均为静态配置，没有轮换机制和计划。

**修复建议**：
- 实施定期密钥轮换计划（如每 90 天更换 API 密钥）
- 实现不停机密钥轮换（支持新旧密钥并行有效的过渡期）
- 监控 API 密钥使用量，异常时自动告警

---

## 总结

| 级别 | 数量 | 关键问题 |
|------|------|----------|
| CRITICAL | 3 | API 密钥暴露、弱密码认证、XSS 漏洞 |
| HIGH | 5 | CORS 宽松、/files 无认证、Token URL 传递、无 CSRF、无速率限制 |
| MEDIUM | 12 | WebSocket 超时、Docker 竞态、文件大小限制、Token 过期等 |
| LOW | 3 | 测试覆盖、健康检查、密钥轮换 |
| **合计** | **23 类** | 覆盖安全、稳定性、可维护性三个维度 |

### 优先处理建议

1. **立即处理**（CRITICAL）：轮换所有已暴露的 API 密钥、修复密码存储机制、清理 innerHTML 使用
2. **一周内处理**（HIGH）：修复 CORS 配置、为 /files 添加认证、实施速率限制
3. **两周内处理**（MEDIUM）：添加 Token 过期、Docker 资源限制、文件上传大小限制
4. **持续改进**（LOW）：补充测试覆盖、添加健康检查端点、建立密钥轮换流程
