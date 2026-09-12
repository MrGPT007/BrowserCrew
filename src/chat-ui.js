const CHAT_VIEW = "chat";
const VIEW_KEY = "browsercrew.activeView";
const CHAT_PORT = "browsercrew-chat";

const chatState = {
  port: null,
  conversations: [],
  currentConversationId: null,
  activeRunId: null,
  streamingText: "",
  useCurrentPage: false,
  provider: null,
  commandIndex: 0
};

installChatSurface();
document.addEventListener("DOMContentLoaded", initChatUi);

function installChatSurface() {
  if (document.querySelector("#tab-chat")) return;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "src/styles/chat.css";
  document.head.append(css);

  const nav = document.querySelector(".function-tabs");
  const workspaceTab = document.querySelector("#tab-workspace");
  const chatTab = document.createElement("button");
  chatTab.className = "function-tab";
  chatTab.id = "tab-chat";
  chatTab.type = "button";
  chatTab.dataset.view = CHAT_VIEW;
  chatTab.setAttribute("role", "tab");
  chatTab.setAttribute("aria-controls", "view-chat");
  chatTab.setAttribute("aria-selected", "false");
  chatTab.tabIndex = -1;
  chatTab.innerHTML = '<span class="tab-icon" aria-hidden="true">✦</span><span>Chat</span>';
  nav?.insertBefore(chatTab, workspaceTab || nav.firstChild);

  const chatView = document.createElement("section");
  chatView.className = "view chat-view";
  chatView.id = "view-chat";
  chatView.dataset.viewPanel = CHAT_VIEW;
  chatView.setAttribute("role", "tabpanel");
  chatView.setAttribute("aria-labelledby", "tab-chat");
  chatView.hidden = true;
  chatView.innerHTML = `
    <header class="view-heading chat-heading">
      <div>
        <p class="eyebrow">CHAT</p>
        <h1>Talk to your AI</h1>
        <p class="view-intro">Ask a question, optionally include the page you are viewing, and watch BrowserCrew's live activity without exposing private hidden reasoning.</p>
      </div>
      <button class="button button-small tactile" id="chatNewButton" type="button">New chat</button>
    </header>

    <article class="card chat-connection-card">
      <div class="chat-connection-row">
        <button class="chat-model-chip tactile" id="chatModelButton" type="button" aria-label="Open AI setup"><span class="status-dot" aria-hidden="true"></span><span><strong id="chatModelName">AI model</strong><small id="chatConnectionStatus">Checking setup…</small></span></button>
        <button class="command-hint tactile" id="commandPaletteButton" type="button" aria-label="Open command bar"><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></button>
      </div>
      <label class="field-label" for="chatConversationSelect">Saved chats</label>
      <select id="chatConversationSelect" aria-label="Saved chats"><option value="">New chat</option></select>
    </article>

    <article class="card chat-context-card">
      <div class="card-heading"><div><p class="step-label">MESSAGE CONTEXT</p><h2>Choose what this message can use</h2></div><span class="badge badge-safe">You control it</span></div>
      <label class="chat-context-toggle" for="chatUseCurrentPage">
        <input id="chatUseCurrentPage" type="checkbox" />
        <span><strong>Use the page I’m looking at</strong><small>BrowserCrew will send a bounded snapshot of visible page text with this message only after site access is approved.</small></span>
      </label>
      <div class="chat-context-summary" id="chatContextSummary" hidden></div>
      <p class="helper" id="chatDestinationText">Where this message goes: your current Connect AI setup.</p>
    </article>

    <article class="card chat-transcript-card" aria-label="Chat conversation">
      <div class="chat-empty" id="chatEmptyState">
        <strong>Start with a normal question.</strong>
        <p>Example: “Summarize this page and tell me the three things I should notice.”</p>
      </div>
      <div class="chat-messages" id="chatMessages" aria-live="polite"></div>
    </article>

    <article class="card chat-activity-card">
      <button class="chat-activity-toggle" id="chatActivityToggle" type="button" aria-expanded="false" aria-controls="chatActivityBody">
        <span><strong>Live activity</strong><small id="chatActivityStatus">Ready</small></span><span aria-hidden="true">⌄</span>
      </button>
      <div id="chatActivityBody" hidden>
        <p class="helper">Shows plan summaries, model requests, page reads, stops, errors, and checkpoints. It does not expose private hidden chain-of-thought.</p>
        <ol class="chat-activity-list" id="chatActivityList"></ol>
      </div>
    </article>

    <article class="card chat-composer-card">
      <label class="field-label" for="chatInput">Message BrowserCrew</label>
      <textarea id="chatInput" rows="4" maxlength="20000" placeholder="Ask anything, or include the current page above…"></textarea>
      <div class="chat-composer-meta">
        <span id="chatRunStatus">Ready</span>
        <span>Enter sends · Shift+Enter adds a line</span>
      </div>
      <div class="button-row chat-send-row">
        <button class="button tactile" id="chatActivityQuickButton" type="button">Live activity</button>
        <button class="button button-primary tactile" id="chatSendButton" type="button">Send</button>
        <button class="button button-danger tactile" id="chatStopButton" type="button" hidden>Stop</button>
      </div>
      <p class="helper">Stop prevents new model work for this response. BrowserCrew does not promise to undo actions a website already accepted.</p>
    </article>`;

  const workspace = document.querySelector("#view-workspace");
  workspace?.parentNode?.insertBefore(chatView, workspace);

  const palette = document.createElement("div");
  palette.className = "command-palette-backdrop";
  palette.id = "commandPalette";
  palette.hidden = true;
  palette.innerHTML = `
    <section class="command-palette" role="dialog" aria-modal="true" aria-labelledby="commandPaletteTitle">
      <div class="command-palette-head"><div><p class="eyebrow">POWER USER</p><h2 id="commandPaletteTitle">Command bar</h2></div><kbd>Esc</kbd></div>
      <label class="sr-only" for="commandSearch">Search commands</label>
      <input id="commandSearch" type="search" autocomplete="off" placeholder="Type a command…" />
      <div class="command-list" id="commandList" role="listbox" aria-label="BrowserCrew commands"></div>
      <p class="command-help">↑↓ move · Enter run · Esc close · Ctrl+K / ⌘K toggle</p>
    </section>`;
  document.body.append(palette);
}

