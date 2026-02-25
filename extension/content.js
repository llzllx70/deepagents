/**
 * content.js — 页面内容脚本
 *
 * 注入到所有页面的所有 frame 中（manifest 配置 all_frames: true），
 * 负责两项核心功能：
 *
 * 1. **页面快照采集**
 *    接收 background.js 的 "collect_snapshot" 消息，采集当前页面的：
 *    - 可见文本（extractVisibleText）
 *    - 可交互元素列表（collectElements）
 *    - 页面元信息（URL、标题、视口、滚动位置）
 *    采集完成后通过 chrome.runtime.sendMessage 回传给 background.js。
 *    主 frame 和 iframe 分别回传，由 background.js 的 snapshot 模块聚合。
 *
 * 2. **Bridge 配置自动发现**（仅主 frame）
 *    从 DOM data 属性或 localStorage 中读取服务端地址和 token，
 *    自动推送给 background.js，实现免手动配置的自动连接。
 */

// ── 元素 ID 管理 ──────────────────────────────────────────

/**
 * 自增 ID 计数器
 * 用于为可交互元素生成唯一的 data-da-id 属性值。
 */
let idCounter = 0;

/**
 * 上一次发送的 bridge 配置签名
 * 格式："serverUrl|token"，用于去重，避免重复发送相同配置。
 */
let lastConfigSent = '';

/**
 * 当前脚本是否运行在 iframe 中
 * iframe 中的 content script 只负责快照采集，不参与 bridge 配置管理。
 */
const isIframe = window !== window.top;

/**
 * 元素 ID 前缀
 * 主 frame 使用 "da-" 前缀，iframe 使用随机前缀（如 "da-f3k7-"），
 * 避免多 frame 间 da-id 冲突。
 */
const idPrefix = isIframe ? `da-f${Math.random().toString(36).slice(2, 6)}-` : 'da-';

/**
 * 生成下一个唯一元素 ID
 * @returns {string} 格式如 "da-1"（主 frame）或 "da-f3k7-1"（iframe）
 */
function nextId() {
  idCounter += 1;
  return `${idPrefix}${idCounter}`;
}

// ── 可见性判断 ────────────────────────────────────────────

/**
 * 判断 DOM 元素是否可见
 *
 * 检查条件（任一不满足即不可见）：
 * - display !== "none"
 * - visibility !== "hidden"
 * - opacity !== "0"
 * - 宽高 > 0
 * - 不在视口上方/左方（rect.bottom >= 0 且 rect.right >= 0）
 * - 不在视口下方/右方（rect.top <= innerHeight 且 rect.left <= innerWidth）
 *
 * @param {Element} element - 要检查的 DOM 元素
 * @returns {boolean}
 */
function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
  return true;
}

// ── 可见文本提取 ──────────────────────────────────────────

/**
 * 提取页面中所有可见文本
 *
 * 使用 TreeWalker 遍历 DOM 树中的文本节点，
 * 只收集父元素可见的文本内容。
 * 文本以空格连接，总长度不超过 limit。
 *
 * @param {number} limit - 最大字符数
 * @returns {string} 拼接后的可见文本
 */
function extractVisibleText(limit) {
  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        if (!isVisible(node.parentElement)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent?.trim() || "";
        if (!text) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  const parts = [];
  let total = 0;
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    if (!text) continue;
    const nextTotal = total + text.length + 1;
    if (nextTotal > limit) {
      parts.push(text.slice(0, Math.max(0, limit - total)));
      break;
    }
    parts.push(text);
    total = nextTotal;
  }
  return parts.join(" ");
}

// ── 可交互元素采集 ────────────────────────────────────────

/**
 * 采集页面中所有可见的可交互元素
 *
 * 目标元素：a / button / input / textarea / select / summary /
 *          [role='button'] / [role='link'] / [contenteditable='true']
 *
 * 为每个元素分配唯一的 data-da-id（如已有则复用），
 * 返回包含定位信息、文本、属性等的元素描述数组。
 *
 * @param {number} limit - 最大采集元素数
 * @returns {Array<{id, tag, role, text, ariaLabel, href, type, value, disabled, selector, rect}>}
 */
function collectElements(limit) {
  const selectors =
    "a,button,input,textarea,select,summary,[role='button'],[role='link'],[contenteditable='true']";
  const nodes = Array.from(document.querySelectorAll(selectors));
  const items = [];
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    // 分配或复用 data-da-id
    if (!el.dataset.daId) {
      el.dataset.daId = nextId();
    }
    const rect = el.getBoundingClientRect();
    const text = el.innerText || el.value || "";
    items.push({
      id: el.dataset.daId,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      text: text.trim().slice(0, 200),
      ariaLabel: el.getAttribute("aria-label"),
      href: el.getAttribute("href"),
      type: el.getAttribute("type"),
      value: typeof el.value === "string" ? el.value.slice(0, 120) : null,
      disabled: el.disabled === true,
      selector: `[data-da-id=\"${el.dataset.daId}\"]`,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
    if (items.length >= limit) break;
  }
  return items;
}

// ── 快照采集 ──────────────────────────────────────────────

/**
 * 采集完整页面快照
 *
 * 根据 mode 控制采集量：
 * - "compact": 文本 8000 字符 / 元素 120 个（默认，适合常规交互）
 * - "full":    文本 20000 字符 / 元素 200 个（详细模式）
 *
 * 返回结构：
 * {
 *   page: { url, title, lang, viewport, scroll },
 *   text: string,       — 可见文本摘要
 *   elements: Array,    — 可交互元素列表
 *   ts: number          — 采集时间戳（毫秒）
 * }
 *
 * @param {string} mode - 采集模式 "compact" | "full"
 * @returns {object} 快照数据对象
 */
function collectSnapshot(mode) {
  const textLimit = mode === "full" ? 20000 : 8000;
  const elementLimit = mode === "full" ? 200 : 120;
  const page = {
    url: location.href,
    title: document.title,
    lang: document.documentElement?.lang || null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      width: document.documentElement?.scrollWidth || 0,
      height: document.documentElement?.scrollHeight || 0,
    },
  };
  return {
    page,
    text: extractVisibleText(textLimit),
    elements: collectElements(elementLimit),
    ts: Date.now(),
  };
}

