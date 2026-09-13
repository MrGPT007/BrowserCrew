const WATCH_PORT = "browsercrew-watch-control";
let scopeReviewBusy = false;
let scopeReviewTimer = null;

window.addEventListener("DOMContentLoaded", () => {
  const running = document.querySelector("#watchMeRunning");
  const pause = document.querySelector("#watchMePauseButton");
  const stop = document.querySelector("#watchMeStopButton");
  if (!running || !pause || !stop || running.querySelector("#watchMeApproveScopeButton")) return;

  const detail = document.createElement("div");
  detail.id = "watchMeScopeReview";
  detail.className = "selection-summary";
  detail.hidden = true;
  detail.setAttribute("aria-live", "polite");
  running.querySelector("#watchMeStatus")?.after(detail);

  const button = document.createElement("button");
  button.id = "watchMeApproveScopeButton";
  button.className = "button button-primary tactile";
  button.type = "button";
  button.hidden = true;
  button.textContent = "Review this site";
  stop.before(button);
  button.addEventListener("click", approveCurrentScope);

  scopeReviewTimer = setInterval(syncScopeReview, 500);
  window.addEventListener("unload", () => clearInterval(scopeReviewTimer), { once: true });
  syncScopeReview().catch(() => {});
});

async function syncScopeReview() {
  if (scopeReviewBusy) return;
  const badge = document.querySelector("#watchMeBadge");
  const detail = document.querySelector("#watchMeScopeReview");
  const button = document.querySelector("#watchMeApproveScopeButton");
  const pause = document.querySelector("#watchMePauseButton");
  if (!badge || !detail || !button || !pause) return;
  if (badge.textContent !== "Site changed") {
    detail.hidden = true;
    button.hidden = true;
    button.dataset.origin = "";
    pause.hidden = false;
    return;
  }

  const response = await portRequest({ type: "get" });
  const state = response.ok ? response.state : null;
  if (state?.session?.status !== "scope_review") return;
  const origin = state.session.scopeReview?.origin || [...(state.session.warnings || [])].reverse().find((item) => item?.code === "ORIGIN_CHANGED")?.origin || "";
  if (!/^https?:\/\//.test(origin)) return;
  detail.hidden = false;
  detail.innerHTML = `<strong>New website needs your approval</strong><p>BrowserCrew paused at ${escapeHtml(origin)}. Nothing on this website is recorded until you approve it for this demonstration.</p><p>Approving this site only expands this recording. It does not grant permission to replay the finished Skill later.</p>`;
  button.dataset.origin = origin;
  button.hidden = false;
  pause.hidden = true;
}

async function approveCurrentScope() {
  const button = document.querySelector("#watchMeApproveScopeButton");
  const origin = String(button?.dataset.origin || "");
  if (!button || !/^https?:\/\//.test(origin) || scopeReviewBusy) return;
  if (!confirm(`Add ${origin} to this Watch Me recording? BrowserCrew will not treat this as permission for future replays.`)) return;

  scopeReviewBusy = true;
  button.disabled = true;
  button.textContent = "Checking site access…";
  try {
    const pattern = `${origin}/*`;
    let granted = await chrome.permissions.contains({ origins: [pattern] });
    if (!granted) granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("BrowserCrew kept recording paused because Chrome site access was not approved.");
    const response = await portRequest({ type: "approveScope" });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not approve this website for the recording.");
    announce(`Watching resumed. ${origin} is approved only for this demonstration.`);
  } catch (error) {
    announce(error.message || "BrowserCrew kept recording paused for site review.");
  } finally {
    scopeReviewBusy = false;
    button.disabled = false;
    button.textContent = "Review this site";
    await syncScopeReview().catch(() => {});
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
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
