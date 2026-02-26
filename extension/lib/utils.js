/**
 * utils.js — 工具函数
 *
 * 通用辅助函数集合，不依赖任何其他模块（依赖图中的叶子节点）。
 * 提供定时等待、Tab 加载监听、URL 处理等基础能力。
 *
 * 这些函数被多个模块复用：
 * - sleep        → actions.js（操作间等待、重试间隔）
 * - waitForTabLoad → actions.js（open 操作后等待页面加载完成再采集快照）
 * - getActiveTabId → background.js / connection.js / actions.js（获取当前 tab）
 * - buildWsUrl   → connection.js（构建 WebSocket 连接 URL）
 */

/**
 * Promise 化的定时等待
 *
 * 场景：actions.js 中元素定位重试间隔（500ms）、wait 操作的等待时间
 *
 * @param {number} ms - 等待毫秒数
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待指定 tab 加载完成（status === "complete"）
 *
 * 内部通过 chrome.tabs.onUpdated 监听 tab 状态变化，
 * 当目标 tab 的 status 变为 "complete" 时 resolve。
 * 超过 timeoutMs 后自动 resolve（不 reject），防止无限等待。
 * 加载完成后额外等待 300ms，确保 content script 已注入。
 *
 * 场景：Agent 执行 open 操作（打开新标签页或导航）后，需要等待页面加载完成
 * 才能采集快照。如果不等待，快照可能抓到空白页或加载中的中间态。
 * 额外的 300ms 延迟是因为 Chrome 的 content_scripts 注入发生在 document_idle 阶段，
 * status === "complete" 时 content.js 可能尚未注入完毕。
 *
 * @param {number} tabId     - 目标 tab ID
 * @param {number} timeoutMs - 超时时间，默认 8000ms
 * @returns {Promise<void>}
 */
export function waitForTabLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // 等待 content script 注入
        setTimeout(resolve, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 获取当前活跃 tab 的 ID
 *
 * 查询当前窗口中处于 active 状态的 tab，
 * 如果没有活跃 tab 则返回 null。
 *
 * 场景：当 Agent 发送的操作指令未指定 tab_id 时，默认使用当前活跃 tab。
 * 也用于 WebSocket 握手时上报当前 tab 信息。
 *
 * @returns {Promise<number|null>}
 */
export async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return null;
  return tabs[0].id ?? null;
}

/**
 * 去除 URL 尾部斜杠
 *
 * @param {string} value - 原始 URL
 * @returns {string} 去除尾部 / 后的 URL
 */
export function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

/**
 * 拼接 WebSocket 连接 URL
 *
 * 将 serverUrl 和 token 组合为带查询参数的完整 URL。
 * 如果 URL 中已有查询参数，使用 & 分隔；否则使用 ?。
 *
 * 场景：connectWs() 调用此函数构建最终的 WebSocket URL。
 * 示例：buildWsUrl("ws://localhost:8000/ws/browser", "abc123")
 *       → "ws://localhost:8000/ws/browser?token=abc123"
 *
 * @param {string} serverUrl - 服务端基地址
 * @param {string} token     - 鉴权 token
 * @returns {string} 完整的 WebSocket URL，serverUrl 为空时返回空字符串
 */
export function buildWsUrl(serverUrl, token) {
  if (!serverUrl) return "";
  let url = normalizeBaseUrl(serverUrl);
  if (token) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}token=${encodeURIComponent(token)}`;
  }
  return url;
}
