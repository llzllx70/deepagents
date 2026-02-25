/**
 * popup.js — 扩展弹窗交互逻辑
 *
 * 为 popup.html 提供 UI 交互功能：
 * - 显示/编辑服务端 WebSocket 地址
 * - 手动连接/断开 WebSocket
 * - 绑定当前 tab（attach CDP debugger）
 * - 实时显示连接状态
 *
 * 通过 chrome.runtime.sendMessage 与 background.js 通信，
 * 所有实际逻辑由 background.js 及其子模块执行。
 */

// ── DOM 元素引用 ──────────────────────────────────────────

/** 服务端地址输入框 */
const serverUrlInput = document.getElementById("serverUrl");

/** 连接按钮 */
const connectBtn = document.getElementById("connectBtn");

/** 绑定 Tab 按钮 */
const bindBtn = document.getElementById("bindBtn");

/** 连接状态显示元素 */
const statusEl = document.getElementById("status");

// ── 状态显示 ──────────────────────────────────────────────

/**
 * 更新连接状态显示
 *
 * 设置状态文本，并切换 CSS 类名以控制样式：
 * - connected: true  → 添加 .connected 类（绿色）
 * - connected: false → 添加 .disconnected 类（红色）
 *
 * @param {string}  text      - 显示文本（如 "Connected"、"Disconnected"）
 * @param {boolean} connected - 是否已连接
 */
function setStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.classList.toggle("connected", connected);
  statusEl.classList.toggle("disconnected", !connected);
}

// ── 配置加载 ──────────────────────────────────────────────

/**
 * 从 chrome.storage.local 加载已保存的服务端地址
 *
 * 在 popup 打开时调用，将之前保存的 serverUrl 填入输入框。
 */
async function loadConfig() {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  if (stored.serverUrl) serverUrlInput.value = stored.serverUrl;
}

/**
 * 从当前活跃 tab 自动获取服务端地址
 *
 * 通过 chrome.scripting.executeScript 在页面中执行脚本，
 * 读取 DOM data 属性或 localStorage 中的配置：
 * - data-da-server-ws-base / deepagents_server_ws_base → WebSocket 地址
 * - deepagents_server_url → HTTP 地址（自动推导为 WS 地址）
 *
 * 如果成功获取到 WS 地址，自动填入输入框并保存。
 * 这使得用户在已配置的网页上打开 popup 时，地址会自动填充。
 */
async function autofillFromActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const doc = document.documentElement;
        const get = (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return "";
          }
        };
        const serverWsBase =
          doc?.dataset?.daServerWsBase ||
          get("deepagents_server_ws_base") ||
          "";
        const serverUrl = get("deepagents_server_url");
        return { serverWsBase, serverUrl };
      },
    });
    const payload = results?.[0]?.result;
    if (!payload) return;
    let wsBase = payload.serverWsBase;
    // 从 HTTP 服务端地址推导 WebSocket URL
    if (!wsBase && payload.serverUrl) {
      const protocol = payload.serverUrl.startsWith("https") ? "wss:" : "ws:";
      const host = payload.serverUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      wsBase = `${protocol}//${host}/ws/browser`;
    }
    if (wsBase) {
      serverUrlInput.value = wsBase;
      await chrome.storage.local.set({ serverUrl: wsBase });
    }
  } catch {
    // 脚本注入失败（如 chrome:// 页面），忽略
  }
}

// ── 消息通信 ──────────────────────────────────────────────

/**
 * 向 background.js 发送消息并等待响应
 *
 * 对 chrome.runtime.sendMessage 的 Promise 封装。
 *
 * @param {object} message - 要发送的消息对象
 * @returns {Promise<object>} background.js 的响应
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

/**
 * 刷新连接状态显示
 *
 * 向 background.js 发送 "status" 查询，
 * 根据响应更新 UI 状态。
 */
async function refreshStatus() {
  const response = await sendMessage({ type: "status" });
  if (response && response.connected) {
    setStatus("Connected", true);
  } else {
    setStatus("Disconnected", false);
  }
}

// ── 事件绑定 ──────────────────────────────────────────────

/**
 * 连接按钮点击事件
 *
 * 1. 读取输入框中的服务端地址
 * 2. 保存到 chrome.storage.local
 * 3. 发送 "connect" 消息给 background.js 发起 WebSocket 连接
 * 4. 400ms 后刷新状态显示（等待连接建立）
 */
connectBtn.addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.trim();
  await chrome.storage.local.set({ serverUrl });
  const response = await sendMessage({
    type: "connect",
    serverUrl,
  });
  if (response && response.error) {
    setStatus(`Connect failed: ${response.error}`, false);
    return;
  }
  setStatus("Connecting...", false);
  setTimeout(refreshStatus, 400);
});

/**
 * 绑定 Tab 按钮点击事件
 *
 * 向 background.js 发送 "bind_tab" 消息，
 * 触发对当前活跃 tab 的 CDP debugger attach。
 * attach 后即可执行 CDP 命令（点击、输入、导航等）。
 */
bindBtn.addEventListener("click", async () => {
  await sendMessage({ type: "bind_tab" });
});

// ── 初始化 ────────────────────────────────────────────────

/**
 * popup 打开时的初始化流程：
 * 1. loadConfig — 从存储恢复服务端地址到输入框
 * 2. refreshStatus — 查询并显示当前连接状态
 * 3. autofillFromActiveTab — 尝试从当前页面自动获取配置
 * 4. refreshStatus — 再次刷新（autofill 可能触发了连接）
 */
loadConfig().then(refreshStatus);
autofillFromActiveTab().then(refreshStatus);
