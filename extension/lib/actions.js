/**
 * actions.js — 浏览器操作执行
 *
 * 处理服务端下发的浏览器操作指令，包括：
 * - click:  模拟鼠标点击（支持坐标 / CSS 选择器 / data-da-id / 文本定位）
 * - type:   模拟键盘输入（支持聚焦 + 清空 + 输入）
 * - scroll: 页面滚动
 * - open:   打开 URL（新标签页或当前页导航）
 * - wait:   等待指定时间
 *
 * ═══ Agent 操控浏览器的完整流程 ═══
 *
 * 1. Agent 先请求快照（snapshot），获得页面上所有可交互元素及其 data-da-id
 * 2. Agent 分析快照，决定操作目标（如 "点击 id=da-5 的搜索按钮"）
 * 3. Server 发送 browser.action 指令到扩展
 * 4. 本模块通过 CDP 执行操作，返回结果（可选附带最新快照）
 * 5. Agent 根据结果决定下一步（继续操作 or 完成任务）
 *
 * ═══ 元素定位 4 级降级策略 ═══
 *
 * Agent 发送的 target 可能包含多种定位信息，本模块按以下优先级依次尝试：
 *
 * 级别 1：直接坐标（target.point 或 target.x/y）
 *   场景：Agent 从快照中获取了元素的精确坐标
 *   优点：最快，无需 DOM 查询
 *   缺点：页面滚动或布局变化后坐标可能失效
 *
 * 级别 2：CSS 选择器 / data-da-id（target.selector 或 target.id）
 *   场景：Agent 从快照的 elements 列表中获取了元素的 da-id
 *   优点：比坐标更稳定（DOM 结构未变化即有效）
 *   重试：最多 3 次，间隔 500ms（应对动态渲染页面，元素可能延迟出现）
 *
 * 级别 3：文本内容匹配（target.text）
 *   场景：Agent 根据按钮文字定位（如 "点击文字为'搜索'的按钮"）
 *   优先匹配交互元素（a/button/input/label 等），选择面积最小的匹配项
 *   （面积最小通常意味着最精确，避免匹配到包含该文字的大容器）
 *
 * 级别 4：iframe 内搜索
 *   场景：目标元素在 iframe 中（如嵌入的第三方表单、编辑器等）
 *   通过 CDP 枚举子 frame → 创建隔离世界 → 在每个 frame 中重复级别 2/3 的搜索
 *   找到后将 iframe 内部坐标转换为视口绝对坐标（加上 iframe 偏移量）
 *
 * 依赖：
 *   - state.js      — attachedTabId
 *   - connection.js  — wsSend
 *   - cdp.js         — ensureDebugger / sendCDP / detachDebugger
 *   - snapshot.js    — getSnapshotOnce
 *   - utils.js       — sleep / waitForTabLoad / getActiveTabId
 */

import { state } from "./state.js";
import { wsSend } from "./connection.js";
import { ensureDebugger, sendCDP, detachDebugger } from "./cdp.js";
import { getSnapshotOnce } from "./snapshot.js";
import { sleep, waitForTabLoad, getActiveTabId } from "./utils.js";
import { createLogger } from "./logger.js";

const log = createLogger("action");

// ── 操作入口 ──────────────────────────────────────────────

/**
 * 操作入口路由
 *
 * 解析 payload 中的 action 字段，分发到对应的处理函数。
 * 处理完成后可选：
 * - 附带快照返回（return_snapshot: true）
 * - 断开 debugger（detach_after: true）
 *
 * 场景示例：
 *
 * 1. Agent 让用户搜索关键词：
 *    { action: "click", target: { id: "da-12" } }                   → 点击搜索框
 *    { action: "type", target: { id: "da-12" }, text: "deepagents" } → 输入关键词
 *    { action: "click", target: { text: "搜索" }, return_snapshot: true } → 点击搜索并获取结果快照
 *
 * 2. Agent 打开新页面并查看：
 *    { action: "open", url: "https://example.com", return_snapshot: true }
 *    → 打开新标签页 → 等待加载 → 采集快照一并返回
 *
 * 3. Agent 完成操作后释放浏览器控制：
 *    { action: "click", target: { text: "提交" }, detach_after: true }
 *    → 点击提交按钮 → detach CDP debugger → 浏览器不再显示「调试中」横幅
 *
 * @param {object} payload - 服务端下发的操作指令
 * @param {string} payload.action        - 操作类型（click/type/scroll/open/wait）
 * @param {number} [payload.tab_id]      - 目标 tab（默认当前活跃 tab）
 * @param {string} [payload.action_id]   - 操作唯一标识
 * @param {boolean} [payload.return_snapshot] - 操作后是否返回快照
 * @param {boolean} [payload.detach_after]    - 操作后是否 detach debugger
 */
