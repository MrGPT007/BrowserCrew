const CHAT_TOOL_GRANT_KEY = "browsercrew.chatPendingToolGrant.v1";
const CHAT_STORAGE_KEY = "browsercrew.conversations.v1";
const PAGE_READ_TOOL = "page.read";
let decorateTimer = null;

installChatToolsSurface();
document.addEventListener("DOMContentLoaded", initChatToolsUi);

function installChatToolsSurface() {
  if (document.querySelector("#chatToolsCard")) return;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "src/styles/chat-tools.css";
  document.head.append(css);

  const contextCard = document.querySelector(".chat-context-card");
  if (!contextCard) return;
  const card = document.createElement("article");
  card.className = "card chat-tools-card";
  card.id = "chatToolsCard";
  card.innerHTML = `
    <div class="card-heading">
      <div><p class="step-label">TOOLS FOR THIS MESSAGE</p><h2>Let the AI read one page if it needs to</h2></div>
      <span class="badge badge-safe">Read only</span>
    </div>
    <label class="chat-tool-choice" for="chatEnablePageReadTool">
      <input id="chatEnablePageReadTool" type="checkbox" />
      <span>
        <strong>Allow one page read</strong>
        <small>BrowserCrew locks this to the exact tab you choose now. The AI can ask for one bounded read, but it cannot choose another address or change the page.</small>
      </span>
    </label>
    <div class="chat-tool-grant-summary" id="chatToolGrantSummary" hidden></div>
    <p class="helper">This permission is used once, for the next message only. Turn it on again for another message. Site text is sent only if the AI actually requests the tool.</p>`;
  contextCard.after(card);
}

async function initChatToolsUi() {
  const checkbox = document.querySelector("#chatEnablePageReadTool");
  checkbox?.addEventListener("change", onToolChoiceChanged);
  document.querySelector("#chatConversationSelect")?.addEventListener("change", clearToolGrant);
  document.querySelector("#chatNewButton")?.addEventListener("click", clearToolGrant);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[CHAT_TOOL_GRANT_KEY] && !changes[CHAT_TOOL_GRANT_KEY].newValue) resetToolUi();
    if (area === "local" && changes[CHAT_STORAGE_KEY]) scheduleDecorateToolEvents();
  });

  const messages = document.querySelector("#chatMessages");
  if (messages) new MutationObserver(scheduleDecorateToolEvents).observe(messages, { childList: true });
  await restoreToolGrant();
  scheduleDecorateToolEvents();
}

async function onToolChoiceChanged(event) {
  if (!event.currentTarget.checked) {
    await clearToolGrant();
    return;
  }
  await stagePageReadGrant();
}

async function stagePageReadGrant() {
  const checkbox = document.querySelector("#chatEnablePageReadTool");
  const summary = document.querySelector("#chatToolGrantSummary");
  if (checkbox) checkbox.disabled = true;
  if (summary) {
    summary.hidden = false;
    summary.textContent = "Checking the page you want to allow…";
  }

  try {
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    if (!active?.ok || !active?.tab?.id || !active?.tab?.url) throw new Error(active?.error?.message || "BrowserCrew could not identify the current tab.");
    const url = new URL(active.tab.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Choose a normal website tab before enabling the page-read tool.");
    const pattern = `${url.origin}/*`;
    let allowed = await chrome.permissions.contains({ origins: [pattern] });
    if (!allowed) allowed = await chrome.permissions.request({ origins: [pattern] });
    if (!allowed) throw new Error("Chrome site access was not approved, so the page-read tool stayed off.");

    const scope = document.querySelector("#chatConversationSelect")?.value || "new";
    const grant = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      scope,
      tools: [PAGE_READ_TOOL],
      actionClass: "read_only",
      maxToolCalls: 1,
      tab: {
        id: active.tab.id,
        url: active.tab.url,
        title: String(active.tab.title || "Untitled page").slice(0, 240)
      },
      grantedAt: new Date().toISOString()
    };
    await chrome.storage.session.set({ [CHAT_TOOL_GRANT_KEY]: grant });
    if (checkbox) checkbox.checked = true;
    if (summary) {
      summary.hidden = false;
      summary.innerHTML = `<strong>Allowed once:</strong> ${escapeHtml(grant.tab.title)} — ${escapeHtml(url.hostname)}<br><span>The AI may request one read of this exact address. Nothing is read until it asks.</span>`;
    }
  } catch (error) {
    await chrome.storage.session.remove(CHAT_TOOL_GRANT_KEY);
    if (checkbox) checkbox.checked = false;
    if (summary) {
      summary.hidden = false;
      summary.textContent = error?.message || "BrowserCrew could not enable this tool safely.";
    }
    notifyTool(error?.message || "BrowserCrew could not enable this tool safely.");
  } finally {
    if (checkbox) checkbox.disabled = false;
  }
}

