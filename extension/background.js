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
 */

import { state, pendingSnapshot } from "./lib/state.js";
import { getActiveTabId } from "./lib/utils.js";
import { wsSend, connectWs, restoreAndConnect, setMessageHandler } from "./lib/connection.js";
import { ensureDebugger } from "./lib/cdp.js";
import { requestSnapshotFromTab, finalizeSnapshot } from "./lib/snapshot.js";
import { handleAction } from "./lib/actions.js";

// ── 注册服务端消息处理回调 ──────────────────────────────────

/**
 * 处理从 WebSocket 收到的服务端消息
 *
 * 根据 data.type 路由到对应模块：
 * - "pong"                    → 忽略（心跳响应）
 * - "browser.request_snapshot" → snapshot 模块
 * - "browser.action"          → actions 模块
 *
 * @param {object} data - JSON.parse 后的消息对象
 */
async function handleServerMessage(data) {
  if (!data || typeof data !== "object") return;
  const type = data.type;
  if (type === "pong") return;

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

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && !state.connected) {
    if (state.serverUrl) connectWs();
  }
});

// ── Tab 生命周期事件 ───────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  wsSend({ type: "browser.tab.closed", tab_id: tabId });
  if (state.attachedTabId === tabId) {
    state.attachedTabId = null;
  }
});

// ── 内部消息路由（popup / content script）──────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── content script 消息 ──
  if (message?.source === "content") {
    // 快照数据回传
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
    if (message.type === "bridge_config") {
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

chrome.runtime.onInstalled.addListener(() => restoreAndConnect());
chrome.runtime.onStartup.addListener(() => restoreAndConnect());