export async function handleAction(payload) {
  const tabId = payload.tab_id ?? (await getActiveTabId());
  const actionId = payload.action_id || crypto.randomUUID();
  const response = {
    type: "browser.action.result",
    action_id: actionId,
    tab_id: tabId,
    status: "ok",
  };

  log.info(payload.action, { tabId, actionId, target: payload.target, text: payload.text?.slice?.(0, 50) });

  if (tabId == null) {
    response.status = "error";
    response.error = "No active tab";
    log.error("no active tab");
    wsSend(response);
    return;
  }

  try {
    const action = payload.action;
    if (action === "open" && payload.url) {
      const openInNewTab = payload.new_tab !== false;
      if (openInNewTab) {
        const activateTab = payload.activate_tab !== false;
        const newTab = await chrome.tabs.create({ url: payload.url, active: activateTab });
        if (newTab?.id != null) {
          response.tab_id = newTab.id;
          wsSend({
            type: "browser.tab.created",
            tab_id: newTab.id,
            url: payload.url,
            action_id: actionId,
          });
        }
      } else {
        await ensureDebugger(tabId);
        await sendCDP(tabId, "Page.navigate", { url: payload.url });
      }
    } else if (action === "click") {
      await ensureDebugger(tabId);
      await performClick(tabId, payload.target, payload.text);
    } else if (action === "type") {
      await ensureDebugger(tabId);
      await performType(tabId, payload.target, payload.text || "", payload.clear !== false);
    } else if (action === "scroll") {
      await ensureDebugger(tabId);
      await performScroll(tabId, payload.delta || 600);
    } else if (action === "wait") {
      await sleep(payload.wait_ms || 800);
    } else {
      response.status = "error";
      response.error = `Unsupported action: ${action}`;
    }
  } catch (error) {
    response.status = "error";
    response.error = String(error);
    log.error(payload.action, "failed", error);
  }

  // 操作后可选附带快照
  if (payload.return_snapshot) {
    const snapshotTabId = payload.action === "open" && payload.new_tab !== false ? response.tab_id : tabId;
    // 新标签页需要等待加载完成后再采集快照
    if (payload.action === "open" && snapshotTabId !== tabId) {
      await waitForTabLoad(snapshotTabId, 8000);
    }
    const snapshot = await getSnapshotOnce(snapshotTabId || tabId, actionId, payload.mode || "compact");
    if (snapshot) response.snapshot = snapshot;
  }

  // 操作后可选 detach debugger
  if (payload.detach_after === true && state.attachedTabId === tabId) {
    await detachDebugger(tabId);
    state.attachedTabId = null;
  }

  wsSend(response);
}

// ── 鼠标点击 ──────────────────────────────────────────────

/**
 * 模拟鼠标点击
 *
 * 通过 CDP Input.dispatchMouseEvent 发送三个事件：
 * 1. mouseMoved   — 先移动鼠标到目标位置（许多页面需要 hover 事件来触发 UI 状态变化）
 * 2. mousePressed  — 按下左键
 * 3. mouseReleased — 释放左键
 *
 * 为什么需要三个事件而不是一个 click？
 * 现代 Web 框架（React、Vue 等）通常监听 mousedown/mouseup 而非单纯的 click，
 * 且很多 UI 组件依赖 mousemove 来显示 hover 状态或 tooltip。
 * 发送完整的事件序列确保与真实用户行为一致。
 *
 * 场景：Agent 看到快照中有一个「确认」按钮（da-id: "da-8"），
 *       发送 { action: "click", target: { id: "da-8" } }
 *       → resolveTargetRect 通过 4 级策略找到元素中心坐标
 *       → 发送 mouseMoved + mousePressed + mouseReleased 到该坐标
 *
 * @param {number} tabId  - 目标 tab ID
 * @param {object} target - 目标定位信息（selector/id/text/point）
 * @param {string} [text] - 补充文本（当 target 无 text 字段时用于文本定位）
 * @throws {Error} 目标元素未找到时抛出错误（含定位提示信息）
 */
