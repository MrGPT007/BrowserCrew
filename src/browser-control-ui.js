const BROWSER_CONTROL_GRANT_KEY = "browsercrew.browserControlGrant.v1";
const BROWSER_CONTROL_PENDING_APPROVAL_KEY = "browsercrew.browserControlPendingApproval.v1";
const CHAT_STORAGE_KEY = "browsercrew.conversations.v1";
const BROAD_ORIGINS = ["http://*/*", "https://*/*"];
const ALLOWED_ACTIONS = [
  "observe", "list_tabs", "open_tab", "focus_tab", "close_tab", "navigate", "back", "forward", "reload",
  "click", "type", "select", "scroll", "press_key", "download_url"
];

installBrowserControlSurface();
document.addEventListener("DOMContentLoaded", initBrowserControlUi);

function installBrowserControlSurface() {
  if (!document.querySelector('link[href="src/styles/browser-control.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "src/styles/browser-control.css";
    document.head.append(css);
  }
  const strip = document.querySelector(".status-strip");
  if (strip && !document.querySelector("#browserControlStatus")) {
    const item = document.createElement("div");
    item.className = "status-item browser-control-status";
    item.id = "browserControlStatus";
    item.dataset.state = "idle";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-pressed", "false");
    item.innerHTML = '<span class="status-dot" aria-hidden="true"></span><span><strong>Browser control</strong><small class="status-label">Off</small></span>';
    strip.append(item);
  }

  if (!document.querySelector("#browserControlApproval")) {
    const approval = document.createElement("div");
    approval.className = "browser-control-approval-backdrop";
    approval.id = "browserControlApproval";
    approval.hidden = true;
    approval.innerHTML = `
      <section class="browser-control-approval-card" role="dialog" aria-modal="true" aria-labelledby="browserControlApprovalTitle" aria-describedby="browserControlApprovalCopy">
        <p class="eyebrow">CHECK BEFORE I DO THIS</p>
        <h2 id="browserControlApprovalTitle">Approve this one action?</h2>
        <p id="browserControlApprovalCopy">BrowserCrew paused before an action that can have an outside effect.</p>
        <div class="browser-control-approval-target">
          <strong id="browserControlApprovalAction">Action</strong>
          <span id="browserControlApprovalSite">Website</span>
        </div>
        <div class="warning-box">⚠️ This approval is for this exact click only. If the page or control changes, BrowserCrew refuses it and asks again.</div>
        <div class="button-row">
          <button class="button tactile" id="browserControlApprovalCancel" type="button">Cancel</button>
          <button class="button button-primary tactile" id="browserControlApprovalApprove" type="button">Approve once</button>
        </div>
      </section>`;
    document.body.append(approval);
  }
}

function initBrowserControlUi() {
  const status = document.querySelector("#browserControlStatus");
  status?.addEventListener("click", toggleBrowserControl);
  status?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleBrowserControl();
  });
  document.querySelector("#browserControlApprovalApprove")?.addEventListener("click", approvePendingAction);
  document.querySelector("#browserControlApprovalCancel")?.addEventListener("click", cancelPendingAction);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[BROWSER_CONTROL_GRANT_KEY]) renderBrowserControlStatus();
    if (area === "session" && changes[BROWSER_CONTROL_PENDING_APPROVAL_KEY]) renderPendingApproval();
    if (area === "local" && changes[CHAT_STORAGE_KEY]) renderBrowserControlStatus();
  });
  renderBrowserControlStatus();
  renderPendingApproval();
}

async function toggleBrowserControl() {
  const status = document.querySelector("#browserControlStatus");
  if (status?.dataset.busy === "true") return;
  if (status) status.dataset.busy = "true";
  try {
    const stored = await chrome.storage.session.get(BROWSER_CONTROL_GRANT_KEY);
    const current = stored[BROWSER_CONTROL_GRANT_KEY];
    if (current?.enabled) {
      await chrome.storage.session.remove([BROWSER_CONTROL_GRANT_KEY, BROWSER_CONTROL_PENDING_APPROVAL_KEY]);
      notifyControl("Browser control is off. The AI cannot start another browser action.");
      return;
    }

    setStatus("warn", "Waiting for Chrome…", false);
    let allowed = await chrome.permissions.contains({ origins: BROAD_ORIGINS }).catch(() => false);
    if (!allowed) allowed = await chrome.permissions.request({ origins: BROAD_ORIGINS }).catch(() => false);
    if (!allowed) {
      setStatus("warn", "Permission not granted", false);
      notifyControl("Browser control stayed off because Chrome browser access was not approved.");
      return;
    }

    await chrome.storage.session.remove(BROWSER_CONTROL_PENDING_APPROVAL_KEY);
    const grant = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      enabled: true,
      scope: "browser",
      actionClass: "browser_control",
      allowedActions: [...ALLOWED_ACTIONS],
      allowedProtocols: ["http:", "https:"],
      maxSteps: 24,
      grantedAt: new Date().toISOString()
    };
    await chrome.storage.session.set({ [BROWSER_CONTROL_GRANT_KEY]: grant });
    notifyControl("Browser control is on for this browser session. Click the status again to turn it off instantly.");
  } finally {
    if (status) delete status.dataset.busy;
    await renderBrowserControlStatus();
    await renderPendingApproval();
  }
}

