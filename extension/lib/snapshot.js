/**
 * snapshot.js — 页面快照采集与聚合
 *
 * 通过 content.js 采集页面快照（DOM 结构、文本、元素列表），
 * 支持主 frame + iframe 的多帧聚合。
 *
 * ═══ 快照是什么 ═══
 *
 * 快照是 Agent「看」网页的方式。Agent 不像人类那样看到渲染后的像素，
 * 而是收到一份结构化数据，包含：
 * - page: 页面元信息（URL、标题、视口尺寸、滚动位置）
 * - text: 页面可见文本摘要（最多 8000/20000 字符）
 * - elements: 可交互元素列表（按钮、链接、输入框等，含坐标和属性）
 *
 * Agent 根据这份快照理解页面内容，然后决定下一步操作（点击哪个按钮、填什么文字等）。
 *
 * ═══ 完整采集流程 ═══
 *
 *   Server                background.js            content.js (主 frame)     content.js (iframe)
 *     │                       │                          │                        │
 *     │ request_snapshot      │                          │                        │
 *     │─────────────────────►│                          │                        │
 *     │                       │  collect_snapshot        │                        │
 *     │                       │─────────────────────────►│                        │
 *     │                       │  collect_snapshot        │                        │
 *     │                       │─────────────────────────────────────────────────►│
 *     │                       │                          │                        │
 *     │                       │  snapshot (main)         │                        │
 *     │                       │◄─────────────────────────│                        │
 *     │                       │  snapshot (iframe)       │                        │
 *     │                       │◄────────────────────────────────────────────────│
 *     │                       │                          │                        │
 *     │                       │ [500ms 聚合定时器到期]     │                        │
 *     │                       │ finalizeSnapshot()       │                        │
 *     │  browser.snapshot     │                          │                        │
 *     │◄─────────────────────│                          │                        │
 *
 * ═══ 两种使用场景 ═══
 *
 * 1. 服务端主动请求（requestSnapshotFromTab）：
 *    Agent 需要「看一眼」当前页面 → Server 发送 browser.request_snapshot
 *    → 采集聚合后通过 wsSend 回传 browser.snapshot
 *
 * 2. 操作后附带快照（getSnapshotOnce）：
 *    Agent 执行 click/type/open 操作后，设置 return_snapshot: true
 *    → 操作完成后自动采集一次快照，附在 browser.action.result 中一并返回
 *    → 减少一次请求-响应往返，让 Agent 更快获得操作后的页面状态
 *
 * 依赖：
 *   - state.js      — pendingSnapshot 缓冲区
 *   - connection.js  — wsSend（发送聚合后的快照到服务端）
 */

import { pendingSnapshot } from "./state.js";
import { wsSend } from "./connection.js";
import { createLogger } from "./logger.js";

const log = createLogger("snapshot");

/**
 * 向 content.js 请求页面快照
 *
 * 使用 chrome.tabs.sendMessage 广播到目标 tab 的所有 frame
 * （因 content.js 在 manifest 中配置了 all_frames: true）。
 * 各 frame 的响应通过 chrome.runtime.onMessage 回传到 background.js，
 * 在那里路由到 pendingSnapshot 缓冲区，最终由 finalizeSnapshot 聚合。
 *
 * 场景：Server 发送 browser.request_snapshot 时由 background.js 调用。
 * mode 参数由 Server 决定：
 * - "compact"（默认）：文本 8000 字 / 元素 120 个，适合日常交互和快速感知
 * - "full"：文本 20000 字 / 元素 200 个，适合 Agent 需要详细分析页面时
 *
 * @param {string}      requestId    - 请求唯一标识（用于匹配响应）
 * @param {boolean}     sendToServer - 聚合完成后是否发送到服务端
 * @param {string}      mode         - 快照模式（"compact" | "full"）
 * @param {number|null} tabId        - 目标 tab ID，为 null 时直接报错
 */
export function requestSnapshotFromTab(requestId, sendToServer, mode, tabId) {
  log.info("request", { requestId: requestId.slice(0, 8), mode, tabId });
  if (tabId == null) {
    if (sendToServer) {
      wsSend({
        type: "browser.snapshot",
        request_id: requestId,
        error: "No active tab",
      });
    }
    return;
  }

  // 初始化聚合缓冲区
  // all_frames: true 时，多个 content script 实例会分别响应，
  // 主 frame 快照作为基础，iframe 快照的 elements 合并进来
  pendingSnapshot.set(requestId, {
    sendToServer,
    tabId,
    mode,
    mainSnapshot: null,
    iframeElements: [],
    aggregateTimer: null,
  });

  chrome.tabs.sendMessage(
    tabId,
    { type: "collect_snapshot", request_id: requestId, mode },
    () => {
      if (chrome.runtime.lastError) {
        // 主 frame 发送失败时，如果也没有 iframe 数据，则直接报错
        const entry = pendingSnapshot.get(requestId);
        if (entry && !entry.mainSnapshot && entry.iframeElements.length === 0) {
          pendingSnapshot.delete(requestId);
          if (sendToServer) {
            wsSend({
              type: "browser.snapshot",
              request_id: requestId,
              tab_id: tabId,
              error: chrome.runtime.lastError.message,
            });
          }
        }
      }
    }
  );
}