async function initChatUi() {
  bindChatEvents();
  connectChatPort();
  await refreshChatProvider();
  if (localStorage.getItem(VIEW_KEY) === CHAT_VIEW) showChatView(false);
}

function bindChatEvents() {
  const chatTab = document.querySelector("#tab-chat");
  chatTab?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    showChatView();
  }, true);

  document.addEventListener("keydown", onGlobalKeydown, true);
  document.querySelector("#chatNewButton")?.addEventListener("click", createNewChat);
  document.querySelector("#commandPaletteButton")?.addEventListener("click", openCommandPalette);
  document.querySelector("#chatModelButton")?.addEventListener("click", () => openExistingView("ai", "#modelInput"));
  document.querySelector("#chatUseCurrentPage")?.addEventListener("change", (event) => {
    chatState.useCurrentPage = Boolean(event.currentTarget.checked);
    const summary = document.querySelector("#chatContextSummary");
    if (!chatState.useCurrentPage && summary) { summary.hidden = true; summary.textContent = ""; }
  });
  document.querySelector("#chatActivityToggle")?.addEventListener("click", toggleActivity);
  document.querySelector("#chatActivityQuickButton")?.addEventListener("click", () => setActivityOpen(true));
  document.querySelector("#chatSendButton")?.addEventListener("click", sendChatMessage);
  document.querySelector("#chatStopButton")?.addEventListener("click", stopChatRun);
  document.querySelector("#chatConversationSelect")?.addEventListener("change", onConversationSelected);
  document.querySelector("#chatInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  document.querySelector("#commandSearch")?.addEventListener("input", () => { chatState.commandIndex = 0; renderCommands(); });
  document.querySelector("#commandSearch")?.addEventListener("keydown", onCommandKeydown);
  document.querySelector("#commandPalette")?.addEventListener("click", (event) => {
    if (event.target.id === "commandPalette") closeCommandPalette();
  });
}

