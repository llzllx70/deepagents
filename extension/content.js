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
 *
 * ═══ 注入生命周期 ═══
 *
 * 1. 用户打开任意网页（或 iframe 加载）
 * 2. Chrome 在 document_idle 阶段（DOM 解析完成后）自动注入此脚本
 * 3. 每个 frame 独立运行一份 content.js 实例（互不干扰）
 * 4. 主 frame 的实例额外负责 bridge 配置自动发现
 * 5. 脚本注入后即进入待命状态，等待 background.js 发送 collect_snapshot 消息
 *
 * ═══ 快照采集场景 ═══
 *
 * 场景：Agent 想「看」当前网页
 *   background.js 广播 collect_snapshot → 所有 frame 的 content.js 各自采集
 *   → 主 frame 回传完整快照（page + text + elements）
 *   → 各 iframe 回传 elements（标记 isIframe: true 和 frameUrl）
 *   → background.js 聚合所有数据后发送到 Server
 *
 * ═══ Bridge 自动发现场景 ═══
 *
 * 场景：用户打开 DeepAgents 的 Web 客户端（如 http://localhost:8080）
 *   该页面在 <html> 元素或 localStorage 中设置了 data-da-server-ws-base 和 token
 *   → content.js 读取这些配置 → 发送 bridge_config 到 background.js
 *   → background.js 自动保存并建立 WebSocket 连接
 *   → 用户无需打开 popup 手动输入地址，实现「打开网页即连接」的体验
 *
 * MutationObserver 监听 <html> 属性变化，确保网页动态更新配置时扩展能即时感知。
 * 例如：Web 客户端切换环境/用户时，token 变化 → 自动重新连接。
 */

// ── 内联日志 ─────────────────────────────────────────────
// content script 不支持 ES Module import，内联一个简易 logger
// 日志在目标网页的 F12 → Console 中查看，筛选 "[DA:content]"
const _daLog = {
  _tag: "[DA:content]",
  info(...a)  { console.log(`%c${_daLog._tag}`, "color:#4a9eff", ...a); },
  debug(...a) { console.log(`%c${_daLog._tag}`, "color:#888", ...a); },
  warn(...a)  { console.warn(_daLog._tag, ...a); },
  error(...a) { console.error(_daLog._tag, ...a); },
};

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
 *
 * 为什么 iframe 需要随机前缀？
 * 每个 frame 独立运行 content.js，各自的 idCounter 都从 0 开始。
 * 如果都用 "da-" 前缀，主 frame 和 iframe 会产生相同的 da-id（如 "da-1"）。
 * Agent 发送 click { id: "da-1" } 时会匹配到错误的元素。
 * 随机前缀确保每个 frame 生成的 id 全局唯一。
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
 * 场景：快照只需包含用户能看到的内容。隐藏菜单、折叠面板、屏幕外的元素
 * 不应出现在快照中，否则会干扰 Agent 的判断（Agent 可能尝试点击不可见的元素）。
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
 * 场景：Agent 通过此文本了解页面内容（文章正文、搜索结果、错误提示等），
 * 据此做出语义层面的决策。例如：
 * - 看到 "搜索结果为空" → Agent 决定换一个关键词重新搜索
 * - 看到商品价格和描述 → Agent 决定是否点击「购买」
 *
 * 为什么限制长度？快照数据通过 WebSocket 传输，再由 Agent（LLM）处理。
 * 过大的文本会增加延迟和 token 消耗。compact 模式 8000 字符足以覆盖
 * 大多数页面的关键内容。
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
 * 场景：Agent 通过此列表了解页面上有哪些可以操作的元素。每个元素包含：
 * - id + selector：Agent 发送操作指令时用于定位（如 { target: { id: "da-5" } }）
 * - text / ariaLabel：Agent 理解元素用途的语义信息
 * - rect：元素位置和尺寸，Agent 可选择用坐标直接定位
 * - tag / role / type：元素类型信息，帮助 Agent 判断应该 click 还是 type
 * - value：输入框的当前值，Agent 据此判断是否需要清空再输入
 * - disabled：是否禁用，Agent 不应尝试操作禁用元素
 *
 * data-da-id 的复用机制：同一元素多次采集快照时保持相同的 id，
 * 这样 Agent 对比前后两次快照时能识别出同一个元素。
 *
 * @param {number} limit - 最大采集元素数
 * @returns {Array<{id, tag, role, text, ariaLabel, title, href, type, value, disabled, selector, rect}>}
 */

