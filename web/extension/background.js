const state = {
  baseUrl: "",
  sessionId: "",
  token: "",
  ws: null,
  connected: false,
  tabId: null,
  attachedTabId: null,
};

const pendingSnapshot = new Map();
let reconnectTimer = null;

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function buildWsUrl(baseUrl, sessionId, token) {
  if (!baseUrl || !sessionId) return "";
  let url = baseUrl;
  if (url.includes("{session_id}")) {
    url = url.replace("{session_id}", sessionId);
  } else if (!url.endsWith(`/${sessionId}`)) {
    url = `${normalizeBaseUrl(url)}/${sessionId}`;
  }
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

async function ensureTab() {
  if (state.tabId == null) {
    state.tabId = await getActiveTabId();
  }
  return state.tabId;
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
  const tabId = await ensureTab();
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
    session_id: state.sessionId,
    tab_id: tabId,
    url: tabInfo?.url || null,
    title: tabInfo?.title || null,
    user_agent: navigator.userAgent,
  });
}

async function connectWs() {
  const wsUrl = buildWsUrl(state.baseUrl, state.sessionId, state.token);
  if (!wsUrl) {
    return { error: "Missing baseUrl or sessionId" };
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {}
  }
  state.ws = new WebSocket(wsUrl);
  state.ws.onopen = async () => {
    state.connected = true;
    await ensureTab();
    await sendHello();
  };
  state.ws.onclose = () => {
    state.connected = false;
  };
  state.ws.onerror = () => {
    state.connected = false;
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.baseUrl && state.sessionId) {
      connectWs();
    }
  }, 200);
}

async function handleServerMessage(data) {
  if (!data || typeof data !== "object") return;
  const type = data.type;
  if (type === "browser.request_snapshot") {
    const requestId = data.request_id || crypto.randomUUID();
    requestSnapshotFromTab(requestId, true, data.mode || "compact");
    return;
  }
  if (type === "browser.action") {
    await handleAction(data);
  }
}

function requestSnapshotFromTab(requestId, sendToServer, mode) {
  ensureTab().then((tabId) => {
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
    pendingSnapshot.set(requestId, { sendToServer });
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
              error: chrome.runtime.lastError.message,
            });
          }
        }
      }
    );
  });
}

async function handleAction(payload) {
  const tabId = await ensureTab();
  const actionId = payload.action_id || crypto.randomUUID();
  const response = {
    type: "browser.action.result",
    action_id: actionId,
    status: "ok",
  };
  if (tabId == null) {
    response.status = "error";
    response.error = "No active tab";
    wsSend(response);
    return;
  }
  try {
    await ensureDebugger(tabId);
    const action = payload.action;
    if (action === "open" && payload.url) {
      const openInNewTab = payload.new_tab !== false;
      if (openInNewTab) {
        const activateTab = payload.activate_tab === true;
        const newTab = await chrome.tabs.create({ url: payload.url, active: activateTab });
        if (newTab?.id != null) {
          state.tabId = newTab.id;
        }
      } else {
        await sendCDP(tabId, "Page.navigate", { url: payload.url });
      }
    } else if (action === "click") {
      await performClick(tabId, payload.target);
    } else if (action === "type") {
      await performType(tabId, payload.target, payload.text || "", payload.clear !== false);
    } else if (action === "scroll") {
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
    const snapshot = await getSnapshotOnce(tabId, actionId, payload.mode || "compact");
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
    pendingSnapshot.set(requestId, { sendToServer: false, resolve });
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
          snapshot: message.snapshot,
        });
      }
    }
    if (message.type === "bridge_config") {
      const nextBaseUrl = message.baseUrl || state.baseUrl;
      const nextSessionId = message.sessionId || state.sessionId;
      const nextToken = message.token || state.token;
      const changed =
        nextBaseUrl !== state.baseUrl ||
        nextSessionId !== state.sessionId ||
        nextToken !== state.token;
      state.baseUrl = nextBaseUrl;
      state.sessionId = nextSessionId;
      state.token = nextToken;
      chrome.storage.local.set({
        baseUrl: state.baseUrl,
        sessionId: state.sessionId,
        token: state.token,
      });
      if (changed) {
        scheduleReconnect();
      }
      return;
    }
    return;
  }

  if (message?.type === "connect") {
    state.baseUrl = message.baseUrl || state.baseUrl;
    state.sessionId = message.sessionId || state.sessionId;
    state.token = message.token || state.token;
    chrome.storage.local.set({
      baseUrl: state.baseUrl,
      sessionId: state.sessionId,
      token: state.token,
    });
    connectWs().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "bind_tab") {
    getActiveTabId().then(async (tabId) => {
      state.tabId = tabId;
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

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["baseUrl", "sessionId", "token"]);
  state.baseUrl = stored.baseUrl || "";
  state.sessionId = stored.sessionId || "";
  state.token = stored.token || "";
});
