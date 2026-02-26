/**
 * connection.js — WebSocket 连接管理
 *
 * 负责 WebSocket 的建立、断线重连（指数退避）、心跳保活、
 * 以及初始握手消息发送。所有 WebSocket 生命周期逻辑集中在此模块。
 *
 * ═══ 连接生命周期 ═══
 *
 *   [扩展启动/安装]                [popup 手动]           [网页 bridge 配置]
 *        │                            │                        │
 *        ▼                            ▼                        ▼
 *   restoreAndConnect()          connectWs()              connectWs(changed)
 *        │                            │                        │
 *        └──────────────┬─────────────┘────────────────────────┘
 *                       ▼
 *              new WebSocket(wsUrl)
 *                       │
 *            ┌──────────┼──────────┐
 *            ▼          ▼          ▼
 *         onopen     onerror    onclose
 *            │                     │
 *            ▼                     ▼
 *      startHeartbeat()    scheduleReconnect()
 *      sendHello()         (指数退避 → connectWs)
 *
 * ═══ 典型场景 ═══
 *
 * 场景 1：首次连接
 *   用户安装扩展 → 在 popup 输入 Server 地址 → 点击 Connect
 *   → connectWs() 创建 WebSocket → onopen → sendHello 握手 → 连接就绪
 *
 * 场景 2：自动恢复
 *   浏览器重启 → onStartup 触发 → restoreAndConnect() 从 storage 读取地址
 *   → connectWs() → 自动恢复连接
 *
 * 场景 3：网络波动重连
 *   网络断开 → onclose 触发 → scheduleReconnect() 启动退避定时器
 *   → 200ms 后首次重试 → 失败则 400ms → 1s → ... → 最大 30s 间隔持续重试
 *
 * 场景 4：MV3 Service Worker 休眠恢复
 *   Worker 被浏览器终止 → WebSocket 连接丢失 → alarm 唤醒 Worker
 *   → background.js 检测到未连接 → connectWs() 重建连接
 *
 * 场景 5：切换服务端
 *   用户打开不同环境的 DeepAgents 网页（如从 dev 切到 prod）
 *   → content.js 检测到新的 bridge_config → connectWs(true) 强制重连到新地址
 *
 * 依赖：
 *   - state.js  — 读写全局连接状态
 *   - utils.js  — buildWsUrl / getActiveTabId
 */

import { state } from "./state.js";
import { buildWsUrl, getActiveTabId } from "./utils.js";
import { createLogger } from "./logger.js";

const log = createLogger("ws");

/** 重连定时器 ID（setTimeout 返回值） */
let reconnectTimer = null;

/** 心跳定时器 ID（setInterval 返回值） */
let heartbeatTimer = null;

/**
 * 服务端消息回调
 *
 * 由入口文件 background.js 通过 setMessageHandler() 注册，
 * WebSocket 收到消息后调用此回调进行路由分发。
 * @type {Function|null}
 */
let onServerMessage = null;

/**
 * 注册服务端消息处理函数
 *
 * 由 background.js 在模块加载时调用，将 handleServerMessage 传入。
 * 这样 connection.js 不需要直接依赖 background.js，避免循环依赖。
 *
 * 场景：扩展启动时，background.js 的顶层代码执行 setMessageHandler(handleServerMessage)，
 * 此后所有 WebSocket 收到的消息都会经由 handleServerMessage → 路由到 snapshot/actions 模块。
 *
 * @param {Function} handler - 消息处理回调 (data: object) => void
 */
export function setMessageHandler(handler) {
  onServerMessage = handler;
}

/**
 * 安全发送 JSON 数据到 WebSocket
 *
 * 仅在连接处于 OPEN 状态时发送，否则静默忽略（不报错、不排队）。
 * 所有需要向服务端发送消息的模块都应调用此函数，而非直接操作 state.ws。
 *
 * 调用场景举例：
 * - snapshot 模块聚合完快照后发送 browser.snapshot
 * - actions 模块执行完操作后发送 browser.action.result
 * - 心跳定时器每 20 秒发送 ping
 * - tab 关闭时发送 browser.tab.closed
 *
 * @param {object} payload - 要发送的数据对象（会被 JSON.stringify）
 */
export function wsSend(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  if (payload.type !== "ping") {
    log.debug("send", payload.type, payload);
  }
  state.ws.send(JSON.stringify(payload));
}

/**
 * 建立 WebSocket 连接
 *
 * 流程：
 * 1. 根据 state.serverUrl + state.token 构建完整 URL
 * 2. 如果已连接到相同 URL 且非强制模式，跳过连接
 * 3. 关闭旧连接，创建新 WebSocket 实例
 * 4. 注册 onopen / onclose / onerror / onmessage 回调
 *
 * onopen  → 重置重连计数、启动心跳、发送握手
 * onclose → 标记断连、停止心跳、触发重连调度
 * onerror → 标记断连、停止心跳
 *
 * @param {boolean} force - 是否强制重连（即使 URL 未变化）
 * @returns {Promise<{ok?: boolean, error?: string, skipped?: boolean}>}
 */
