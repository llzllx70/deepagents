/**
 * state.js — 共享状态对象
 *
 * 所有模块共享的运行时状态，包括 WebSocket 连接信息、
 * 已绑定的 Tab 信息、以及快照聚合缓冲区。
 * 此模块不依赖任何其他模块，作为整个扩展的状态中枢。
 *
 * ═══ 设计说明 ═══
 *
 * 为什么用共享对象而非 chrome.storage？
 * - state 是纯内存状态，随 Service Worker 生命周期存在
 * - 读写同步、无需 await，适合高频访问的连接状态和定时器引用
 * - 持久化数据（serverUrl / token）另外存储在 chrome.storage.local 中，
 *   Service Worker 重启时通过 restoreAndConnect() 恢复到 state
 *
 * 为什么用 Map 做 pendingSnapshot？
 * - 同一时间可能有多个快照请求并行（Agent 连续发送 request_snapshot）
 * - 每个请求有唯一 requestId，Map 提供 O(1) 查找
 * - 请求完成后立即 delete，不会无限增长
 */

/**
 * 全局运行时状态
 *
 * @property {string}  serverUrl        - WebSocket 服务端地址（如 ws://host:port/ws/browser）
 *   写入场景：popup 手动输入 / bridge_config 自动发现 / restoreAndConnect 从 storage 恢复
 * @property {string}  token            - 鉴权 token
 *   写入场景：同 serverUrl，token 与 serverUrl 总是成对更新
 * @property {WebSocket|null} ws        - 当前 WebSocket 实例
 *   写入场景：connectWs() 创建新连接时赋值，旧连接会先 close()
 * @property {string}  wsUrl            - 当前/上一次 WS 连接的完整 URL（含 token 参数）
 *   用途：connectWs() 中用于判断是否需要重新连接（URL 未变化时跳过）
 * @property {boolean} connected        - 是否已连接
 *   读取场景：popup 查询状态 / alarm 判断是否需要重连 / wsSend 前检查
 * @property {number|null} attachedTabId - 当前已 attach CDP debugger 的 tab ID
 *   同一时间只能 attach 一个 tab。ensureDebugger() 切换 tab 时先 detach 旧的。
 *   写入场景：attachDebugger 成功后设置 / detachDebugger 后清空 / tab 关闭时清空
 * @property {number}  reconnectAttempt - 断线重连计数（用于指数退避延迟计算）
 *   场景：每次 scheduleReconnect 递增，连接成功或手动重连时归零
 */
export const state = {
  serverUrl: "",
  token: "",
  ws: null,
  wsUrl: "",
  connected: false,
  attachedTabId: null,
  reconnectAttempt: 0,
};

/**
 * 快照聚合缓冲区
 *
 * key:   requestId (string)
 * value: {
 *   sendToServer: boolean,       - 聚合完成后是否发送到服务端
 *   tabId: number,               - 来源 tab ID
 *   mainSnapshot: object|null,   - 主 frame 快照数据
 *   iframeElements: Array,       - 各 iframe 中采集到的元素列表
 *   aggregateTimer: number|null, - 聚合定时器 ID
 *   resolve?: Function,          - getSnapshotOnce 的 Promise resolve 回调
 * }
 *
 * ═══ 聚合流程 ═══
 *
 * 一个页面可能包含多个 iframe，每个 frame 中的 content.js 独立运行、独立回传快照。
 * 聚合缓冲区的作用是等待所有 frame 响应后，将数据合并为一份完整快照。
 *
 * 时序：
 *   requestSnapshotFromTab(requestId)
 *     → pendingSnapshot.set(requestId, { ... })    // 创建缓冲区条目
 *     → 广播 collect_snapshot 给所有 frame
 *     → 主 frame 回传 → entry.mainSnapshot = data
 *     → iframe 1 回传 → entry.iframeElements.push(...)
 *     → iframe 2 回传 → entry.iframeElements.push(...)
 *     → 每次收到响应重置 500ms 聚合定时器
 *     → 定时器到期 → finalizeSnapshot(requestId)
 *     → 合并数据 → 发送到服务端或 resolve Promise
 *     → pendingSnapshot.delete(requestId)
 *
 * 使用场景：
 * - 服务端主动请求快照（sendToServer: true）→ 聚合后通过 wsSend 回传
 * - actions 执行后附带快照（sendToServer: false, resolve 存在）→ 聚合后 resolve Promise
 */
export const pendingSnapshot = new Map();