async function performClick(tabId, target, text) {
  if (!target && text) {
    target = { text };
  } else if (target && !target.text && text) {
    target = Object.assign({}, target, { text });
  }
  const rect = await resolveTargetRect(tabId, target);
  if (!rect) {
    const hint = target.id
      ? ` (da-id "${target.id}" may be stale — request a new snapshot)`
      : target.selector
        ? ` (selector "${target.selector}" not found in DOM)`
        : target.text
          ? ` (no visible element with text "${target.text}")`
          : "";
    throw new Error("Target not found" + hint);
  }
  const x = Math.round(rect.centerX);
  const y = Math.round(rect.centerY);

  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

// ── 键盘输入 ──────────────────────────────────────────────

/**
 * 模拟键盘输入
 *
 * 定位并聚焦目标元素后，通过 CDP Input.insertText 输入文本。
 * 聚焦策略（依次尝试，直到成功）：
 * 1. CSS 选择器 / data-da-id 属性定位并 focus
 * 2. 文本内容匹配并 focus
 * 3. iframe 内搜索并 focus
 *
 * 为什么用 Input.insertText 而不是逐字符发送 keyDown/keyUp？
 * insertText 直接插入文本，比模拟键盘事件更稳定：
 * - 不受键盘布局影响（无需处理 shift、IME 等）
 * - 能正确输入中文、日文等非 ASCII 字符
 * - 性能更好（一次调用 vs 每个字符两次调用）
 *
 * 场景：Agent 需要在搜索框中输入关键词
 *   → 先通过 3 级策略聚焦搜索框（focus）
 *   → clearFirst=true 时清空已有内容（避免在原有文字后追加）
 *   → Input.insertText 输入新文本
 *
 * @param {number}  tabId      - 目标 tab ID
 * @param {object}  target     - 目标定位信息
 * @param {string}  text       - 要输入的文本
 * @param {boolean} clearFirst - 输入前是否清空已有内容（value / innerText）
 * @throws {Error} 无法聚焦目标元素时抛出错误
 */
async function performType(tabId, target, text, clearFirst) {
  const selector = target?.selector || (target?.id ? `[data-da-id=\"${target.id}\"]` : null);
  let focused = false;

  // 1) CSS 选择器定位
  if (selector) {
    const focusScript = `(() => {\n  const el = document.querySelector(${JSON.stringify(selector)});\n  if (!el) return false;\n  el.focus();\n  if (${clearFirst ? "true" : "false"}) {\n    if ("value" in el) el.value = "";\n    if (el.isContentEditable) el.innerText = "";\n  }\n  return true;\n})()`;
    const result = await sendCDP(tabId, "Runtime.evaluate", { expression: focusScript, returnByValue: true });
    focused = !!result?.result?.value;
  }

  // 2) 文本内容匹配定位
  if (!focused && target?.text) {
    const focusByTextScript = `(() => {
  const text = ${JSON.stringify(target.text)};
  const tagFilter = ${target.tag ? JSON.stringify(target.tag).toLowerCase() : "null"};
  const candidates = tagFilter
    ? document.querySelectorAll(tagFilter)
    : document.querySelectorAll('input,textarea,select,a,button,label,[role],[contenteditable],span,div');
  for (const el of candidates) {
    if (!el.textContent || !el.textContent.includes(text)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    el.focus();
    if (${clearFirst ? "true" : "false"}) {
      if ("value" in el) el.value = "";
      if (el.isContentEditable) el.innerText = "";
    }
    return true;
  }
  return false;
})()`;
    const result = await sendCDP(tabId, "Runtime.evaluate", { expression: focusByTextScript, returnByValue: true });
    focused = !!result?.result?.value;
  }

  // 3) iframe 内搜索定位
  if (!focused) {
    try {
      const frames = await getChildFrameContexts(tabId);
      for (const frame of frames) {
        if (focused) break;
        if (selector) {
          const script = `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.focus();
  if (${clearFirst ? "true" : "false"}) {
    if ("value" in el) el.value = "";
    if (el.isContentEditable) el.innerText = "";
  }
  return true;
})()`;
          const result = await sendCDP(tabId, "Runtime.evaluate", {
            expression: script,
            contextId: frame.contextId,
            returnByValue: true,
          });
          focused = !!result?.result?.value;
        }
        if (!focused && target?.text) {
          const script = `(() => {
  const text = ${JSON.stringify(target.text)};
  const tagFilter = ${target.tag ? JSON.stringify(target.tag).toLowerCase() : "null"};
  const candidates = tagFilter
    ? document.querySelectorAll(tagFilter)
    : document.querySelectorAll('input,textarea,select,a,button,label,[role],[contenteditable],span,div');
  for (const el of candidates) {
    if (!el.textContent || !el.textContent.includes(text)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    el.focus();
    if (${clearFirst ? "true" : "false"}) {
      if ("value" in el) el.value = "";
      if (el.isContentEditable) el.innerText = "";
    }
    return true;
  }
  return false;
})()`;
          const result = await sendCDP(tabId, "Runtime.evaluate", {
            expression: script,
            contextId: frame.contextId,
            returnByValue: true,
          });
          focused = !!result?.result?.value;
        }
      }
    } catch (e) {
      // iframe 枚举失败，忽略
    }
  }

  if (!focused) throw new Error("Failed to focus target");
  if (text) {
    await sendCDP(tabId, "Input.insertText", { text });
  }
}

// ── 页面滚动 ──────────────────────────────────────────────

/**
 * 页面滚动
 *
 * 通过 Runtime.evaluate 执行 window.scrollBy。
 *
 * 场景：页面内容超出视口，Agent 需要查看更多内容。
 * 典型流程：Agent 看到快照中的文本不完整 → 发送 scroll 操作（delta: 600）
 * → 滚动后再请求新快照 → 获得下一屏内容。
 * 默认 delta=600px 约为半屏幕高度，避免跳过重要内容。
 *
 * @param {number} tabId - 目标 tab ID
 * @param {number} delta - 滚动像素量（正值向下，负值向上）
 */
async function performScroll(tabId, delta) {
  const script = `window.scrollBy(0, ${Number(delta) || 0});`;
  await sendCDP(tabId, "Runtime.evaluate", { expression: script });
}

// ── 元素定位 ──────────────────────────────────────────────

/**
 * 4 级降级元素定位
 *
 * 按优先级依次尝试，返回第一个成功的结果：
 * 1. 直接坐标 — target.point 对象或 target.x / target.y 字段
 * 2. CSS 选择器 — target.selector 或 data-da-id（最多重试 3 次，间隔 500ms）
 * 3. 文本内容匹配 — target.text（最多重试 3 次）
 * 4. iframe 内搜索 — 遍历子 frame 的隔离世界
 *
 * @param {number} tabId  - 目标 tab ID
 * @param {object} target - 定位信息对象
 * @returns {Promise<{centerX: number, centerY: number, x?: number, y?: number, width?: number, height?: number}|null>}
 */
async function resolveTargetRect(tabId, target) {
  if (!target) return null;

  // 1) 直接坐标
  if (target.point && typeof target.point.x === "number") {
    return {
      centerX: target.point.x,
      centerY: target.point.y,
    };
  }
  if (typeof target.x === "number" && typeof target.y === "number") {
    return { centerX: target.x, centerY: target.y };
  }

  // 2) CSS 选择器 / data-da-id 定位（含重试）
  const selector =
    target.selector || (target.id ? `[data-da-id=\"${target.id}\"]` : null);
  if (selector) {
    const selectorScript = `(() => {\n  const el = document.querySelector(${JSON.stringify(selector)});\n  if (!el) return null;\n  const rect = el.getBoundingClientRect();\n  if (rect.width === 0 && rect.height === 0) return null;\n  return {\n    x: rect.left,\n    y: rect.top,\n    width: rect.width,\n    height: rect.height,\n    centerX: rect.left + rect.width / 2,\n    centerY: rect.top + rect.height / 2\n  };\n})()`;
    // 最多重试 3 次，间隔 500ms，应对动态渲染页面
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await sendCDP(tabId, "Runtime.evaluate", { expression: selectorScript, returnByValue: true });
      const rect = result?.result?.value || null;
      if (rect) return rect;
      if (attempt < 2) await sleep(500);
    }
  }

  // 3) 文本内容匹配（含重试）
  if (target.text) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rect = await resolveByText(tabId, target.text, target.tag);
      if (rect) return rect;
      if (attempt < 2) await sleep(500);
    }
  }

  // 4) iframe 内搜索
  try {
    const iframeRect = await resolveTargetRectInFrames(tabId, target);
    if (iframeRect) return iframeRect;
  } catch (e) {
    // CDP frame 枚举失败，忽略
  }

  return null;
}

