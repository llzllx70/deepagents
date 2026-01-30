const baseUrlInput = document.getElementById("baseUrl");
const sessionIdInput = document.getElementById("sessionId");
const tokenInput = document.getElementById("token");
const connectBtn = document.getElementById("connectBtn");
const bindBtn = document.getElementById("bindBtn");
const statusEl = document.getElementById("status");

function setStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.classList.toggle("connected", connected);
  statusEl.classList.toggle("disconnected", !connected);
}

async function loadConfig() {
    const stored = await chrome.storage.local.get(["baseUrl", "sessionId", "token"]);
    if (stored.baseUrl) baseUrlInput.value = stored.baseUrl;
    if (stored.sessionId) sessionIdInput.value = stored.sessionId;
    if (stored.token) tokenInput.value = stored.token;
}

async function autofillFromActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const doc = document.documentElement;
        const get = (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return "";
          }
        };
        const serverWsBase =
          doc?.dataset?.daServerWsBase ||
          get("deepagents_server_ws_base") ||
          "";
        const serverUrl = get("deepagents_server_url");
        const sessionId =
          doc?.dataset?.daSessionId ||
          get("deepagents_session_id") ||
          "";
        const token =
          doc?.dataset?.daToken ||
          get("deepagents_auth_token") ||
          "";
        return { serverWsBase, serverUrl, sessionId, token };
      },
    });
    const payload = results?.[0]?.result;
    if (!payload) return;
    let wsBase = payload.serverWsBase;
    if (!wsBase && payload.serverUrl) {
      const protocol = payload.serverUrl.startsWith("https") ? "wss:" : "ws:";
      const host = payload.serverUrl.replace(/^https?:\/\//, "");
      wsBase = `${protocol}//${host}/ws/browser`;
    }
    if (wsBase) baseUrlInput.value = wsBase;
    if (payload.sessionId) sessionIdInput.value = payload.sessionId;
    if (payload.token) tokenInput.value = payload.token;
    if (wsBase || payload.sessionId || payload.token) {
      await chrome.storage.local.set({
        baseUrl: wsBase || baseUrlInput.value.trim(),
        sessionId: sessionIdInput.value.trim(),
        token: tokenInput.value.trim(),
      });
    }
  } catch {
    // ignore injection errors
  }
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

async function refreshStatus() {
  const response = await sendMessage({ type: "status" });
  if (response && response.connected) {
    setStatus("Connected", true);
  } else {
    setStatus("Disconnected", false);
  }
}

connectBtn.addEventListener("click", async () => {
  const baseUrl = baseUrlInput.value.trim();
  const sessionId = sessionIdInput.value.trim();
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ baseUrl, sessionId, token });
  const response = await sendMessage({
    type: "connect",
    baseUrl,
    sessionId,
    token,
  });
  if (response && response.error) {
    setStatus(`Connect failed: ${response.error}`, false);
    return;
  }
  setStatus("Connecting...", false);
  setTimeout(refreshStatus, 400);
});

bindBtn.addEventListener("click", async () => {
  await sendMessage({ type: "bind_tab" });
});

loadConfig().then(refreshStatus);
autofillFromActiveTab().then(refreshStatus);
