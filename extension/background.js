/**
 * background.js — Service Worker 入口文件
 *
 * 职责：
 * 1. 导入所有功能模块
 * 2. 注册 Chrome 扩展事件监听器（alarms / tabs / runtime）
 * 3. 路由服务端消息到对应模块
 * 4. 路由内部消息（popup / content script）到对应处理逻辑
 *
 * 不包含具体业务逻辑，只做「胶水」和「路由」。
 *
 * ═══ 整体架构 ═══
 *
 *   ┌────────┐  WebSocket   ┌───────────────┐  chrome.tabs   ┌─────────────┐
 *   │ Server │ ◄──────────► │ background.js │ ◄────────────► │ content.js  │
 *   │(Agent) │              │ (Service Worker│               │(every frame)│
 *   └────────┘              └───────┬───────┘                └─────────────┘
 *                                   │ chrome.runtime
 *                             ┌─────┴─────┐
 *                             │  popup.js │
 *                             │ (弹窗 UI)  │
 *                             └───────────┘
 *
 * ═══ 典型场景 ═══
 *
 * 场景 1：Agent 请求查看网页
 *   Server 发送 browser.request_snapshot → background 路由到 snapshot 模块
 *   → snapshot 模块通知各 frame 的 content.js 采集 DOM 快照
 *   → 聚合后通过 WebSocket 回传给 Server
 *
 * 场景 2：Agent 操控浏览器
 *   Server 发送 browser.action(click/type/scroll/open) → background 路由到 actions 模块
 *   → actions 通过 CDP 在目标 tab 中执行操作 → 结果回传 Server
 *
 * 场景 3：用户从 popup 手动连接
 *   popup 发送 connect 消息 → background 保存配置并建立 WebSocket
 *
 * 场景 4：网页自动配置（Bridge 模式）
 *   content.js 从 DOM/localStorage 读取服务端地址 → 发送 bridge_config
 *   → background 自动保存并建立连接，无需用户手动操作
 *
 * 场景 5：扩展重启 / 安装后自动恢复
 *   onInstalled / onStartup → restoreAndConnect 从 storage 恢复配置 → 自动重连
 *   keepalive alarm 每 24 秒检查连接，防止 MV3 Service Worker 休眠后连接丢失
 */

import { state, pendingSnapshot } from "./lib/state.js";
import { getActiveTabId } from "./lib/utils.js";
import { wsSend, connectWs, restoreAndConnect, setMessageHandler } from "./lib/connection.js";
import { ensureDebugger } from "./lib/cdp.js";
import { requestSnapshotFromTab, finalizeSnapshot } from "./lib/snapshot.js";
import { handleAction } from "./lib/actions.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("bg");

// ── 注册服务端消息处理回调 ──────────────────────────────────

/**
 * 处理从 WebSocket 收到的服务端消息
 *
 * 根据 data.type 路由到对应模块：
 * - "pong"                    → 忽略（心跳响应）
 * - "browser.request_snapshot" → snapshot 模块
 * - "browser.action"          → actions 模块
 *
 * 场景说明：
 * - 当 AI Agent 需要「看一眼」当前网页时，Server 会发送 browser.request_snapshot，
 *   Agent 拿到快照后据此决定下一步操作（点击、输入、滚动等）。
 * - 当 Agent 决定执行浏览器操作（如点击搜索按钮、填写表单）时，
 *   Server 发送 browser.action，payload 中包含具体的 action 类型和目标元素信息。
 *
 * @param {object} data - JSON.parse 后的消息对象
 */
async function handleServerMessage(data) {
  if (!data || typeof data !== "object") return;
  const type = data.type;
  if (type === "pong") return;
  log.debug("server msg", type);

  if (type === "browser.request_snapshot") {
    const requestId = data.request_id || crypto.randomUUID();
    const tabId = data.tab_id ?? (await getActiveTabId());
    requestSnapshotFromTab(requestId, true, data.mode || "compact", tabId);
    return;
  }

  if (type === "browser.action") {
    await handleAction(data);
  }
}

setMessageHandler(handleServerMessage);

// ── MV3 保活：通过 alarms 定时唤醒 ────────────────────────
//
// 场景：Chrome MV3 的 Service Worker 在空闲约 30 秒后会被强制终止。
// 如果此时 WebSocket 连接正常，终止后连接会丢失。当 Service Worker
// 被再次唤醒时（如收到消息），需要重新建立连接。
// 通过 alarms 每 24 秒（0.4 分钟）触发一次唤醒：
// - 如果连接正常：无操作（仅保持 Worker 活跃）
// - 如果连接断开且有 serverUrl：自动重连

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && !state.connected) {
    if (state.serverUrl) connectWs();
  }
});

// ── Tab 生命周期事件 ───────────────────────────────────────
//
// 场景：用户关闭了 Agent 正在操控的 tab。
// 需要做两件事：
// 1. 通知 Server 该 tab 已关闭，Agent 应停止对该 tab 的后续操作
// 2. 如果关闭的是已 attach CDP 的 tab，清除 attachedTabId 状态