function connectChatPort() {
  chatState.port = chrome.runtime.connect({ name: CHAT_PORT });
  chatState.port.onMessage.addListener(onChatPortMessage);
  chatState.port.onDisconnect.addListener(() => {
    setChatRunState(false, "Chat connection restarted. Reopen Chat if the response did not finish.");
    setTimeout(connectChatPort, 250);
  });
  chatState.port.postMessage({ type: "GET_CHAT_STATE" });
}

function onChatPortMessage(message) {
  if (!message) return;
  if (message.type === "CHAT_STATE") {
    chatState.conversations = Array.isArray(message.conversations) ? message.conversations : [];
    if (!chatState.currentConversationId && chatState.conversations.length) chatState.currentConversationId = chatState.conversations[0].id;
    renderConversationPicker();
    renderCurrentConversation();
    return;
  }
  if (message.type === "CHAT_CONVERSATION" && message.conversation) {
    upsertLocalConversation(message.conversation);
    chatState.currentConversationId = message.conversation.id;
    renderConversationPicker();
    renderCurrentConversation();
    return;
  }
  if (message.type === "CHAT_STARTED") {
    if (message.conversation) upsertLocalConversation(message.conversation);
    chatState.activeRunId = message.runId;
    chatState.currentConversationId = message.conversationId;
    chatState.streamingText = "";
    setChatRunState(true, `Asking ${message.model}…`);
    renderStreamingBubble();
    return;
  }
  if (message.type === "CHAT_DELTA" && message.runId === chatState.activeRunId) {
    chatState.streamingText += String(message.delta || "");
    renderStreamingBubble();
    return;
  }
  if (message.type === "CHAT_ACTIVITY" && message.event) {
    const conversation = findLocalConversation(message.conversationId);
    if (conversation) {
      conversation.activity = Array.isArray(conversation.activity) ? conversation.activity : [];
      conversation.activity.push(message.event);
      conversation.activity = conversation.activity.slice(-300);
    }
    if (message.conversationId === chatState.currentConversationId) renderActivity(conversation?.activity || []);
    return;
  }
  if (message.type === "CHAT_DONE") {
    if (message.conversation) upsertLocalConversation(message.conversation);
    if (message.runId === chatState.activeRunId) {
      chatState.activeRunId = null;
      chatState.streamingText = "";
    }
    setChatRunState(false, message.stopped ? "Stopped" : message.ok ? "Ready" : (message.error?.message || "Could not finish"));
    renderConversationPicker();
    renderCurrentConversation();
    if (!message.ok && !message.stopped && message.error?.message) showChatNotice(message.error.message);
    return;
  }
  if (message.type === "CHAT_ERROR" && message.error?.message) {
    setChatRunState(false, message.error.message);
    showChatNotice(message.error.message);
  }
}