/**
 * 按文本内容定位元素
 *
 * 遍历候选元素（交互元素 + 常见文本容器），匹配包含指定文本的可见元素。
 * 优先返回最小面积的交互元素（a/button/input/label 等），
 * 其次返回第一个可见的匹配元素。
 *
 * 为什么选「最小面积」？
 * 页面中 "搜索" 这个文本可能同时出现在：
 * - <button>搜索</button>（面积小，是真正的交互目标）
 * - <div class="search-panel">...搜索...</div>（面积大，是包含按钮的容器）
 * 选择最小面积的交互元素能最精确地命中用户期望的目标。
 *
 * 场景：Agent 发送 { action: "click", target: { text: "立即购买" } }
 *       → resolveTargetRect 级别 2（selector）未命中 → 降级到级别 3 调用本函数
 *       → 找到文字包含"立即购买"的最小面积按钮 → 返回其中心坐标
 *
 * @param {number} tabId - 目标 tab ID
 * @param {string} text  - 要匹配的文本内容
 * @param {string} [tag] - 可选的标签名过滤（如 "button"）
 * @returns {Promise<{centerX: number, centerY: number, x: number, y: number, width: number, height: number}|null>}
 */
async function resolveByText(tabId, text, tag) {
  const script = `(() => {
  const text = ${JSON.stringify(text)};
  const tagFilter = ${tag ? JSON.stringify(tag).toLowerCase() : "null"};
  const interactiveTags = new Set(['a','button','input','select','textarea','label','details','summary']);
  const candidates = tagFilter
    ? document.querySelectorAll(tagFilter)
    : document.querySelectorAll('a,button,input,select,textarea,label,[role],span,div,li,td,th,p,h1,h2,h3,h4,h5,h6');
  const LABEL_CLASS_MAP = {
    '微信':'wechat','钉钉':'dingtalk','支付宝':'alipay','淘宝':'taobao',
    '微博':'weibo','抖音':'douyin','QQ':'qq','qq':'qq',
  };
  function matchText(el, t) {
    if (el.textContent && el.textContent.includes(t)) return true;
    if (el.getAttribute('aria-label')?.includes(t)) return true;
    if (el.getAttribute('title')?.includes(t)) return true;
    const img = el.querySelector('img');
    if (img && img.alt && img.alt.includes(t)) return true;
    const cls = el.className;
    if (cls && typeof cls === 'string') {
      if (cls.includes(t)) return true;
      const clsKey = LABEL_CLASS_MAP[t];
      if (clsKey && cls.toLowerCase().includes(clsKey)) return true;
    }
    return false;
  }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    if (rect.bottom < 0 || rect.right < 0) return null;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 };
  }
  let firstVisible = null;
  let bestInteractive = null;
  let bestArea = Infinity;
  for (const el of candidates) {
    if (!matchText(el, text)) continue;
    const r = isVisible(el);
    if (!r) continue;
    if (!firstVisible) firstVisible = r;
    const area = r.width * r.height;
    const tn = el.tagName.toLowerCase();
    if (interactiveTags.has(tn) || el.hasAttribute('role')
        || el.hasAttribute('onclick') || el.closest('a,button,label,[role]')) {
      if (area < bestArea) {
        bestArea = area;
        bestInteractive = r;
      }
    }
  }
  if (bestInteractive) return bestInteractive;
  return firstVisible;
})()`;
  const result = await sendCDP(tabId, "Runtime.evaluate", { expression: script, returnByValue: true });
  return result?.result?.value || null;
}

