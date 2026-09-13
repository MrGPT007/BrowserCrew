const WATCH_PORT = "browsercrew-watch-control";

window.addEventListener("DOMContentLoaded", () => {
  const running = document.querySelector("#watchMeRunning");
  const completion = document.querySelector("#watchMeCompletionText");
  if (!running || !completion || running.querySelector("#watchMeWaitText")) return;

  const section = document.createElement("div");
  section.id = "watchMeWaitControls";
  section.className = "selection-summary";
  section.innerHTML = `
    <label class="field-label" for="watchMeWaitText">Did this page take time to become ready?</label>
    <input id="watchMeWaitText" type="text" maxlength="160" placeholder="Example: Results loaded" autocomplete="off" />
    <p class="helper">When a short status or heading is visible, add it as a wait condition. Use only non-private text you chose yourself.</p>
    <button class="button tactile" id="watchMeMarkWaitButton" type="button">Add wait for visible text</button>`;
  const completionLabel = running.querySelector('label[for="watchMeCompletionText"]');
  (completionLabel || completion).before(section);
  section.querySelector("#watchMeMarkWaitButton")?.addEventListener("click", markWait);
});

async function markWait() {
  const input = document.querySelector("#watchMeWaitText");
  const button = document.querySelector("#watchMeMarkWaitButton");
  const visibleText = String(input?.value || "").replace(/\s+/g, " ").trim();
  if (!visibleText) {
    announce("Enter a short non-private status or heading that is visible now.");
    input?.focus();
    return;
  }
  busy(button, true, "Checking this page…");
  try {
    const response = await portRequest({ type: "markWait", visibleText });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not add that wait condition.");
    if (input) input.value = "";
    announce("Wait condition added. BrowserCrew will re-check that visible text during replay.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not add that wait condition.");
  } finally {
    busy(button, false, "Add wait for visible text");
  }
}

function portRequest(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: WATCH_PORT });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      try { port.disconnect(); } catch {}
      reject(new Error("BrowserCrew did not answer in time."));
    }, 10_000);
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

function busy(button, state, label) {
  if (!button) return;
  button.disabled = state;
  button.textContent = label;
}

function announce(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