function showChatView(save = true) {
  document.querySelectorAll(".function-tab").forEach((tab) => {
    const active = tab.id === "tab-chat";
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.id === "view-chat";
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  if (save) localStorage.setItem(VIEW_KEY, CHAT_VIEW);
  document.querySelector("#tab-chat")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderCurrentConversation();
}

function openExistingView(name, focusSelector = null) {
  closeCommandPalette();
  const tab = document.querySelector(`.function-tab[data-view="${name}"]`);
  if (!tab) return;
  tab.click();
  if (focusSelector) setTimeout(() => document.querySelector(focusSelector)?.focus(), 0);
}

async function createNewChat() {
  closeCommandPalette();
  showChatView();
  chatState.port?.postMessage({ type: "CREATE_CHAT" });
  document.querySelector("#chatInput")?.focus();
}

async function refreshChatProvider() {
  const response = await sendRuntime({ type: "GET_SETTINGS" });
  if (!response?.ok) return;
  chatState.provider = response.settings;
  const model = String(response.settings?.model || "Choose a model");
  const baseUrl = String(response.settings?.baseUrl || "");
  const host = safeHost(baseUrl);
  document.querySelector("#chatModelName").textContent = model;
  const needsKey = response.settings?.kind === "openai";
  document.querySelector("#chatConnectionStatus").textContent = needsKey && !response.hasSecret ? "Needs a secret key" : `Configured · ${host}`;
  document.querySelector("#chatDestinationText").textContent = `Where this message goes: ${model} at ${host}. Page context is sent only when you turn it on.`;
}

async function sendChatMessage() {
  if (chatState.activeRunId) return;
  const input = document.querySelector("#chatInput");
  const text = input?.value.trim();
  if (!text) { showChatNotice("Type a message before sending it."); input?.focus(); return; }

  const settingsResponse = await sendRuntime({ type: "GET_SETTINGS" });
  if (!settingsResponse?.ok) { showChatNotice("Open Connect AI and choose a model first."); return; }
  const settings = settingsResponse.settings;
  if (!(await requestOriginPermission(settings.baseUrl))) {
    showChatNotice("Chrome access to this AI address was not approved. Open Connect AI and test the connection first.");
    return;
  }

  let tab = null;
  if (chatState.useCurrentPage) {
    const active = await sendRuntime({ type: "GET_ACTIVE_TAB" });
    if (!active?.ok) { showChatNotice(active?.error?.message || "BrowserCrew could not use the current page."); return; }
    if (!(await requestOriginPermission(active.tab.url))) {
      showChatNotice("Current-page context was not sent because site access was not approved.");
      return;
    }
    tab = active.tab;
    const summary = document.querySelector("#chatContextSummary");
    summary.hidden = false;
    summary.textContent = `✓ This message may use visible text from: ${active.tab.title} — ${safeHost(active.tab.url)}`;
  }

  if (!chatState.currentConversationId) {
    chatState.port?.postMessage({ type: "CREATE_CHAT" });
    await waitForConversationId();
  }

  appendOptimisticUserMessage(text, tab);
  input.value = "";
  chatState.port?.postMessage({
    type: "START_CHAT",
    payload: { conversationId: chatState.currentConversationId, text, tab }
  });
}

async function stopChatRun() {
  if (!chatState.activeRunId) return;
  document.querySelector("#chatRunStatus").textContent = "Stopping…";
  chatState.port?.postMessage({ type: "STOP_CHAT_RUN", runId: chatState.activeRunId });
}

function renderConversationPicker() {
  const select = document.querySelector("#chatConversationSelect");
  if (!select) return;
  select.replaceChildren();
  const fresh = document.createElement("option");
  fresh.value = "";
  fresh.textContent = "New chat";
  select.append(fresh);
  for (const conversation of chatState.conversations) {
    const option = document.createElement("option");
    option.value = conversation.id;
    option.textContent = conversation.title || "Saved chat";
    select.append(option);
  }
  select.value = chatState.currentConversationId || "";
}

function onConversationSelected(event) {
  const id = event.currentTarget.value;
  if (!id) { createNewChat(); return; }
  chatState.currentConversationId = id;
  chatState.streamingText = "";
  renderCurrentConversation();
}

function renderCurrentConversation() {
  const conversation = findLocalConversation(chatState.currentConversationId);
  const messages = conversation?.messages || [];
  const list = document.querySelector("#chatMessages");
  const empty = document.querySelector("#chatEmptyState");
  if (!list || !empty) return;
  list.replaceChildren();
  empty.hidden = Boolean(messages.length || chatState.streamingText);
  for (const message of messages) list.append(createMessageNode(message));
  if (chatState.streamingText) list.append(createStreamingNode(chatState.streamingText));
  renderActivity(conversation?.activity || []);
  if (conversation?.status === "running" && !chatState.activeRunId) {
    document.querySelector("#chatRunStatus").textContent = "Response is running in the background";
  }
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function createMessageNode(message) {
  const article = document.createElement("article");
  article.className = `chat-message chat-message-${message.role}`;
  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  const who = document.createElement("strong");
  who.textContent = message.role === "assistant" ? (message.model || "BrowserCrew") : "You";
  const time = document.createElement("time");
  time.dateTime = message.createdAt || "";
  time.textContent = message.createdAt ? new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  meta.append(who, time);
  const body = document.createElement("div");
  body.className = "chat-message-body";
  body.textContent = String(message.text || "");
  article.append(meta, body);
  if (message.context?.pageIncluded) {
    const context = document.createElement("small");
    context.className = "chat-message-context";
    context.textContent = `Used current page: ${message.context.pageTitle || safeHost(message.context.pageUrl)}`;
    article.append(context);
  }
  return article;
}

function createStreamingNode(text) {
  const node = createMessageNode({ role: "assistant", text, model: chatState.provider?.model || "BrowserCrew", createdAt: new Date().toISOString() });
  node.id = "chatStreamingMessage";
  node.classList.add("is-streaming");
  return node;
}

function renderStreamingBubble() {
  renderCurrentConversation();
}

function appendOptimisticUserMessage(text, tab) {
  const list = document.querySelector("#chatMessages");
  document.querySelector("#chatEmptyState").hidden = true;
  list?.append(createMessageNode({
    role: "user", text, createdAt: new Date().toISOString(),
    context: tab ? { pageIncluded: true, pageTitle: tab.title, pageUrl: tab.url } : { pageIncluded: false }
  }));
  if (list) list.scrollTop = list.scrollHeight;
}

function renderActivity(activity) {
  const list = document.querySelector("#chatActivityList");
  if (!list) return;
  list.replaceChildren();
  for (const event of activity.slice(-80)) {
    const item = document.createElement("li");
    item.className = `activity-event activity-${String(event.type || "event").replace(/[^a-z0-9_-]/gi, "-")}`;
    const top = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = activityLabel(event.type);
    const time = document.createElement("time");
    time.dateTime = event.at || "";
    time.textContent = event.at ? new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    top.append(label, time);
    const summary = document.createElement("p");
    summary.textContent = String(event.summary || "");
    item.append(top, summary);
    list.append(item);
  }
  const last = activity.at(-1);
  document.querySelector("#chatActivityStatus").textContent = last ? activityLabel(last.type) : "Ready";
}

function activityLabel(type) {
  const labels = {
    "plan.summary": "Plan",
    "reasoning.summary": "Reasoning summary",
    "model.request.started": "Model started",
    "model.request.completed": "Model finished",
    "model.switched": "Model switched",
    "tool.started": "Tool started",
    "tool.completed": "Tool finished",
    "approval.requested": "Approval needed",
    "checkpoint.saved": "Saved",
    "retry": "Retry",
    "warning": "Warning",
    "error": "Error",
    "verification": "Verified",
    "done": "Done"
  };
  return labels[type] || "Activity";
}

function toggleActivity() {
  const toggle = document.querySelector("#chatActivityToggle");
  setActivityOpen(toggle?.getAttribute("aria-expanded") !== "true");
}

function setActivityOpen(open) {
  const toggle = document.querySelector("#chatActivityToggle");
  const body = document.querySelector("#chatActivityBody");
  if (!toggle || !body) return;
  toggle.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
  if (open) body.scrollIntoView({ block: "nearest" });
}

function setChatRunState(running, statusText) {
  const send = document.querySelector("#chatSendButton");
  const stop = document.querySelector("#chatStopButton");
  const input = document.querySelector("#chatInput");
  if (send) send.hidden = running;
  if (stop) stop.hidden = !running;
  if (input) input.disabled = running;
  document.querySelector("#chatRunStatus").textContent = statusText || (running ? "Working…" : "Ready");
}

function showChatNotice(message) {
  const status = document.querySelector("#chatRunStatus");
  if (status) status.textContent = String(message || "Something went wrong.");
}

function onGlobalKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    event.stopImmediatePropagation();
    const palette = document.querySelector("#commandPalette");
    if (palette?.hidden) openCommandPalette(); else closeCommandPalette();
    return;
  }
  if (event.key === "Escape" && !document.querySelector("#commandPalette")?.hidden) {
    event.preventDefault();
    closeCommandPalette();
    return;
  }
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && event.target.closest?.(".function-tabs")) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const tabs = [...document.querySelectorAll(".function-tab")];
    const current = tabs.indexOf(event.target.closest(".function-tab"));
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    tabs[next].focus();
    if (tabs[next].id === "tab-chat") showChatView(); else tabs[next].click();
  }
}