// ── iframe 内元素定位 ─────────────────────────────────────

/**
 * 获取所有子 iframe 的执行上下文
 *
 * 通过 CDP Page.getFrameTree 枚举子 frame，
 * 为每个有效 frame 创建隔离世界（isolated world）以执行脚本。
 * 同时获取 iframe 元素在主 frame 中的边界矩形（用于坐标变换）。
 *
 * 隔离世界（Isolated World）说明：
 * CDP 的 Runtime.evaluate 默认在页面的主世界中执行，可以访问页面上的 JS 变量。
 * 但对于 iframe，由于跨域限制，不能直接在主 frame 的世界中操作 iframe 内容。
 * 创建隔离世界后，可以在 iframe 的 DOM 环境中执行脚本，同时不受 CSP 限制。
 *
 * 场景：Agent 要点击嵌入在 iframe 中的元素（如第三方支付按钮、嵌入的表单）
 *       → resolveTargetRect 级别 2/3 在主 frame 中未找到
 *       → 降级到级别 4 → getChildFrameContexts 枚举所有 iframe
 *       → 在每个 iframe 中搜索目标元素
 *
 * 跳过的 frame：about:blank、chrome:// 内部页面、无 URL 的 frame。
 *
 * @param {number} tabId - 目标 tab ID
 * @returns {Promise<Array<{frameId: string, contextId: number, url: string, rect: {x, y, width, height}}>>}
 */
