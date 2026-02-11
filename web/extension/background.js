const state = {
  serverUrl: "",    // ws://host:port/ws/browser
  token: "",
  ws: null,
  wsUrl: "",        // the URL of the current/last WS connection
  connected: false,
  attachedTabId: null,
  reconnectAttempt: 0,
};

const pendingSnapshot = new Map();
let reconnectTimer = null;
let heartbeatTimer = null;

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function buildWsUrl(serverUrl, token) {
  if (!serverUrl) return "";
  let url = normalizeBaseUrl(serverUrl);
  if (token) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}token=${encodeURIComponent(token)}`;
  }
  return url;
}

function wsSend(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(payload));
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return null;
  return tabs[0].id ?? null;
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      state.attachedTabId = tabId;
      resolve();
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function sendCDP(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function ensureDebugger(tabId) {
  if (state.attachedTabId === tabId) return;
  if (state.attachedTabId != null) {
    await detachDebugger(state.attachedTabId);
  }
  await attachDebugger(tabId);
  await sendCDP(tabId, "Page.enable");
  await sendCDP(tabId, "Runtime.enable");
  await sendCDP(tabId, "DOM.enable");
}

async function sendHello() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const tabId = await getActiveTabId();
  let tabInfo = null;
  if (tabId != null) {
    try {
      tabInfo = await chrome.tabs.get(tabId);
    } catch (error) {
      tabInfo = null;
    }
  }
  wsSend({
    type: "browser.hello",
    protocol_version: 2,
    tab_id: tabId,
    url: tabInfo?.url || null,
    title: tabInfo?.title || null,
    user_agent: navigator.userAgent,
  });
}

// ── Heartbeat ──────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    wsSend({ type: "ping" });
  }, 20000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── WebSocket connect / reconnect ──────────────────────────

async function connectWs(force = false) {
  const wsUrl = buildWsUrl(state.serverUrl, state.token);
  if (!wsUrl) {
    return { error: "Missing serverUrl" };
  }
  // Skip if already connected to the same URL
  if (!force && state.connected && state.wsUrl === wsUrl) {
    return { ok: true, skipped: true };
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {}
  }
  state.wsUrl = wsUrl;
  state.ws = new WebSocket(wsUrl);
  state.ws.onopen = async () => {
    state.connected = true;
    state.reconnectAttempt = 0;
    startHeartbeat();
    await sendHello();
  };
  state.ws.onclose = () => {
    state.connected = false;
    stopHeartbeat();
    scheduleReconnect();
  };
  state.ws.onerror = () => {
    state.connected = false;
    stopHeartbeat();
  };
  state.ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    handleServerMessage(data);
  };
  return { ok: true };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!state.serverUrl) return;
  const delays = [200, 400, 1000, 2000, 5000, 10000, 30000];
  const delay = delays[Math.min(state.reconnectAttempt, delays.length - 1)];
  state.reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

// ── MV3 keepalive via alarms ───────────────────────────────

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && !state.connected) {
    if (state.serverUrl) connectWs();
  }
});

// ── Server message handler ─────────────────────────────────

async function handleServerMessage(data) {
  if (!data || typeof data !== "object") return;
  const type = data.type;
  if (type === "pong") return;

  if (type === "browser.request_snapshot") {
    const requestId = data.request_id || crypto.randomUUID();
    const tabId = data.tab_id ?? (await getActiveTabId());
    requestSnapshotFromTab(requestId, true, data.mode || "compact", tabId);
    return;
  }
  if (type === "browser.action") {
    await handleAction(data);
  }
}

function requestSnapshotFromTab(requestId, sendToServer, mode, tabId) {
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
  pendingSnapshot.set(requestId, { sendToServer, tabId });
  chrome.tabs.sendMessage(
    tabId,
    { type: "collect_snapshot", request_id: requestId, mode },
    () => {
      if (chrome.runtime.lastError) {
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
  );
}

async function handleAction(payload) {
  const tabId = payload.tab_id ?? (await getActiveTabId());
  const actionId = payload.action_id || crypto.randomUUID();
  const response = {
    type: "browser.action.result",
    action_id: actionId,
    tab_id: tabId,
    status: "ok",
  };
  if (tabId == null) {
    response.status = "error";
    response.error = "No active tab";
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
      await performClick(tabId, payload.target);
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
  }

  if (payload.return_snapshot) {
    const snapshotTabId = payload.action === "open" && payload.new_tab !== false ? response.tab_id : tabId;
    // Wait for new tab to finish loading before collecting snapshot
    if (payload.action === "open" && snapshotTabId !== tabId) {
      await waitForTabLoad(snapshotTabId, 8000);
    }
    const snapshot = await getSnapshotOnce(snapshotTabId || tabId, actionId, payload.mode || "compact");
    if (snapshot) response.snapshot = snapshot;
  }
  if (payload.detach_after !== false && state.attachedTabId === tabId) {
    await detachDebugger(tabId);
    state.attachedTabId = null;
  }
  wsSend(response);
}

async function getSnapshotOnce(tabId, requestId, mode) {
  return new Promise((resolve) => {
    pendingSnapshot.set(requestId, { sendToServer: false, resolve, tabId });
    chrome.tabs.sendMessage(tabId, { type: "collect_snapshot", request_id: requestId, mode });
    setTimeout(() => {
      if (pendingSnapshot.has(requestId)) {
        pendingSnapshot.delete(requestId);
        resolve(null);
      }
    }, 3000);
  });
}

async function performClick(tabId, target) {
  const rect = await resolveTargetRect(tabId, target);
  if (!rect) throw new Error("Target not found");
  const x = Math.round(rect.centerX);
  const y = Math.round(rect.centerY);
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

async function performType(tabId, target, text, clearFirst) {
  const selector = target?.selector || (target?.id ? `[data-da-id=\"${target.id}\"]` : null);
  if (!selector) throw new Error("Missing target selector");
  const focusScript = `(() => {\n  const el = document.querySelector(${JSON.stringify(selector)});\n  if (!el) return false;\n  el.focus();\n  if (${clearFirst ? "true" : "false"}) {\n    if (\"value\" in el) el.value = \"\";\n    if (el.isContentEditable) el.innerText = \"\";\n  }\n  return true;\n})()`;
  const result = await sendCDP(tabId, "Runtime.evaluate", { expression: focusScript, returnByValue: true });
  if (!result?.result?.value) throw new Error("Failed to focus target");
  if (text) {
    await sendCDP(tabId, "Input.insertText", { text });
  }
}

