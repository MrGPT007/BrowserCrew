const SHELL_STYLESHEET = "src/styles/chat-shell.css";

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

  // The primary reading order is now: brand/menu -> connection status -> Chat.
  if (nav.nextElementSibling !== statusStrip) nav.after(statusStrip);

  setupAiStatusTrigger();
  setupAiModal();
  compactChatSurface();
  keepShellStateInSync();

  await refreshConfiguredAiStatus();

  // Chat is the product surface. Other views are explicitly opened by the user.
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

  const parent = view.parentNode;
  parent.insertBefore(backdrop, view);
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
    close.addEventListener("click", () => closeAiSetupModal());
  }

  moveAiHelpBehindDisclosure(view);

  // Connect AI remains in the menu for discoverability, but opens a focused overlay.
  aiTab.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openAiSetupModal();
  }, true);

  // Choosing another top-level destination closes the overlay first.
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest?.(".function-tab");
    if (!tab || tab.id === "tab-ai") return;
    if (!backdrop.hidden) closeAiSetupModal({ restoreFocus: false });
  }, true);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeAiSetupModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) {
      event.preventDefault();
      closeAiSetupModal();
    }
  }, true);

  const result = document.querySelector("#connectionResult");
  if (result) {
    const observer = new MutationObserver(() => {
      if (result.hidden) return;
      if (result.classList.contains("success")) {
        enrichAiStatus("Connected");
      } else if (result.classList.contains("error")) {
        enrichAiStatus("Connection failed");
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

function openAiSetupModal() {
  const backdrop = document.querySelector("#aiSetupBackdrop");
  const view = document.querySelector("#view-ai");
  if (!backdrop || !view) return;
  backdrop.hidden = false;
  backdrop.setAttribute("aria-hidden", "false");
  view.hidden = false;
  view.classList.add("is-active");
  document.body.classList.add("shell-modal-open");
  refreshConfiguredAiStatus();
  requestAnimationFrame(() => {
    const preferred = view.querySelector("#apiKeyInput:not([hidden]), #modelInput, .provider-card, button, input");
    preferred?.focus();
  });
}

function closeAiSetupModal({ restoreFocus = true } = {}) {
  const backdrop = document.querySelector("#aiSetupBackdrop");
  const view = document.querySelector("#view-ai");
  if (!backdrop || !view) return;
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");
  view.hidden = true;
  view.classList.remove("is-active");
  document.body.classList.remove("shell-modal-open");
  refreshConfiguredAiStatus();
  if (restoreFocus) document.querySelector("#aiStatus")?.focus();
}

async function refreshConfiguredAiStatus() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).catch(() => null);
  if (!response?.ok) return;
  const status = document.querySelector("#aiStatus");
  const label = status?.querySelector(".status-label");
  if (!status || !label) return;

  const model = String(response.settings?.model || "").trim();
  const kind = String(response.settings?.kind || "openai");
  const needsSecret = kind === "openai" || kind === "anthropic";
  const hasCredentials = !needsSecret || Boolean(response.hasSecret);

  if (status.dataset.state === "ok") {
    label.textContent = model ? `Connected · ${model}` : "Connected";
    return;
  }
  if (!hasCredentials) {
    status.dataset.state = "warn";
    label.textContent = model ? `Not connected · ${model}` : "Not connected";
    return;
  }
  label.textContent = model ? `Configured · ${model}` : "Configured";
}

function enrichAiStatus(stateText) {
  const status = document.querySelector("#aiStatus");
  const label = status?.querySelector(".status-label");
  const model = document.querySelector("#modelInput")?.value.trim();
  if (!status || !label) return;
  label.textContent = model ? `${stateText} · ${model}` : stateText;
  status.setAttribute("aria-label", `AI ${stateText.toLowerCase()}${model ? ` using ${model}` : ""}. Open AI setup.`);
}