export async function getChildFrameContexts(tabId) {
  const tree = await sendCDP(tabId, "Page.getFrameTree");
  const childFrames = tree?.frameTree?.childFrames || [];
  const results = [];

  for (const child of childFrames) {
    const frameId = child.frame?.id;
    const frameUrl = child.frame?.url || "";
    if (!frameId) continue;
    if (!frameUrl || frameUrl === "about:blank" || frameUrl.startsWith("chrome")) continue;

    try {
      const { executionContextId } = await sendCDP(tabId, "Page.createIsolatedWorld", {
        frameId,
        worldName: "deepagents-iframe",
      });

      // 获取 iframe 元素在主 frame 中的边界矩形
      const iframeRectScript = `(() => {
  const targetUrl = ${JSON.stringify(frameUrl)}.replace(/\\/$/, '');
  const frames = document.querySelectorAll('iframe');
  // 第一轮：按 src URL 匹配
  for (const f of frames) {
    try {
      if (!f.src) continue;
      const src = new URL(f.src, location.href).href.replace(/\\/$/, '');
      if (targetUrl === src || targetUrl.startsWith(src) || src.startsWith(targetUrl)) {
        const r = f.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
      }
    } catch(e) {}
  }
  // 兜底：返回第一个可见 iframe
  for (const f of frames) {
    const r = f.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
  }
  return null;
})()`;
      const rectResult = await sendCDP(tabId, "Runtime.evaluate", {
        expression: iframeRectScript,
        returnByValue: true,
      });
      const rect = rectResult?.result?.value || { x: 0, y: 0, width: 0, height: 0 };
      results.push({ frameId, contextId: executionContextId, url: frameUrl, rect });
    } catch (e) {
      // Frame 可能已被销毁，跳过
    }
  }

  return results;
}