async function performScroll(tabId, delta) {
  const script = `window.scrollBy(0, ${Number(delta) || 0});`;
  await sendCDP(tabId, "Runtime.evaluate", { expression: script });
}

async function resolveTargetRect(tabId, target) {
  if (!target) return null;
  if (target.point && typeof target.point.x === "number") {
    return {
      centerX: target.point.x,
      centerY: target.point.y,
    };
  }
  const selector =
    target.selector || (target.id ? `[data-da-id=\"${target.id}\"]` : null);
  if (!selector) return null;
  const script = `(() => {\n  const el = document.querySelector(${JSON.stringify(selector)});\n  if (!el) return null;\n  const rect = el.getBoundingClientRect();\n  return {\n    x: rect.left,\n    y: rect.top,\n    width: rect.width,\n    height: rect.height,\n    centerX: rect.left + rect.width / 2,\n    centerY: rect.top + rect.height / 2\n  };\n})()`;
  const result = await sendCDP(tabId, "Runtime.evaluate", { expression: script, returnByValue: true });
  return result?.result?.value || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small delay for content script injection
        setTimeout(resolve, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Tab lifecycle events ───────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  wsSend({ type: "browser.tab.closed", tab_id: tabId });
  if (state.attachedTabId === tabId) {
    state.attachedTabId = null;
  }
});

// ── Message handler (popup / content script) ───────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source === "content") {
    if (message.type === "snapshot") {
      const requestId = message.request_id;
      const entry = pendingSnapshot.get(requestId);
      pendingSnapshot.delete(requestId);
      if (entry?.resolve) {
        entry.resolve(message.snapshot || null);
      }
      if (entry?.sendToServer) {
        wsSend({
          type: "browser.snapshot",
          request_id: requestId,
          tab_id: entry.tabId,
          snapshot: message.snapshot,
        });
      }
    }
    if (message.type === "bridge_config") {
      const nextServerUrl = message.serverUrl || message.baseUrl || state.serverUrl;
      const nextToken = message.token || state.token;
      const changed =
        nextServerUrl !== state.serverUrl ||
        nextToken !== state.token;
      state.serverUrl = nextServerUrl;
      state.token = nextToken;
      chrome.storage.local.set({
        serverUrl: state.serverUrl,
        token: state.token,
      });
      if (nextServerUrl && nextToken) {
        if (changed) state.reconnectAttempt = 0;
        connectWs(changed);
      }
      return;
    }
    return;
  }

  if (message?.type === "connect") {
    state.serverUrl = message.serverUrl || state.serverUrl;
    state.token = message.token || state.token;
    chrome.storage.local.set({
      serverUrl: state.serverUrl,
      token: state.token,
    });
    state.reconnectAttempt = 0;
    connectWs().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "bind_tab") {
    getActiveTabId().then(async (tabId) => {
      if (tabId != null) {
        try {
          await ensureDebugger(tabId);
        } catch (error) {}
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "status") {
    sendResponse({ connected: state.connected });
    return;
  }
});

// ── Service Worker startup / install ───────────────────────

async function restoreAndConnect() {
  const stored = await chrome.storage.local.get(["serverUrl", "token"]);
  state.serverUrl = stored.serverUrl || "";
  state.token = stored.token || "";
  if (state.serverUrl) {
    connectWs();
  }
}

chrome.runtime.onInstalled.addListener(() => restoreAndConnect());
chrome.runtime.onStartup.addListener(() => restoreAndConnect());
