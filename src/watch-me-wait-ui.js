const WATCH_PORT = "browsercrew-watch-control";
let waitBusy = false;
let waitStateTimer = null;
let waitMountObserver = null;

function mountWaitControl() {
  const running = document.querySelector("#watchMeRunning");
  if (!running) return false;

  const existing = running.querySelector("#watchMeWaitControls");
  if (existing) {
    enhanceCanonicalWaitControl(existing);
    startWaitStateSync();
    return true;
  }

  const section = document.createElement("div");
  section.id = "watchMeWaitControls";
  section.className = "selection-summary";

  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = "watchMeWaitText";
  label.textContent = "Wait for visible text";
  const input = document.createElement("input");
  input.id = "watchMeWaitText";
  input.type = "text";
  input.maxLength = 160;
  input.autocomplete = "off";
  input.placeholder = "Example: Export ready";
  const helper = document.createElement("p");
  helper.className = "helper";
  helper.dataset.watchWaitHelp = "true";
  helper.textContent = "When this public status or heading is visible, choose Remember this wait. BrowserCrew will wait for the same visible text during replay. Do not enter a name, email, account number, password, token, or other private value.";
  const button = document.createElement("button");
  button.id = "watchMeMarkWaitButton";
  button.className = "button tactile";
  button.type = "button";
  button.textContent = "Remember this wait";
  button.dataset.watchWaitEnhanced = "true";
  button.addEventListener("click", rememberWait);
  section.append(label, input, helper, button);

  const completionLabel = running.querySelector('label[for="watchMeCompletionText"]');
  const completionInput = running.querySelector("#watchMeCompletionText");
  (completionLabel || completionInput || running.firstChild)?.before?.(section);
  if (!section.isConnected) running.prepend(section);

  startWaitStateSync();
  syncWaitState();
  return true;
}

function enhanceCanonicalWaitControl(section) {
  const label = section.querySelector('label[for="watchMeWaitText"]');
  const helper = section.querySelector(".helper");
  const button = section.querySelector("#watchMeMarkWaitButton");
  if (label) label.textContent = "Wait for visible text";
  if (helper) {
    helper.dataset.watchWaitHelp = "true";
    helper.textContent = "When this public status or heading is visible, choose Remember this wait. BrowserCrew will wait for the same visible text during replay. Do not enter a name, email, account number, password, token, or other private value.";
  }
  if (button) {
    button.textContent = "Remember this wait";
    button.dataset.watchWaitEnhanced = "true";
  }
}

function startWaitStateSync() {
  if (waitStateTimer) return;
  waitStateTimer = setInterval(() => {
    if (!document.querySelector("#watchMeWaitControls")) mountWaitControl();
    syncWaitState();
  }, 500);
}

function ensureWaitControl() {
  if (mountWaitControl()) {
    waitMountObserver?.disconnect();
    waitMountObserver = null;
    return;
  }
  if (waitMountObserver) return;
  waitMountObserver = new MutationObserver(() => {
    if (!mountWaitControl()) return;
    waitMountObserver?.disconnect();
    waitMountObserver = null;
  });
  waitMountObserver.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", ensureWaitControl, { once: true });
else ensureWaitControl();

window.addEventListener("unload", () => {
  if (waitStateTimer) clearInterval(waitStateTimer);
  waitStateTimer = null;
  waitMountObserver?.disconnect();
  waitMountObserver = null;
}, { once: true });

function syncWaitState() {
  const button = document.querySelector("#watchMeMarkWaitButton");
  const input = document.querySelector("#watchMeWaitText");
  const watching = document.querySelector("#watchMeBadge")?.textContent === "Watching";
  if (button) button.disabled = waitBusy || !watching;
  if (input) input.disabled = waitBusy || !watching;
}

async function rememberWait() {
  const section = document.querySelector("#watchMeWaitControls");
  const button = section?.querySelector("#watchMeMarkWaitButton");
  const input = section?.querySelector("#watchMeWaitText");
  if (!button || !input || button.dataset.watchWaitEnhanced !== "true" || waitBusy) return;
  const visibleText = String(input.value || "").replace(/\s+/g, " ").trim();
  if (!visibleText) return announce("Enter a short public status or heading that is visible on the page now.");

  waitBusy = true;
  syncWaitState();
  button.textContent = "Checking the page…";
  try {
    const response = await portRequest({ type: "markWait", visibleText });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not remember that wait safely.");
    input.value = "";
    announce(`Wait saved: “${visibleText}”. BrowserCrew will require that visible text during replay.`);
  } catch (error) {
    announce(error.message || "BrowserCrew could not remember that wait safely.");
  } finally {
    waitBusy = false;
    button.textContent = "Remember this wait";
    syncWaitState();
  }
}

function portRequest(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: WATCH_PORT });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("BrowserCrew did not answer in time.")); }, 10_000);
    const onMessage = (message) => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch {}
      resolve(message);
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({ ...payload, requestId });
  });
}

function announce(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