/**
 * 在 iframe 内定位元素
 *
 * 遍历所有子 frame，在每个 frame 的隔离世界中依次尝试：
 * 1. CSS 选择器定位
 * 2. 文本内容匹配
 *
 * 找到元素后，将 iframe 内部坐标转换为视口绝对坐标
 * （加上 iframe 元素本身在主 frame 中的偏移量）。
 *
 * 坐标变换说明：
 * iframe 内的元素坐标是相对于 iframe 视口的，而 CDP 的 Input.dispatchMouseEvent
 * 使用的是浏览器视口的绝对坐标。因此需要：
 *   绝对坐标 = iframe 在主 frame 中的偏移(frame.rect.x/y) + 元素在 iframe 内的坐标
 *
 * 返回的 frameContextId / frameId 可用于后续在同一 iframe 中执行脚本
 * （如 performType 的聚焦操作需要在目标 frame 的上下文中执行）。
 *
 * @param {number} tabId  - 目标 tab ID
 * @param {object} target - 定位信息
 * @returns {Promise<{centerX, centerY, x, y, width, height, frameContextId, frameId}|null>}
 */
async function resolveTargetRectInFrames(tabId, target) {
  const selector = target.selector || (target.id ? `[data-da-id="${target.id}"]` : null);
  const frames = await getChildFrameContexts(tabId);

  for (const frame of frames) {
    let elementRect = null;

    // 选择器定位
    if (selector) {
      const script = `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    x: rect.left, y: rect.top,
    width: rect.width, height: rect.height,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2
  };
})()`;
      const result = await sendCDP(tabId, "Runtime.evaluate", {
        expression: script,
        contextId: frame.contextId,
        returnByValue: true,
      });
      elementRect = result?.result?.value || null;
    }

    // 文本内容匹配
    if (!elementRect && target.text) {
      const script = `(() => {
  const text = ${JSON.stringify(target.text)};
  const tagFilter = ${target.tag ? JSON.stringify(target.tag).toLowerCase() : "null"};
  const interactiveTags = new Set(['a','button','input','select','textarea','label','details','summary']);
  const candidates = tagFilter
    ? document.querySelectorAll(tagFilter)
    : document.querySelectorAll('a,button,input,select,textarea,label,[role],span,div,li,td,th,p,h1,h2,h3,h4,h5,h6');
  const LABEL_CLASS_MAP = {
    '微信':'wechat','钉钉':'dingtalk','支付宝':'alipay','淘宝':'taobao',
    '微博':'weibo','抖音':'douyin','QQ':'qq','qq':'qq',
  };
  function matchText(el, t) {
    if (el.textContent && el.textContent.includes(t)) return true;
    if (el.getAttribute('aria-label')?.includes(t)) return true;
    if (el.getAttribute('title')?.includes(t)) return true;
    const img = el.querySelector('img');
    if (img && img.alt && img.alt.includes(t)) return true;
    const cls = el.className;
    if (cls && typeof cls === 'string') {
      if (cls.includes(t)) return true;
      const clsKey = LABEL_CLASS_MAP[t];
      if (clsKey && cls.toLowerCase().includes(clsKey)) return true;
    }
    return false;
  }
  function isVis(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    if (rect.bottom < 0 || rect.right < 0) return null;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 };
  }
  let firstVisible = null;
  let bestInteractive = null;
  let bestArea = Infinity;
  for (const el of candidates) {
    if (!matchText(el, text)) continue;
    const r = isVis(el);
    if (!r) continue;
    if (!firstVisible) firstVisible = r;
    const area = r.width * r.height;
    const tn = el.tagName.toLowerCase();
    if (interactiveTags.has(tn) || el.hasAttribute('role')
        || el.hasAttribute('onclick') || el.closest('a,button,label,[role]')) {
      if (area < bestArea) { bestArea = area; bestInteractive = r; }
    }
  }
  return bestInteractive || firstVisible;
})()`;
      const result = await sendCDP(tabId, "Runtime.evaluate", {
        expression: script,
        contextId: frame.contextId,
        returnByValue: true,
      });
      elementRect = result?.result?.value || null;
    }

    if (elementRect) {
      // 坐标变换：iframe 内部坐标 → 视口绝对坐标
      return {
        x: frame.rect.x + elementRect.x,
        y: frame.rect.y + elementRect.y,
        width: elementRect.width,
        height: elementRect.height,
        centerX: frame.rect.x + elementRect.centerX,
        centerY: frame.rect.y + elementRect.centerY,
        frameContextId: frame.contextId,
        frameId: frame.frameId,
      };
    }
  }

  return null;
}
