const SHELL_STYLESHEET = "src/styles/chat-shell.css";
const CONNECTIONS_KEY = "browsercrew.connections.v1";
const ACTIVE_CONNECTION_KEY = "browsercrew.activeConnection.v1";

installShellStyles();
document.addEventListener("DOMContentLoaded", initChatFirstShell);

function installShellStyles() {
  if (document.querySelector(`link[href="${SHELL_STYLESHEET}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = SHELL_STYLESHEET;
  document.head.append(link);
}

async function initChatFirstShell() {
  const app = document.querySelector("#app");
  const nav = document.querySelector(".function-tabs");
  const statusStrip = document.querySelector(".status-strip");
  const chatView = document.querySelector("#view-chat");
  if (!app || !nav || !statusStrip || !chatView) return;

  app.classList.add("chat-first-shell");
  document.body.classList.add("browsercrew-chat-first");

  // Primary reading order: product menu -> AI status -> conversation.
  if (nav.nextElementSibling !== statusStrip) nav.after(statusStrip);

  setupAiStatusTrigger();
  setupAiModal();
  compactChatSurface();
  keepShellStateInSync();
  watchConnectionState();

  await refreshConfiguredAiStatus();

  // Chat is the product surface. Everything else is opened on demand.
  requestAnimationFrame(() => document.querySelector("#tab-chat")?.click());
}

function setupAiStatusTrigger() {
  const aiStatus = document.querySelector("#aiStatus");
  if (!aiStatus) return;
  aiStatus.classList.add("ai-status-trigger");
  aiStatus.setAttribute("role", "button");
  aiStatus.setAttribute("tabindex", "0");
  aiStatus.setAttribute("aria-haspopup", "dialog");
  aiStatus.setAttribute("aria-controls", "aiSetupBackdrop");
  aiStatus.setAttribute("aria-label", "AI connection status. Open AI setup.");
  aiStatus.title = "Open AI setup";
  aiStatus.addEventListener("click", openAiSetupModal);
  aiStatus.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openAiSetupModal();
  });
}

function setupAiModal() {
  const view = document.querySelector("#view-ai");
  const nav = document.querySelector(".function-tabs");
  const aiTab = document.querySelector("#tab-ai");
  if (!view || !nav || !aiTab || document.querySelector("#aiSetupBackdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "shell-modal-backdrop";
  backdrop.id = "aiSetupBackdrop";
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");

  // BrowserCrew's accessibility layer makes #app inert while a modal is open,
  // so modal surfaces live beside #app, like the command and transfer dialogs.
  document.body.append(backdrop);
  backdrop.append(view);
  view.classList.add("shell-modal");
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-modal", "true");
  view.setAttribute("aria-labelledby", "aiSetupTitle");

  const heading = view.querySelector(".view-heading");
  const title = heading?.querySelector("h1");
  if (title) {
    title.id = "aiSetupTitle";
    title.textContent = "Connect your AI";
  }
  if (heading && !heading.querySelector("#aiSetupCloseButton")) {
    const close = document.createElement("button");
    close.className = "icon-button tactile shell-modal-close";
    close.id = "aiSetupCloseButton";
    close.type = "button";
    close.setAttribute("aria-label", "Close AI setup");
    close.title = "Close";
    close.textContent = "×";
    heading.append(close);
    close.addEventListener("click", closeAiSetupModal);
  }

  moveAiHelpBehindDisclosure(view);

  // Connect AI remains discoverable in the menu but never replaces Chat.
  aiTab.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openAiSetupModal();
  }, true);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeAiSetupModal();
  });

  // The global accessibility layer owns focus trapping and background inertness.
  // AI setup only adds its product-specific Escape close behavior.
  document.addEventListener("keydown", (event) => {
    if (backdrop.hidden || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAiSetupModal();
  }, true);

  const result = document.querySelector("#connectionResult");
  if (result) {
    const observer = new MutationObserver(() => {
      if (result.hidden) return;
      if (result.classList.contains("success")) {
        enrichAiStatus("Connected", "ok");
      } else if (result.classList.contains("error")) {
        enrichAiStatus("Connection failed", "error");
      }
    });
    observer.observe(result, { attributes: true, childList: true, subtree: true, characterData: true });
  }
}

function moveAiHelpBehindDisclosure(view) {
  const nodes = [...view.querySelectorAll(":scope > article .helper, :scope > article .recommendation, :scope > article .example-box")];
  if (!nodes.length) return;
  const details = document.createElement("details");
  details.className = "ai-help-disclosure";
  const summary = document.createElement("summary");
  summary.textContent = "Connection help";
  const body = document.createElement("div");
  body.className = "ai-help-body";
  details.append(summary, body);
  for (const node of nodes) body.append(node);
  const lastCard = view.querySelector(":scope > article:last-of-type");
  (lastCard || view).append(details);
}

function compactChatSurface() {
  const view = document.querySelector("#view-chat");
  const heading = view?.querySelector(".chat-heading");
  const connection = view?.querySelector(".chat-connection-card");
  const context = view?.querySelector(".chat-context-card");
  const transcript = view?.querySelector(".chat-transcript-card");
  const activity = view?.querySelector(".chat-activity-card");
  const composer = view?.querySelector(".chat-composer-card");
  if (!view || !heading || !connection || !context || !transcript || !activity || !composer) return;

  view.classList.add("chat-primary-surface");
  heading.classList.add("chat-compact-heading");
  connection.classList.add("chat-compact-toolbar");
  context.classList.add("chat-compact-context");
  transcript.classList.add("chat-primary-transcript");
  activity.classList.add("chat-progressive-activity");
  composer.classList.add("chat-primary-composer");

  const headingIntro = heading.querySelector(".view-intro");
  if (headingIntro) headingIntro.hidden = true;

  const contextHeading = context.querySelector(".card-heading");
  if (contextHeading) contextHeading.hidden = true;
  const destination = context.querySelector("#chatDestinationText");
  if (destination) destination.classList.add("progressive-copy");

  const composerLabel = composer.querySelector('label[for="chatInput"]');
  if (composerLabel) composerLabel.classList.add("sr-only");
  const helper = composer.querySelector(":scope > .helper");
  if (helper) helper.classList.add("progressive-copy");
}

function keepShellStateInSync() {
  const chatView = document.querySelector("#view-chat");
  if (!chatView) return;
  const update = () => {
    const active = !chatView.hidden && chatView.classList.contains("is-active");
    document.body.classList.toggle("chat-surface-active", active);
  };
  update();
  new MutationObserver(update).observe(chatView, { attributes: true, attributeFilter: ["hidden", "class"] });
}

function watchConnectionState() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[CONNECTIONS_KEY] || changes[ACTIVE_CONNECTION_KEY]) refreshConfiguredAiStatus().catch(() => {});
  });
}

function openAiSetupModal() {
  const backdrop = document.querySelector("#aiSetupBackdrop");
  const view = document.querySelector("#view-ai");
  if (!backdrop || !view || !backdrop.hidden) return;
  backdrop.hidden = false;
  backdrop.setAttribute("aria-hidden", "false");
  view.hidden = false;
  view.classList.add("is-active");
  document.body.classList.add("shell-modal-open");
  refreshConfiguredAiStatus();
  requestAnimationFrame(() => focusFirstVisible(view));
}

function closeAiSetupModal() {
  const backdrop = document.querySelector("#aiSetupBackdrop");
  const view = document.querySelector("#view-ai");
  if (!backdrop || !view || backdrop.hidden) return;
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");
  view.hidden = true;
  view.classList.remove("is-active");
  document.body.classList.remove("shell-modal-open");
  refreshConfiguredAiStatus();
  // Focus restoration is intentionally delegated to accessibility-ui.js,
  // which already handles every BrowserCrew aria-modal surface consistently.
}

async function refreshConfiguredAiStatus() {
  const [response, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).catch(() => null),
    chrome.storage.local.get([CONNECTIONS_KEY, ACTIVE_CONNECTION_KEY]).catch(() => ({}))
  ]);
  if (!response?.ok) return;
  const status = document.querySelector("#aiStatus");
  const label = status?.querySelector(".status-label");
  if (!status || !label) return;

  const connections = Array.isArray(stored[CONNECTIONS_KEY]) ? stored[CONNECTIONS_KEY] : [];
  const activeId = stored[ACTIVE_CONNECTION_KEY] || null;
  const active = connections.find((item) => item.id === activeId) || null;
  const model = String(active?.model || response.settings?.model || "").trim();
  const kind = String(active?.kind || response.settings?.kind || "openai");
  const needsSecret = kind === "openai" || kind === "anthropic";
  const hasCredentials = !needsSecret || Boolean(response.hasSecret);

  if (active?.status === "connected") {
    setAiStatusPresentation("ok", model ? `Connected · ${model}` : "Connected", model);
    return;
  }
  if (active?.status === "failed") {
    setAiStatusPresentation("error", model ? `Connection failed · ${model}` : "Connection failed", model);
    return;
  }
  if (active?.status === "permission_needed") {
    setAiStatusPresentation("warn", model ? `Permission needed · ${model}` : "Permission needed", model);
    return;
  }

  // The legacy one-connection tester still updates the visible state directly.
  if (status.dataset.state === "ok") {
    setAiStatusPresentation("ok", model ? `Connected · ${model}` : "Connected", model);
    return;
  }
  if (!hasCredentials) {
    setAiStatusPresentation("warn", model ? `Not connected · ${model}` : "Not connected", model);
    return;
  }
  setAiStatusPresentation("idle", model ? `Ready to test · ${model}` : "Ready to test", model);
}

function enrichAiStatus(stateText, stateName) {
  const model = document.querySelector("#modelInput")?.value.trim() || "";
  setAiStatusPresentation(stateName, model ? `${stateText} · ${model}` : stateText, model);
}

function setAiStatusPresentation(stateName, text, model = "") {
  const status = document.querySelector("#aiStatus");
  const label = status?.querySelector(".status-label");
  if (!status || !label) return;
  status.dataset.state = stateName;
  label.textContent = text;
  const spoken = stateName === "ok" ? "connected" : stateName === "error" ? "connection failed" : text.toLowerCase();
  status.setAttribute("aria-label", `AI ${spoken}${model && !spoken.includes(model.toLowerCase()) ? ` using ${model}` : ""}. Open AI setup.`);
}

function focusFirstVisible(root) {
  const nodes = [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden && !node.closest("[hidden]") && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
  (nodes[0] || root)?.focus?.();
}
