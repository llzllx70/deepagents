const serverUrlInput = document.getElementById("serverUrl");
const connectBtn = document.getElementById("connectBtn");
const bindBtn = document.getElementById("bindBtn");
const statusEl = document.getElementById("status");

function setStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.classList.toggle("connected", connected);
  statusEl.classList.toggle("disconnected", !connected);
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  if (stored.serverUrl) serverUrlInput.value = stored.serverUrl;
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
        return { serverWsBase, serverUrl };
      },
    });
    const payload = results?.[0]?.result;
    if (!payload) return;
    let wsBase = payload.serverWsBase;
    if (!wsBase && payload.serverUrl) {
      const protocol = payload.serverUrl.startsWith("https") ? "wss:" : "ws:";
      const host = payload.serverUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      wsBase = `${protocol}//${host}/ws/browser`;
    }
    if (wsBase) {
      serverUrlInput.value = wsBase;
      await chrome.storage.local.set({ serverUrl: wsBase });
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
  const serverUrl = serverUrlInput.value.trim();
  await chrome.storage.local.set({ serverUrl });
  const response = await sendMessage({
    type: "connect",
    serverUrl,
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
