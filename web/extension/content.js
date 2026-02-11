let idCounter = 0;
let lastConfigSent = '';

function nextId() {
  idCounter += 1;
  return `da-${idCounter}`;
}

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

function collectElements(limit) {
  const selectors =
    "a,button,input,textarea,select,summary,[role='button'],[role='link'],[contenteditable='true']";
  const nodes = Array.from(document.querySelectorAll(selectors));
  const items = [];
  for (const el of nodes) {
    if (!isVisible(el)) continue;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "collect_snapshot") {
    const snapshot = collectSnapshot(message.mode || "compact");
    chrome.runtime.sendMessage({
      source: "content",
      type: "snapshot",
      request_id: message.request_id,
      snapshot,
    });
    sendResponse({ ok: true });
  }
});

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
  // Derive WS URL from HTTP server URL if WS base not explicitly set
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeBridgeConfig, { once: true });
} else {
  observeBridgeConfig();
}
