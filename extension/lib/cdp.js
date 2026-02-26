/**
 * cdp.js — Chrome DevTools Protocol 操作封装
 *
 * 封装 chrome.debugger API，提供 Promise 化的 CDP 命令接口。
 * 管理 debugger 的 attach / detach 生命周期，确保同一时间
 * 只有一个 tab 被 attach（通过 state.attachedTabId 追踪）。
 *
 * ═══ 为什么需要 CDP ═══
 *
 * content.js 能采集页面信息（快照），但无法真正「操控」页面：
 * - 无法模拟底层鼠标/键盘事件（content script 发出的事件会被标记为 isTrusted: false）
 * - 无法跨域操作 iframe 内的元素
 * - 无法执行页面导航等浏览器级操作
 *
 * CDP（Chrome DevTools Protocol）通过 chrome.debugger API 提供了这些能力：
 * - Input.dispatchMouseEvent / Input.insertText → 模拟真实用户输入
 * - Runtime.evaluate → 在任意 frame 中执行脚本（包括隔离世界）
 * - Page.navigate → 控制页面导航
 * - DOM.enable → 监听 DOM 变化
 *
 * ═══ 典型场景 ═══
 *
 * 场景 1：Agent 想点击页面上的某个按钮
 *   handleAction(click) → ensureDebugger(tabId) → 如果该 tab 未 attach，
 *   先 attach 并启用 Page/Runtime/DOM domain → 然后 sendCDP(Input.dispatchMouseEvent)
 *
 * 场景 2：Agent 操作完成后释放 debugger
 *   handleAction 收到 detach_after: true → detachDebugger(tabId)
 *   释放后浏览器不再显示「正在调试」横幅
 *
 * 场景 3：Agent 切换到另一个 tab 操作
 *   ensureDebugger(newTabId) → 检测到 attachedTabId !== newTabId
 *   → 先 detach 旧 tab → 再 attach 新 tab → 确保同一时间只有一个 tab 被调试
 *
 * 依赖：
 *   - state.js — 读写 attachedTabId
 */

import { state } from "./state.js";
import { createLogger } from "./logger.js";

const log = createLogger("cdp");

// 同步外部触发的 detach（用户点了浏览器横幅的「取消调试」等），
// 防止 attachedTabId 卡在陈旧值导致后续误判“已 attach”。
chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId === state.attachedTabId) {
    state.attachedTabId = null;
  }
});

/**
 * 将 CDP debugger attach 到指定 tab
 *
 * 使用 Chrome Debugger Protocol 1.3 版本。
 * attach 成功后自动更新 state.attachedTabId。
 *
 * 注意：attach 后浏览器会在该 tab 顶部显示「<扩展名> 已开始调试此浏览器」横幅，
 * 用户可以点击「取消」手动 detach。此时 chrome.debugger.onDetach 事件会触发
 * （当前版本未监听此事件，依赖下次 ensureDebugger 时重新 attach）。
 *
 * @param {number} tabId - 目标 tab ID
 * @returns {Promise<void>}
 * @throws {Error} attach 失败时抛出 chrome.runtime.lastError
 */
export function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        log.error("attach failed", tabId, chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      log.info("attached", tabId);
      state.attachedTabId = tabId;
      resolve();
    });
  });
}

/**
 * 从指定 tab detach CDP debugger
 *
 * 不抛出错误，静默完成（即使 tab 已关闭或未 attach）。
 *
 * @param {number} tabId - 目标 tab ID
 * @returns {Promise<void>}
 */
export function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // 消费 lastError，避免出现 "Unchecked runtime.lastError" 控制台噪音。
      void chrome.runtime.lastError;
      log.info("detached", tabId);
      if (state.attachedTabId === tabId) {
        state.attachedTabId = null;
      }
      resolve();
    });
  });
}

/**
 * 发送 CDP 命令到指定 tab
 *
 * 对 chrome.debugger.sendCommand 的 Promise 封装。
 * 必须在 attach 之后才能调用。
 *
 * 调用场景举例：
 * - sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ... })  → 模拟点击
 * - sendCDP(tabId, "Input.insertText", { text: "hello" })                     → 模拟输入
 * - sendCDP(tabId, "Runtime.evaluate", { expression: "..." })                 → 执行 JS 脚本
 * - sendCDP(tabId, "Page.navigate", { url: "https://..." })                   → 页面导航
 * - sendCDP(tabId, "Page.createIsolatedWorld", { frameId: "..." })            → 创建隔离世界
 *
 * @param {number} tabId   - 目标 tab ID（需已 attach）
 * @param {string} method  - CDP 方法名（如 "Page.navigate"、"Runtime.evaluate"）
 * @param {object} params  - CDP 命令参数，默认为空对象
 * @returns {Promise<object>} CDP 命令返回结果
 * @throws {Error} 命令执行失败时抛出 chrome.runtime.lastError
 */
export function sendCDP(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    log.debug("sendCDP", method, params);
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        log.error("CDP error", method, chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

/**
 * 确保 debugger 已 attach 到指定 tab
 *
 * 智能切换逻辑：
 * - 如果已 attach 到同一 tab，直接返回（无操作，幂等调用）
 * - 如果已 attach 到其他 tab，先 detach 再 attach 新 tab
 * - attach 后自动启用 Page、Runtime、DOM 三个 CDP domain，
 *   这些 domain 是后续操作（导航、脚本执行、DOM 查询）的前置条件
 *
 * 场景：这是所有 CDP 操作的前置调用。actions.js 中的 click / type / scroll / open
 * 在执行具体操作前都会先调用 ensureDebugger(tabId)。
 * 由于是幂等的，重复调用同一 tabId 没有副作用。
 *
 * @param {number} tabId - 目标 tab ID
 */
export async function ensureDebugger(tabId) {
  if (state.attachedTabId === tabId) {
    try {
      // 自愈：本地状态显示已 attach，但真实连接可能已被外部 detach。
      await sendCDP(tabId, "Runtime.enable");
      return;
    } catch (error) {
      state.attachedTabId = null;
    }
  }
  if (state.attachedTabId != null) {
    await detachDebugger(state.attachedTabId);
  }
  await attachDebugger(tabId);
  await sendCDP(tabId, "Page.enable");
  await sendCDP(tabId, "Runtime.enable");
  await sendCDP(tabId, "DOM.enable");
}
