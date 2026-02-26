/**
 * logger.js — 统一日志模块
 *
 * 提供分模块、分级别的日志输出，方便调试扩展各环节。
 *
 * ═══ 使用方式 ═══
 *
 * import { createLogger } from "./logger.js";
 * const log = createLogger("connection");
 * log.info("WebSocket connected", { url });
 * log.error("Connect failed", error);
 *
 * ═══ 查看日志 ═══
 *
 * Service Worker 日志（background.js + lib/*.js）：
 *   chrome://extensions → 找到扩展 → 点击 "Service Worker" 链接 → Console
 *
 * Content Script 日志（content.js）：
 *   目标网页上按 F12 → Console → 筛选 "[DA:"
 *
 * Popup 日志（popup.js）：
 *   右键扩展图标 → "检查弹出内容" → Console
 *
 * ═══ 开关控制 ═══
 *
 * 在 Service Worker Console 中执行：
 *   chrome.storage.local.set({ da_debug: true })   // 开启
 *   chrome.storage.local.set({ da_debug: false })  // 关闭
 *
 * 默认关闭。开启后 debug 级别日志也会输出。
 * info/warn/error 级别始终输出（不受开关影响）。
 */

/** 是否开启 debug 级别输出 */
let debugEnabled = false;

// 启动时从 storage 读取开关状态
try {
  chrome.storage.local.get(["da_debug"], (result) => {
    debugEnabled = !!result?.da_debug;
  });
  // 监听开关变化，实时生效
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.da_debug) {
      debugEnabled = !!changes.da_debug.newValue;
    }
  });
} catch {
  // content script 中 chrome.storage 可能不可用，忽略
}

/**
 * 格式化时间戳 HH:MM:SS.mmm
 */
function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * 创建带模块标签的 logger
 *
 * @param {string} module - 模块名（如 "connection", "actions", "cdp"）
 * @returns {{ debug, info, warn, error }}
 */
export function createLogger(module) {
  const tag = `[DA:${module}]`;

  return {
    /** debug 级别 — 仅在 da_debug=true 时输出 */
    debug(...args) {
      if (!debugEnabled) return;
      console.log(`%c${ts()} ${tag}`, "color:#888", ...args);
    },

    /** info 级别 — 始终输出 */
    info(...args) {
      console.log(`%c${ts()} ${tag}`, "color:#4a9eff", ...args);
    },

    /** warn 级别 — 始终输出 */
    warn(...args) {
      console.warn(`${ts()} ${tag}`, ...args);
    },

    /** error 级别 — 始终输出 */
    error(...args) {
      console.error(`${ts()} ${tag}`, ...args);
    },
  };
}