/**
 * 常见社交/第三方登录的 class name 关键词 → 可读标签映射。
 * 用于 getElementLabel 的 class name 降级阶段，将
 * "weChat-login" 之类的 CSS 类名翻译为 LLM 能理解的中文标签。
 *
 * 匹配逻辑：将 class name 转小写后，检查是否包含（includes）映射表中的 key。
 * key 按从长到短排序，优先匹配更精确的关键词（如 "wechat" 优先于 "we"）。
 */
const CLASS_LABEL_PATTERNS = [
  ["wechat", "微信登录"],
  ["weixin", "微信登录"],
  ["wx-login", "微信登录"],
  ["wx_login", "微信登录"],
  ["dingtalk", "钉钉登录"],
  ["alipay", "支付宝登录"],
  ["zhifubao", "支付宝登录"],
  ["taobao", "淘宝登录"],
  ["weibo", "微博登录"],
  ["sina", "微博登录"],
  ["douyin", "抖音登录"],
  ["tiktok", "TikTok登录"],
  ["apple", "Apple登录"],
  ["google", "Google登录"],
  ["github", "GitHub登录"],
  ["facebook", "Facebook登录"],
  ["twitter", "Twitter登录"],
  ["qq", "QQ登录"],
];

/**
 * 尝试从 class name 中识别常见社交登录模式并返回可读标签。
 * @param {string} cls - 元素的 className 字符串
 * @returns {string} 匹配到的可读标签，或空字符串
 */
function classNameToLabel(cls) {
  if (!cls) return "";
  const lower = cls.toLowerCase();
  for (const [keyword, label] of CLASS_LABEL_PATTERNS) {
    if (lower.includes(keyword)) return label;
  }
  return "";
}

/**
 * 为纯图标元素合成可读标签。
 * 当 innerText 为空时，依次从 aria-label、title、子 <img> alt、
 * aria-labelledby 引用文本、子 <svg><title> 中提取。
 * 最后兜底：从 class name 中识别常见模式（如社交登录图标）。
 */