/**
 * 获取一次性快照（Promise 版本）
 *
 * 不发送到服务端，而是通过 Promise resolve 返回快照数据。
 * 设置 3 秒超时保护：超时后强制聚合当前已收集的数据。
 *
 * 场景：actions.js 中的 handleAction 在执行操作后，如果 payload.return_snapshot
 * 为 true，就调用此函数获取快照，附在 browser.action.result 响应中。
 * 这样 Agent 执行一次操作就能同时拿到操作结果和最新页面状态，
 * 不需要额外发送 request_snapshot 请求，减少一次网络往返。
 *
 * 超时说明：3 秒超时兜底防止某些 iframe 无响应导致 Promise 永远 pending。
 * 超时后会用已收到的部分数据聚合（主 frame 快照 + 已收到的 iframe 数据），
 * 确保至少返回部分结果而非完全失败。
 *
 * @param {number} tabId     - 目标 tab ID
 * @param {string} requestId - 请求唯一标识
 * @param {string} mode      - 快照模式
 * @returns {Promise<object|null>} 聚合后的快照对象，或 null
 */
export async function getSnapshotOnce(tabId, requestId, mode) {
  return new Promise((resolve) => {
    pendingSnapshot.set(requestId, {
      sendToServer: false,
      resolve,
      tabId,
      mode,
      mainSnapshot: null,
      iframeElements: [],
      aggregateTimer: null,
    });
    chrome.tabs.sendMessage(tabId, { type: "collect_snapshot", request_id: requestId, mode });
    // 超时保护：3 秒后强制聚合已收到的数据
    setTimeout(() => {
      if (pendingSnapshot.has(requestId)) {
        finalizeSnapshot(requestId);
      }
    }, 3000);
  });
}

/**
 * 合并主 frame + iframe 快照并完成请求
 *
 * 将 iframeElements 数组合并到主快照的 elements 中，
 * 然后根据请求类型决定：
 * - 调用 resolve（getSnapshotOnce 的 Promise）
 * - 发送到服务端（requestSnapshotFromTab 的请求）
 *
 * 如果主 frame 快照为空，则构造一个空的默认快照结构。
 *
 * 场景：由 background.js 中的聚合定时器（500ms）或 getSnapshotOnce 的超时（3s）触发。
 * 500ms 的聚合窗口是为了等待所有 iframe 响应：
 * - 每次收到一个 frame 的快照数据，定时器重置为 500ms
 * - 如果 500ms 内没有新的 frame 响应到达，说明所有 frame 已响应完毕
 * - 这比固定等待更高效：无 iframe 的页面 500ms 内就完成，多 iframe 页面自动等待更久
 *
 * @param {string} requestId - 请求唯一标识
 */
export function finalizeSnapshot(requestId) {
  const entry = pendingSnapshot.get(requestId);
  if (!entry) return;
  pendingSnapshot.delete(requestId);

  const snapshot = entry.mainSnapshot || { page: {}, text: "", elements: [], ts: Date.now() };
  log.info("finalize", {
    requestId: requestId.slice(0, 8),
    elements: (snapshot.elements?.length || 0),
    iframeElements: entry.iframeElements.length,
    textLen: snapshot.text?.length || 0,
  });
  // 合并 iframe 中采集到的元素，限制总数不超过模式上限
  const elementLimit = entry.mode === "full" ? 200 : 120;
  if (entry.iframeElements.length > 0) {
    const mainElements = snapshot.elements || [];
    const remaining = Math.max(0, elementLimit - mainElements.length);
    const iframeSlice = remaining > 0 ? entry.iframeElements.slice(0, remaining) : [];
    snapshot.elements = mainElements.concat(iframeSlice);
  }

  if (entry.resolve) {
    entry.resolve(snapshot);
  }
  if (entry.sendToServer) {
    wsSend({
      type: "browser.snapshot",
      request_id: requestId,
      tab_id: entry.tabId,
      snapshot,
    });
  }
}