function openCommandPalette() {
  const palette = document.querySelector("#commandPalette");
  if (!palette) return;
  palette.hidden = false;
  chatState.commandIndex = 0;
  const search = document.querySelector("#commandSearch");
  search.value = "";
  renderCommands();
  requestAnimationFrame(() => search.focus());
}

function closeCommandPalette() {
  const palette = document.querySelector("#commandPalette");
  if (palette) palette.hidden = true;
}

function commandDefinitions() {
  return [
    { label: "New chat", hint: "Chat", run: createNewChat },
    { label: "Focus message box", hint: "Chat", run: () => { showChatView(); closeCommandPalette(); document.querySelector("#chatInput")?.focus(); } },
    { label: chatState.useCurrentPage ? "Stop using current page" : "Use current page", hint: "Context", run: () => { showChatView(); const box = document.querySelector("#chatUseCurrentPage"); box.checked = !box.checked; box.dispatchEvent(new Event("change", { bubbles: true })); closeCommandPalette(); } },
    { label: "Open Live Activity", hint: "Chat", run: () => { showChatView(); setActivityOpen(true); closeCommandPalette(); } },
    { label: "Stop current response", hint: "Control", disabled: !chatState.activeRunId, run: () => { closeCommandPalette(); stopChatRun(); } },
    { label: "Switch model / AI connection", hint: "Connect AI", run: () => openExistingView("ai", "#modelInput") },
    { label: "Open Workspace", hint: "View", run: () => openExistingView("workspace") },
    { label: "Open Tools", hint: "View", run: () => openExistingView("tools") },
    { label: "Open Skills", hint: "View", run: () => openExistingView("skills") },
    { label: "Open Memory", hint: "View", run: () => openExistingView("memory") },
    { label: "Open History", hint: "View", run: () => openExistingView("history") },
    { label: "Open Settings", hint: "View", run: () => openExistingView("settings") }
  ];
}