async function restoreToolGrant() {
  const stored = await chrome.storage.session.get(CHAT_TOOL_GRANT_KEY);
  const grant = stored[CHAT_TOOL_GRANT_KEY];
  if (!grant?.tab?.url || !grant?.tools?.includes(PAGE_READ_TOOL)) return;
  const scope = document.querySelector("#chatConversationSelect")?.value || "new";
  if (grant.scope !== "new" && scope && grant.scope !== scope) {
    await clearToolGrant();
    return;
  }
  const checkbox = document.querySelector("#chatEnablePageReadTool");
  const summary = document.querySelector("#chatToolGrantSummary");
  if (checkbox) checkbox.checked = true;
  if (summary) {
    summary.hidden = false;
    summary.innerHTML = `<strong>Allowed once:</strong> ${escapeHtml(grant.tab.title || "Approved page")} — ${escapeHtml(safeHost(grant.tab.url))}<br><span>The AI may request one read of this exact address. Nothing is read until it asks.</span>`;
  }
}

async function clearToolGrant() {
  await chrome.storage.session.remove(CHAT_TOOL_GRANT_KEY);
  resetToolUi();
}

function resetToolUi() {
  const checkbox = document.querySelector("#chatEnablePageReadTool");
  const summary = document.querySelector("#chatToolGrantSummary");
  if (checkbox) { checkbox.checked = false; checkbox.disabled = false; }
  if (summary) { summary.hidden = true; summary.textContent = ""; }
}

function scheduleDecorateToolEvents() {
  clearTimeout(decorateTimer);
  decorateTimer = setTimeout(decorateToolEvents, 0);
}

async function decorateToolEvents() {
  const list = document.querySelector("#chatMessages");
  const conversationId = document.querySelector("#chatConversationSelect")?.value;
  if (!list || !conversationId) return;
  const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
  const conversation = (stored[CHAT_STORAGE_KEY] || []).find((item) => item.id === conversationId);
  if (!conversation) return;
  const events = (conversation.activity || []).filter((event) => ["tool.authorized", "tool.completed", "verification"].includes(event.type) && event.meta?.tool === PAGE_READ_TOOL).slice(-6);
  const fingerprint = events.map((event) => event.id).join(":");
  const existing = list.querySelector(".chat-inline-tool-stack");
  if (!events.length) { existing?.remove(); return; }
  if (existing?.dataset.fingerprint === fingerprint) return;
  existing?.remove();

  const stack = document.createElement("div");
  stack.className = "chat-inline-tool-stack";
  stack.dataset.fingerprint = fingerprint;
  stack.setAttribute("aria-label", "Tool results for this chat");
  for (const event of events) {
    const card = document.createElement("article");
    card.className = `chat-inline-tool-card chat-inline-tool-${event.type.replace(".", "-")}`;
    const title = event.type === "tool.authorized" ? "Tool permission" : event.type === "tool.completed" ? "Page read result" : "Tool check";
    const detail = event.type === "tool.completed" && event.meta
      ? `${event.meta.pageTitle || "Approved page"} · ${Number(event.meta.characters || 0).toLocaleString()} characters`
      : event.type === "tool.authorized"
        ? "Read only · one message · exact approved tab"
        : "Exact tab and page address checked";
    card.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(event.summary || "")}</p><small>${escapeHtml(detail)}</small>`;
    stack.append(card);
  }
  list.append(stack);
}

function notifyTool(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyTool.timer);
  notifyTool.timer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function safeHost(value) {
  try { return new URL(value).hostname; } catch { return "unknown site"; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