export async function connectWs(force = false) {
  const wsUrl = buildWsUrl(state.serverUrl, state.token);
  if (!wsUrl) {
    return { error: "Missing serverUrl" };
  }
  // 已连接到相同 URL 且非强制重连，跳过
  if (!force && state.connected && state.wsUrl === wsUrl) {
    return { ok: true, skipped: true };
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {}
  }
  state.wsUrl = wsUrl;
  state.ws = new WebSocket(wsUrl);

  log.info("connecting", wsUrl.replace(/token=[^&]+/, "token=***"));

  state.ws.onopen = async () => {
    state.connected = true;
    state.reconnectAttempt = 0;
    log.info("connected");
    startHeartbeat();
    await sendHello();
  };

  state.ws.onclose = (e) => {
    state.connected = false;
    log.warn("disconnected", { code: e.code, reason: e.reason });
    stopHeartbeat();
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    state.connected = false;
    log.error("ws error");
    stopHeartbeat();
  };

  state.ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      log.warn("invalid JSON from server", event.data?.slice?.(0, 200));
      return;
    }
    if (data.type !== "pong") {
      log.debug("recv", data.type, data);
    }
    if (onServerMessage) onServerMessage(data);
  };

  return { ok: true };
}

/**
 * 断线重连调度（指数退避）
 *
 * 重连延迟序列：200ms → 400ms → 1s → 2s → 5s → 10s → 30s
 * 每次调用递增 state.reconnectAttempt，超出数组长度时使用最大延迟。
 * 如果已有待执行的重连定时器或 serverUrl 为空，则不调度。
 *
 * 场景：
 * - 网络临时中断：前几次快速重试（200ms/400ms）通常能立即恢复
 * - 服务端重启：中等延迟（1-5s）让服务端有时间完成启动
 * - 长时间网络不可用：最终稳定在 30s 间隔，减少无效连接尝试
 * - 用户手动重连成功时：reconnectAttempt 归零，下次断线从 200ms 开始
 */
export function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!state.serverUrl) return;
  const delays = [200, 400, 1000, 2000, 5000, 10000, 30000];
  const delay = delays[Math.min(state.reconnectAttempt, delays.length - 1)];
  state.reconnectAttempt += 1;
  log.info("reconnect scheduled", { attempt: state.reconnectAttempt, delay: `${delay}ms` });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

/**
 * 从 chrome.storage.local 恢复配置并尝试连接
 *
 * 在 Service Worker 启动 / 扩展安装时调用。
 * 读取之前保存的 serverUrl 和 token，恢复到 state 中，
 * 如果 serverUrl 存在则自动发起 WebSocket 连接。
 */
export async function restoreAndConnect() {
  const stored = await chrome.storage.local.get(["serverUrl", "token"]);
  state.serverUrl = stored.serverUrl || "";
  state.token = stored.token || "";
  if (state.serverUrl) {
    connectWs();
  }
}

/**
 * 发送握手消息（browser.hello）
 *
 * 在 WebSocket 连接建立后立即调用（onopen 回调中），向服务端通报：
 * - protocol_version: 协议版本号（用于服务端兼容性判断）
 * - tab_id / url / title: 当前活跃 tab 信息（让 Agent 知道用户在看什么页面）
 * - user_agent: 浏览器 UA 字符串（便于服务端区分不同浏览器实例）
 *
 * 场景：每次 WebSocket 连接建立（包括首次连接和断线重连），都会发送此消息。
 * 服务端收到后会初始化或恢复对应的浏览器会话。
 */
export async function sendHello() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const tabId = await getActiveTabId();
  let tabInfo = null;
  if (tabId != null) {
    try {
      tabInfo = await chrome.tabs.get(tabId);
    } catch (error) {
      tabInfo = null;
    }
  }
  wsSend({
    type: "browser.hello",
    protocol_version: 2,
    tab_id: tabId,
    url: tabInfo?.url || null,
    title: tabInfo?.title || null,
    user_agent: navigator.userAgent,
  });
}

/**
 * 启动心跳定时器
 *
 * 每 20 秒发送一次 { type: "ping" }，维持 WebSocket 连接活跃。
 * 启动前会先停止已有的心跳定时器（防止重复启动导致多个定时器并行）。
 *
 * 场景：WebSocket 连接建立后自动启动。心跳有两个作用：
 * 1. 防止 WebSocket 因空闲被中间层（Nginx/负载均衡）超时关闭
 * 2. 在 MV3 环境中，定期的发送操作能帮助保持 Service Worker 活跃
 */
export function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    wsSend({ type: "ping" });
  }, 20000);
}

/**
 * 停止心跳定时器
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