function renderCommands() {
  const list = document.querySelector("#commandList");
  const query = document.querySelector("#commandSearch")?.value.trim().toLowerCase() || "";
  const commands = commandDefinitions().filter((command) => matchesCommand(command.label, query));
  if (!commands.length) {
    list.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "command-empty";
    empty.textContent = "No matching command.";
    list.append(empty);
    return;
  }
  chatState.commandIndex = Math.min(chatState.commandIndex, commands.length - 1);
  list.replaceChildren();
  commands.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-item tactile";
    button.dataset.commandIndex = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === chatState.commandIndex));
    button.disabled = Boolean(command.disabled);
    const name = document.createElement("strong");
    name.textContent = command.label;
    const hint = document.createElement("span");
    hint.textContent = command.hint;
    button.append(name, hint);
    button.addEventListener("click", () => { if (!command.disabled) command.run(); });
    list.append(button);
  });
}

function onCommandKeydown(event) {
  const query = event.currentTarget.value.trim().toLowerCase();
  const commands = commandDefinitions().filter((command) => matchesCommand(command.label, query));
  if (!commands.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    chatState.commandIndex = (chatState.commandIndex + 1) % commands.length;
    renderCommands();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    chatState.commandIndex = (chatState.commandIndex - 1 + commands.length) % commands.length;
    renderCommands();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const command = commands[chatState.commandIndex];
    if (command && !command.disabled) command.run();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
}

function matchesCommand(label, query) {
  if (!query) return true;
  const words = query.split(/\s+/).filter(Boolean);
  const haystack = label.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function upsertLocalConversation(conversation) {
  const index = chatState.conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) chatState.conversations[index] = conversation;
  else chatState.conversations.unshift(conversation);
  chatState.conversations.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function findLocalConversation(id) {
  return chatState.conversations.find((item) => item.id === id) || null;
}

function waitForConversationId() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      if (chatState.currentConversationId) return resolve(chatState.currentConversationId);
      if (Date.now() > deadline) return reject(new Error("Chat could not create a saved conversation."));
      setTimeout(check, 30);
    };
    check();
  });
}

function sendRuntime(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function requestOriginPermission(urlText) {
  let url;
  try { url = new URL(urlText); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const origins = [`${url.origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

function safeHost(urlText) {
  try { return new URL(urlText).hostname; } catch { return "unknown destination"; }
}
