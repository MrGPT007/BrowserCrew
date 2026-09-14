const BROWSER_CONTROL_GRANT_KEY = "browsercrew.browserControlGrant.v1";
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
  if (!strip || document.querySelector("#browserControlStatus")) return;
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

function initBrowserControlUi() {
  const status = document.querySelector("#browserControlStatus");
  status?.addEventListener("click", toggleBrowserControl);
  status?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleBrowserControl();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[BROWSER_CONTROL_GRANT_KEY]) renderBrowserControlStatus();
    if (area === "local" && changes[CHAT_STORAGE_KEY]) renderBrowserControlStatus();
  });
  renderBrowserControlStatus();
}

async function toggleBrowserControl() {
  const status = document.querySelector("#browserControlStatus");
  if (status?.dataset.busy === "true") return;
  if (status) status.dataset.busy = "true";
  try {
    const stored = await chrome.storage.session.get(BROWSER_CONTROL_GRANT_KEY);
    const current = stored[BROWSER_CONTROL_GRANT_KEY];
    if (current?.enabled) {
      await chrome.storage.session.remove(BROWSER_CONTROL_GRANT_KEY);
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

function notifyControl(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyControl.timer);
  notifyControl.timer = setTimeout(() => { toast.hidden = true; }, 4300);
}