async function renderBrowserControlStatus() {
  const status = document.querySelector("#browserControlStatus");
  if (!status) return;
  const [session, local] = await Promise.all([
    chrome.storage.session.get(BROWSER_CONTROL_GRANT_KEY).catch(() => ({})),
    chrome.storage.local.get(CHAT_STORAGE_KEY).catch(() => ({}))
  ]);
  const grant = session[BROWSER_CONTROL_GRANT_KEY];
  const running = Array.isArray(local[CHAT_STORAGE_KEY]) && local[CHAT_STORAGE_KEY].some((item) => item?.status === "running");
  if (grant?.enabled) {
    setStatus("ok", running ? "ON · Working" : "ON · Browser access", true);
    status.classList.toggle("is-working", running);
  } else {
    setStatus("idle", "Off", false);
    status.classList.remove("is-working");
  }
}

async function renderPendingApproval() {
  const dialog = document.querySelector("#browserControlApproval");
  if (!dialog) return;
  const stored = await chrome.storage.session.get([BROWSER_CONTROL_PENDING_APPROVAL_KEY, BROWSER_CONTROL_GRANT_KEY]).catch(() => ({}));
  const pending = stored[BROWSER_CONTROL_PENDING_APPROVAL_KEY];
  const grant = stored[BROWSER_CONTROL_GRANT_KEY];
  const valid = Boolean(
    pending?.id && pending?.grantId && grant?.enabled && grant.id === pending.grantId
    && Date.parse(pending.expiresAt || "") > Date.now()
  );
  if (!valid) {
    dialog.hidden = true;
    dialog.removeAttribute("data-approval-id");
    if (pending?.id) await chrome.storage.session.remove(BROWSER_CONTROL_PENDING_APPROVAL_KEY).catch(() => {});
    return;
  }

  const wasHidden = dialog.hidden;
  dialog.dataset.approvalId = pending.id;
  document.querySelector("#browserControlApprovalAction").textContent = `Click “${String(pending.label || "this control").slice(0, 180)}”`;
  document.querySelector("#browserControlApprovalSite").textContent = `On ${safeHost(pending.url)}`;
  dialog.hidden = false;
  if (wasHidden) document.querySelector("#browserControlApprovalCancel")?.focus();
}

async function approvePendingAction() {
  const dialog = document.querySelector("#browserControlApproval");
  const button = document.querySelector("#browserControlApprovalApprove");
  const approvalId = dialog?.dataset.approvalId;
  if (!approvalId || button?.dataset.busy === "true") return;
  if (button) { button.dataset.busy = "true"; button.disabled = true; button.textContent = "Approving…"; }
  try {
    const result = await chrome.runtime.sendMessage({ type: "APPROVE_BROWSER_CONTROL_ACTION", approvalId }).catch((error) => ({ ok: false, message: error?.message || "BrowserCrew could not send the approval." }));
    notifyControl(result?.ok ? "Approved once. BrowserCrew completed that exact click." : (result?.message || "BrowserCrew did not use that approval."));
  } finally {
    if (button) { delete button.dataset.busy; button.disabled = false; button.textContent = "Approve once"; }
    await renderPendingApproval();
  }
}

async function cancelPendingAction() {
  const dialog = document.querySelector("#browserControlApproval");
  const button = document.querySelector("#browserControlApprovalCancel");
  const approvalId = dialog?.dataset.approvalId;
  if (!approvalId || button?.dataset.busy === "true") return;
  if (button) { button.dataset.busy = "true"; button.disabled = true; }
  try {
    const result = await chrome.runtime.sendMessage({ type: "CANCEL_BROWSER_CONTROL_ACTION", approvalId }).catch((error) => ({ ok: false, message: error?.message || "BrowserCrew could not cancel the approval." }));
    notifyControl(result?.ok ? "Cancelled. BrowserCrew did not perform that action." : (result?.message || "That approval is no longer pending."));
  } finally {
    if (button) { delete button.dataset.busy; button.disabled = false; }
    await renderPendingApproval();
  }
}

function setStatus(state, labelText, pressed) {
  const status = document.querySelector("#browserControlStatus");
  const label = status?.querySelector(".status-label");
  if (!status || !label) return;
  status.dataset.state = state;
  label.textContent = labelText;
  status.setAttribute("aria-pressed", String(Boolean(pressed)));
  status.setAttribute("aria-label", pressed
    ? `Browser control on${status.classList.contains("is-working") ? ", AI working" : ""}. Activate to turn browser control off.`
    : "Browser control off. Activate to let BrowserCrew operate normal website tabs for this browser session.");
  status.title = pressed ? "Turn browser control off" : "Turn browser control on";
}

function safeHost(value) {
  try { return new URL(value).hostname; } catch { return "this website"; }
}

function notifyControl(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyControl.timer);
  notifyControl.timer = setTimeout(() => { toast.hidden = true; }, 4300);
}