chrome.tabs.onRemoved.addListener((tabId) => {
  wsSend({ type: "browser.tab.closed", tab_id: tabId });
  if (state.attachedTabId === tabId) {
    state.attachedTabId = null;
  }
});

// ── 内部消息路由（popup / content script）──────────────────
//
// 处理来自扩展内部两个来源的消息：
// A) content script（source: "content"）：
//    - snapshot：content.js 采集完快照数据后回传（场景：Agent 请求查看页面）
//    - bridge_config：网页中自动发现的服务端配置（场景：用户打开 DeepAgents 网页后自动连接）
// B) popup（无 source 字段，按 type 分发）：
//    - connect：用户在 popup 中点击「Connect」按钮手动连接
//    - bind_tab：用户点击「Bind Active Tab」按钮，对当前 tab attach CDP debugger
//    - status：popup 打开时查询当前连接状态以更新 UI

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── content script 消息 ──
  if (message?.source === "content") {
    // 快照数据回传
    // 场景：Agent 请求快照 → snapshot 模块广播 collect_snapshot
    // → 各 frame 的 content.js 各自回传快照 → 在此汇集到 pendingSnapshot 缓冲区
    if (message.type === "snapshot") {
      const requestId = message.request_id;
      const entry = pendingSnapshot.get(requestId);
      if (!entry) return;

      if (message.isIframe) {
        // 收集 iframe 元素，后续由 finalizeSnapshot 合并
        const iframeElements = (message.snapshot?.elements || []);
        entry.iframeElements.push(...iframeElements);
      } else {
        // 主 frame 快照
        entry.mainSnapshot = message.snapshot || null;
      }

      // 启动/重置聚合定时器——等待所有 frame 响应
      if (entry.aggregateTimer) clearTimeout(entry.aggregateTimer);
      entry.aggregateTimer = setTimeout(() => {
        finalizeSnapshot(requestId);
      }, 500);
    }

    // 从网页注入的 bridge 配置（自动发现服务端地址）
    // 场景：用户访问已部署的 DeepAgents 网页，该网页在 DOM 或 localStorage 中
    // 嵌入了服务端地址和 token。content.js 自动读取这些信息并发送到此处。
    // 效果：用户无需手动在 popup 中填写地址，扩展会自动连接到对应的 Server。
    // 如果地址或 token 发生变化（如用户切换到不同环境的网页），会自动重连。
    if (message.type === "bridge_config") {
      log.info("bridge config received", { serverUrl: message.serverUrl });
      const nextServerUrl = message.serverUrl || message.baseUrl || state.serverUrl;
      const nextToken = message.token || state.token;
      const changed =
        nextServerUrl !== state.serverUrl ||
        nextToken !== state.token;
      state.serverUrl = nextServerUrl;
      state.token = nextToken;
      chrome.storage.local.set({
        serverUrl: state.serverUrl,
        token: state.token,
      });
      if (nextServerUrl && nextToken) {
        if (changed) state.reconnectAttempt = 0;
        connectWs(changed);
      }
      return;
    }
    return;
  }

  // ── popup: 手动连接 ──
  // 场景：用户在 popup 输入框中填写了服务端 WebSocket 地址，点击 Connect 按钮。
  // 保存配置到 chrome.storage（下次重启时自动恢复），然后发起 WebSocket 连接。
  if (message?.type === "connect") {
    state.serverUrl = message.serverUrl || state.serverUrl;
    state.token = message.token || state.token;
    chrome.storage.local.set({
      serverUrl: state.serverUrl,
      token: state.token,
    });
    state.reconnectAttempt = 0;
    connectWs().then((result) => sendResponse(result));
    return true;
  }

  // ── popup: 绑定当前 tab ──
  // 场景：用户希望让 Agent 操控当前浏览的网页。点击 Bind Active Tab 后，
  // 扩展会对该 tab attach CDP debugger，之后 Agent 就可以通过 CDP 命令
  // 在该 tab 中执行点击、输入、导航等操作。
  // 注：如果 Agent 发送 browser.action 时目标 tab 尚未 attach，
  //     actions 模块会自动调用 ensureDebugger，所以此按钮是「提前绑定」的快捷方式。
  if (message?.type === "bind_tab") {
    getActiveTabId().then(async (tabId) => {
      if (tabId != null) {
        try {
          await ensureDebugger(tabId);
        } catch (error) {}
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── popup: 查询连接状态 ──
  if (message?.type === "status") {
    sendResponse({ connected: state.connected });
    return;
  }
});

// ── Service Worker 启动 / 安装 ────────────────────────────
//
// 场景：
// - onInstalled：扩展首次安装或更新后触发，恢复之前保存的配置并自动连接
// - onStartup：浏览器启动时触发（如果扩展已安装），同样恢复配置并连接
// 两者确保无论是首次安装、扩展更新还是浏览器重启，都能自动恢复 WebSocket 连接

chrome.runtime.onInstalled.addListener(() => {
  log.info("extension installed/updated");
  restoreAndConnect();
});
chrome.runtime.onStartup.addListener(() => {
  log.info("browser startup");
  restoreAndConnect();
});