// ── 消息监听：快照请求 ────────────────────────────────────

/**
 * 监听来自 background.js 的消息
 *
 * 处理 "collect_snapshot" 消息：
 * 1. 调用 collectSnapshot 采集当前 frame 的快照
 * 2. 如果是 iframe，为每个元素添加 frame 字段（标记来源 URL）
 * 3. 通过 chrome.runtime.sendMessage 回传给 background.js
 *    - 主 frame 快照：{ source: "content", type: "snapshot", snapshot }
 *    - iframe 快照：  额外标记 isIframe: true 和 frameUrl
 * 4. background.js 的 snapshot 模块负责聚合所有 frame 的数据
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "collect_snapshot") {
    const snapshot = collectSnapshot(message.mode || "compact");
    if (isIframe) {
      // iframe 快照：为元素标记来源 URL，便于 agent 区分元素所在 frame
      const frameUrl = location.href;
      for (const el of snapshot.elements) {
        el.frame = frameUrl;
      }
      chrome.runtime.sendMessage({
        source: "content",
        type: "snapshot",
        request_id: message.request_id,
        snapshot,
        isIframe: true,
        frameUrl,
      });
    } else {
      // 主 frame 快照
      chrome.runtime.sendMessage({
        source: "content",
        type: "snapshot",
        request_id: message.request_id,
        snapshot,
      });
    }
    sendResponse({ ok: true });
  }
});

// ── Bridge 配置自动发现（仅主 frame）─────────────────────

/**
 * 从页面中读取 Bridge 配置
 *
 * 配置来源（按优先级）：
 * 1. DOM data 属性：data-da-server-ws-base / data-da-token
 * 2. localStorage：deepagents_server_ws_base / deepagents_auth_token
 * 3. 从 HTTP URL 推导 WS URL：deepagents_server_url → ws(s)://host/ws/browser
 *
 * 这使得网页可以通过设置 DOM 属性或 localStorage 来自动配置扩展，
 * 用户无需手动在 popup 中输入服务端地址。
 *
 * @returns {{serverUrl: string, token: string}}
 */
function readBridgeConfig() {
  const doc = document.documentElement;
  const get = (key) => {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  };
  let serverUrl =
    doc?.dataset?.daServerWsBase ||
    get('deepagents_server_ws_base') ||
    '';
  // 从 HTTP 服务端地址推导 WebSocket URL
  if (!serverUrl) {
    const httpUrl = get('deepagents_server_url');
    if (httpUrl) {
      const protocol = httpUrl.startsWith('https') ? 'wss:' : 'ws:';
      const host = httpUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      serverUrl = `${protocol}//${host}/ws/browser`;
    }
  }
  const token = doc?.dataset?.daToken || get('deepagents_auth_token') || '';
  return { serverUrl, token };
}

/**
 * 发送 Bridge 配置到 background.js
 *
 * 读取当前页面的配置信息，与上次发送的做去重比较，
 * 仅在配置变化时才发送，避免重复触发重连。
 */
function sendBridgeConfig() {
  const { serverUrl, token } = readBridgeConfig();
  if (!serverUrl && !token) return;
  const signature = `${serverUrl}|${token}`;
  if (signature === lastConfigSent) return;
  lastConfigSent = signature;
  chrome.runtime.sendMessage({
    source: 'content',
    type: 'bridge_config',
    serverUrl,
    token,
  });
}

/**
 * 观察 Bridge 配置变化
 *
 * 使用 MutationObserver 监听 <html> 元素的 data 属性变化
 * （data-da-server-ws-base 和 data-da-token），
 * 属性变化时自动重新发送配置。
 * 初始化时也立即发送一次当前配置。
 */
function observeBridgeConfig() {
  const target = document.documentElement;
  if (!target) return;
  const observer = new MutationObserver(() => sendBridgeConfig());
  observer.observe(target, {
    attributes: true,
    attributeFilter: ['data-da-server-ws-base', 'data-da-token'],
  });
  sendBridgeConfig();
}

// 仅主 frame 管理 bridge 配置 — iframe 只提供快照数据
if (!isIframe) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeBridgeConfig, { once: true });
  } else {
    observeBridgeConfig();
  }
}
