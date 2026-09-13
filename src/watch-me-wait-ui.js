const WATCH_PORT = "browsercrew-watch-control";
let waitBusy = false;
let waitStateTimer = null;
let waitMountObserver = null;

function mountWaitControl() {
  const running = document.querySelector("#watchMeRunning");
  if (!running) return false;
  if (running.querySelector("#watchMeWaitControl")) {
    startWaitStateSync();
    return true;
  }

  const box = document.createElement("div");
  box.className = "selection-summary";
  box.id = "watchMeWaitControl";

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
  label.append(input);

  const helper = document.createElement("p");
  helper.className = "helper";
  helper.textContent = "When this public status or heading is visible, choose Remember this wait. BrowserCrew will wait for the same visible text during replay. Do not enter a name, email, account number, password, token, or other private value.";

  const button = document.createElement("button");
  button.id = "watchMeRememberWaitButton";
  button.className = "button button-small tactile";
  button.type = "button";
  button.textContent = "Remember this wait";
  button.addEventListener("click", rememberWait);

  box.append(label, helper, button);
  const completionInput = running.querySelector("#watchMeCompletionText");
  if (completionInput) completionInput.before(box);
  else running.prepend(box);

  startWaitStateSync();
  syncWaitState();
  return true;
}

function startWaitStateSync() {
  if (waitStateTimer) return;
  waitStateTimer = setInterval(() => {
    if (!document.querySelector("#watchMeWaitControl")) mountWaitControl();
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
  const button = document.querySelector("#watchMeRememberWaitButton");
  const input = document.querySelector("#watchMeWaitText");
  const watching = document.querySelector("#watchMeBadge")?.textContent === "Watching";
  if (button) button.disabled = waitBusy || !watching;
  if (input) input.disabled = waitBusy || !watching;
}

async function rememberWait() {
  const button = document.querySelector("#watchMeRememberWaitButton");
  const input = document.querySelector("#watchMeWaitText");
  const visibleText = String(input?.value || "").replace(/\s+/g, " ").trim();
  if (!button || !input || waitBusy) return;
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