function getElementLabel(el) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const title = el.getAttribute("title");
  if (title) return title;

  const img = el.querySelector("img");
  if (img && img.alt) return img.alt;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }

  const svgTitle = el.querySelector("svg title");
  if (svgTitle && svgTitle.textContent) return svgTitle.textContent.trim();

  // 兜底：从 class name 提取标签（适用于纯 CSS 图标按钮）
  // 优先尝试识别常见社交登录模式（如 "weChat-login" → "微信登录"），
  // 否则直接返回原始 class name（跳过 Tailwind 等大量工具类）。
  const cls = typeof el.className === "string" ? el.className : "";
  if (cls) {
    const socialLabel = classNameToLabel(cls);
    if (socialLabel) return socialLabel;
    const parts = cls.trim().split(/\s+/).filter((c) => c.length > 1);
    if (parts.length > 0 && parts.length <= 3) {
      return parts.join(" ");
    }
  }

  return "";
}

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
    const rawText = (el.innerText || el.value || "").trim();
    const text = rawText || getElementLabel(el);
    const item = { id: el.dataset.daId, tag: el.tagName.toLowerCase() };
    const role = el.getAttribute("role");
    if (role) item.role = role;
    const trimmedText = text.trim().slice(0, 200);
    if (trimmedText) item.text = trimmedText;
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) item.ariaLabel = ariaLabel;
    const elTitle = el.getAttribute("title");
    if (elTitle) item.title = elTitle;
    const href = el.getAttribute("href");
    if (href) item.href = href;
    const elType = el.getAttribute("type");
    if (elType) item.type = elType;
    if (typeof el.value === "string" && el.value) item.value = el.value.slice(0, 120);
    if (el.disabled === true) item.disabled = true;
    item.selector = `[data-da-id=\"${el.dataset.daId}\"]`;
    item.rect = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    items.push(item);
    if (items.length >= limit) break;
  }

  // 二次扫描：收集 cursor:pointer 的非语义可交互元素
  // 场景：Vue/React 中 <span>/<div> 绑定了 click 事件但没有语义标签和 role，
  //       如搜狐登录页的 <span class="weChat-login"> 图标按钮。
  if (items.length < limit) {
    const pointerCandidates = document.querySelectorAll("div, span, li");
    for (const el of pointerCandidates) {
      if (el.dataset.daId) continue; // 已在第一轮收集
      if (!isVisible(el)) continue;
      if (getComputedStyle(el).cursor !== "pointer") continue;
      // 跳过已收集元素的子元素（如 <button> 内部的 <span>）
      if (el.closest("[data-da-id]")) continue;
      // 跳过包裹已收集元素的容器
      if (el.querySelector("[data-da-id]")) continue;

      const rect = el.getBoundingClientRect();
      const rawText = (el.innerText || "").trim();
      const text = rawText || getElementLabel(el);
      // 无任何可识别文本的元素对 Agent 无意义，跳过
      if (!text) continue;

      el.dataset.daId = nextId();
      const item2 = { id: el.dataset.daId, tag: el.tagName.toLowerCase() };
      const role2 = el.getAttribute("role");
      if (role2) item2.role = role2;
      const trimmedText2 = text.trim().slice(0, 200);
      if (trimmedText2) item2.text = trimmedText2;
      const ariaLabel2 = el.getAttribute("aria-label");
      if (ariaLabel2) item2.ariaLabel = ariaLabel2;
      const elTitle2 = el.getAttribute("title");
      if (elTitle2) item2.title = elTitle2;
      const href2 = el.getAttribute("href");
      if (href2) item2.href = href2;
      const elType2 = el.getAttribute("type");
      if (elType2) item2.type = elType2;
      if (typeof el.value === "string" && el.value) item2.value = el.value.slice(0, 120);
      if (el.disabled === true) item2.disabled = true;
      item2.selector = `[data-da-id=\"${el.dataset.daId}\"]`;
      item2.rect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      items.push(item2);
      if (items.length >= limit) break;
    }
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
    const t0 = performance.now();
    const snapshot = collectSnapshot(message.mode || "compact");
    const ms = (performance.now() - t0).toFixed(1);
    _daLog.info("snapshot collected", {
      mode: message.mode || "compact",
      frame: isIframe ? "iframe" : "main",
      elements: snapshot.elements?.length || 0,
      textLen: snapshot.text?.length || 0,
      ms,
    });
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
 * ═══ 网页端集成方式 ═══
 *
 * 方式 A：HTML 属性（推荐，服务端渲染时直接注入）
 *   <html data-da-server-ws-base="ws://example.com/ws/browser"
 *         data-da-token="user-session-token">
 *
 * 方式 B：localStorage（适合 SPA 动态设置）
 *   localStorage.setItem('deepagents_server_ws_base', 'ws://...');
 *   localStorage.setItem('deepagents_auth_token', 'token...');
 *
 * 方式 C：仅设置 HTTP 地址（自动推导 WS 地址）
 *   localStorage.setItem('deepagents_server_url', 'https://example.com');
 *   → 自动推导为 wss://example.com/ws/browser
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
// 原因：iframe 中的 localStorage 是隔离的（不同源），读不到主页面的配置。
// 且 iframe 不应该触发连接行为（多个 iframe 同时发送 bridge_config 会导致重复连接）。
if (!isIframe) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeBridgeConfig, { once: true });
  } else {
    observeBridgeConfig();
  }
}
