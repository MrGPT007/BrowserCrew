const CONNECTIONS_PORT = "browsercrew-connections";

const connectionUiState = {
  port: null,
  connections: [],
  activeId: null,
  editingId: null,
  pendingSwitchId: null,
  pendingRpc: new Map()
};

installConnectionUi();
document.addEventListener("DOMContentLoaded", initConnectionUi);

function installConnectionUi() {
  if (document.querySelector("#chatConnectionPicker")) return;

  const chatCard = document.querySelector(".chat-connection-card");
  if (chatCard) {
    const wrap = document.createElement("div");
    wrap.className = "connection-picker-wrap";
    wrap.innerHTML = `
      <label class="field-label" for="chatConnectionPicker">AI connection for the next message</label>
      <div class="connection-picker-row">
        <select id="chatConnectionPicker" aria-label="AI connection for the next message"></select>
        <button class="button button-small tactile" id="manageConnectionsButton" type="button">Manage</button>
      </div>
      <p class="helper">Choose which saved AI receives your next message. If this chat already has messages, BrowserCrew asks before moving that context to a different provider.</p>`;
    chatCard.append(wrap);
  }

  const aiView = document.querySelector("#view-ai");
  const heading = aiView?.querySelector(".view-heading");
  if (aiView && heading) {
    const card = document.createElement("article");
    card.className = "card connection-registry-card";
    card.id = "connectionRegistryCard";
    card.innerHTML = `
      <div class="card-heading"><div><p class="step-label">SAVED AI CONNECTIONS</p><h2>Keep more than one AI ready</h2></div><span class="badge" id="connectionCountBadge">0 saved</span></div>
      <p class="helper">A saved connection remembers the provider, model, and address. Secret keys stay in Chrome's session storage and are never copied into this list.</p>
      <label class="field-label" for="connectionNameInput">Name this connection</label>
      <input id="connectionNameInput" type="text" maxlength="80" autocomplete="off" placeholder="Example: Local Qwen, Work OpenAI, or Work Claude" />
      <p class="helper">Use the provider, model, address, and optional key in the setup fields below. Then save and test this named connection.</p>
      <div class="button-row">
        <button class="button tactile" id="newConnectionButton" type="button">New connection</button>
        <button class="button button-primary tactile" id="saveConnectionButton" type="button">Save and test connection</button>
      </div>
      <div class="connection-list" id="connectionList" aria-live="polite"></div>`;
    heading.insertAdjacentElement("afterend", card);
  }

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "src/styles/connections.css";
  document.head.append(style);

  const review = document.createElement("div");
  review.className = "connection-transfer-backdrop";
  review.id = "connectionTransferReview";
  review.hidden = true;
  review.innerHTML = `
    <section class="connection-transfer-card" role="dialog" aria-modal="true" aria-labelledby="connectionTransferTitle">
      <p class="eyebrow">CHECK BEFORE SWITCHING</p>
      <h2 id="connectionTransferTitle">Send this chat to a different AI?</h2>
      <p id="connectionTransferCopy">This chat already contains messages.</p>
      <div class="warning-box">⚠️ Switching changes where future messages go. The next request may include the existing conversation so the new AI can continue it. Page or document context is sent only when you separately include it.</div>
      <div class="button-row"><button class="button tactile" id="cancelConnectionSwitchButton" type="button">Keep current AI</button><button class="button button-primary tactile" id="confirmConnectionSwitchButton" type="button">Switch AI for this chat</button></div>
    </section>`;
  document.body.append(review);
}

function initConnectionUi() {
  connectionUiState.port = chrome.runtime.connect({ name: CONNECTIONS_PORT });
  connectionUiState.port.onMessage.addListener(onConnectionMessage);
  connectionUiState.port.onDisconnect.addListener(() => {
    for (const pending of connectionUiState.pendingRpc.values()) pending.reject(new Error("AI connection manager restarted."));
    connectionUiState.pendingRpc.clear();
  });

  document.querySelector("#manageConnectionsButton")?.addEventListener("click", () => document.querySelector("#tab-ai")?.click());
  document.querySelector("#newConnectionButton")?.addEventListener("click", startNewConnection);
  document.querySelector("#saveConnectionButton")?.addEventListener("click", saveAndTestConnection);
  document.querySelector("#connectionList")?.addEventListener("click", onConnectionListClick);
  document.querySelector("#chatConnectionPicker")?.addEventListener("change", onChatConnectionChange);
  document.querySelector("#cancelConnectionSwitchButton")?.addEventListener("click", cancelPendingSwitch);
  document.querySelector("#confirmConnectionSwitchButton")?.addEventListener("click", confirmPendingSwitch);
  document.querySelector("#connectionTransferReview")?.addEventListener("click", (event) => {
    if (event.target.id === "connectionTransferReview") cancelPendingSwitch();
  });

  rpc("GET_CONNECTIONS").catch(showConnectionNotice);
}

function onConnectionMessage(message) {
  if (message?.requestId && connectionUiState.pendingRpc.has(message.requestId)) {
    const pending = connectionUiState.pendingRpc.get(message.requestId);
    connectionUiState.pendingRpc.delete(message.requestId);
    if (message.ok === false && message.type === "CONNECTION_ERROR") pending.reject(new Error(message.error?.message || "AI connection request failed."));
    else pending.resolve(message);
  }
  if (message?.connections) applyConnectionState(message);
}

function applyConnectionState(message) {
  connectionUiState.connections = Array.isArray(message.connections) ? message.connections : [];
  connectionUiState.activeId = message.activeId || connectionUiState.connections[0]?.id || null;
  if (!connectionUiState.editingId || !connectionUiState.connections.some((item) => item.id === connectionUiState.editingId)) connectionUiState.editingId = connectionUiState.activeId;
  renderConnectionPicker();
  renderConnectionList();
  if (!document.querySelector("#connectionNameInput")?.value && connectionUiState.editingId) {
    const profile = getConnection(connectionUiState.editingId);
    if (profile) document.querySelector("#connectionNameInput").value = profile.name;
  }
}

function renderConnectionPicker() {
  const picker = document.querySelector("#chatConnectionPicker");
  if (!picker) return;
  picker.replaceChildren();
  for (const profile of connectionUiState.connections) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} — ${profile.model} · ${statusLabel(profile.status)}`;
    picker.append(option);
  }
  if (connectionUiState.activeId) picker.value = connectionUiState.activeId;
}

function renderConnectionList() {
  const list = document.querySelector("#connectionList");
  const badge = document.querySelector("#connectionCountBadge");
  if (!list || !badge) return;
  badge.textContent = `${connectionUiState.connections.length} saved`;
  list.replaceChildren();
  for (const profile of connectionUiState.connections) {
    const card = document.createElement("article");
    card.className = "connection-item";
    if (profile.id === connectionUiState.activeId) card.classList.add("is-active");

    const main = document.createElement("div");
    main.className = "connection-item-main";
    const title = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = profile.name;
    const detail = document.createElement("p");
    detail.textContent = `${profile.model} · ${safeHost(profile.baseUrl)}`;
    title.append(strong, detail);
    const status = document.createElement("span");
    status.className = `connection-status status-${profile.status || "not_tested"}`;
    status.textContent = `${statusSymbol(profile.status)} ${profile.id === connectionUiState.activeId ? "Active · " : ""}${statusLabel(profile.status)}`;
    main.append(title, status);

    const note = document.createElement("p");
    note.className = "connection-secret-note";
    const cloudKeyProvider = profile.kind === "openai" || profile.kind === "anthropic";
    note.textContent = cloudKeyProvider
      ? (profile.hasSecret ? "Secret key is available for this Chrome session." : "No secret key is available for this Chrome session.")
      : "Local connection · secret key usually not needed.";

    const actions = document.createElement("div");
    actions.className = "connection-actions";
    for (const [label, action, danger] of [["Use", "use", false], ["Edit", "edit", false], ["Test", "test", false], ["Delete", "delete", true]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `button button-small tactile${danger ? " button-danger" : ""}`;
      button.dataset.connectionAction = action;
      button.dataset.connectionId = profile.id;
      button.textContent = label;
      actions.append(button);
    }
    card.append(main, note, actions);
    list.append(card);
  }
}

function startNewConnection() {
  connectionUiState.editingId = null;
  document.querySelector("#connectionNameInput").value = "";
  document.querySelector("#apiKeyInput").value = "";
  document.querySelector("#connectionNameInput").focus();
  showConnectionNotice("New connection: choose the provider and model below, then save and test it.");
}

async function saveAndTestConnection() {
  const name = document.querySelector("#connectionNameInput").value.trim();
  if (!name) { showConnectionNotice("Give this connection a short name first."); document.querySelector("#connectionNameInput").focus(); return; }
  const selectedProvider = document.querySelector(".provider-card.is-selected")?.dataset.provider || "openai";
  const model = document.querySelector("#modelInput").value.trim();
  const baseUrl = document.querySelector("#serverInput").value.trim();
  const typedSecret = document.querySelector("#apiKeyInput").value;
  if (!model || !baseUrl) { showConnectionNotice("Enter the model name and AI service address before saving this connection."); return; }

  setConnectionButtonBusy(true);
  let saved;
  try {
    saved = await rpc("SAVE_CONNECTION", {
      connection: { id: connectionUiState.editingId, name, kind: selectedProvider, model, baseUrl, activate: true },
      secret: typedSecret || undefined
    });
    connectionUiState.editingId = saved.connection?.id || saved.activeId;
    const permission = await requestOriginPermission(baseUrl);
    if (!permission) {
      showConnectionNotice("Connection saved, but Chrome access to this AI address was not approved, so it was not tested.");
      return;
    }
    const tested = await rpc("TEST_CONNECTION", { connectionId: connectionUiState.editingId });
    if (tested.ok) showConnectionNotice(`✓ Connected. ${tested.model} answered in about ${tested.latencyMs} ms.`);
    else showConnectionNotice(tested.error?.message || "Connection saved, but the test failed.");
    document.querySelector("#apiKeyInput").value = "";
  } catch (error) {
    showConnectionNotice(error.message || "BrowserCrew could not save this connection.");
  } finally {
    setConnectionButtonBusy(false);
  }
}

async function onConnectionListClick(event) {
  const button = event.target.closest("[data-connection-action]");
  if (!button) return;
  const id = button.dataset.connectionId;
  const action = button.dataset.connectionAction;
  if (action === "use") return requestConnectionSwitch(id);
  if (action === "edit") return editConnection(id);
  if (action === "test") return testSavedConnection(id);
  if (action === "delete") return deleteSavedConnection(id);
}

function editConnection(id) {
  const profile = getConnection(id);
  if (!profile) return;
  connectionUiState.editingId = id;
  document.querySelector("#connectionNameInput").value = profile.name;
  document.querySelector(`.provider-card[data-provider="${profile.kind}"]`)?.click();
  document.querySelector("#modelInput").value = profile.model;
  document.querySelector("#serverInput").value = profile.baseUrl;
  document.querySelector("#apiKeyInput").value = "";
  document.querySelector("#connectionNameInput").scrollIntoView({ block: "center" });
  document.querySelector("#connectionNameInput").focus();
  showConnectionNotice(profile.hasSecret ? "Editing this connection. Leave the secret-key box empty to keep its current session key." : "Editing this connection. Add a key only if this provider needs one.");
}

async function testSavedConnection(id) {
  const profile = getConnection(id);
  if (!profile) return;
  if (!(await requestOriginPermission(profile.baseUrl))) { showConnectionNotice("Chrome access to this AI address was not approved, so the connection was not tested."); return; }
  try {
    const tested = await rpc("TEST_CONNECTION", { connectionId: id });
    showConnectionNotice(tested.ok ? `✓ ${profile.name} connected successfully.` : (tested.error?.message || `${profile.name} could not connect.`));
  } catch (error) { showConnectionNotice(error.message); }
}

async function deleteSavedConnection(id) {
  const profile = getConnection(id);
  if (!profile) return;
  if (!confirm(`Delete the saved AI connection “${profile.name}”? This removes its session key from BrowserCrew too.`)) return;
  try {
    await rpc("DELETE_CONNECTION", { connectionId: id });
    showConnectionNotice(`${profile.name} was deleted.`);
  } catch (error) { showConnectionNotice(error.message); }
}

function onChatConnectionChange(event) {
  const requestedId = event.currentTarget.value;
  if (requestedId === connectionUiState.activeId) return;
  event.currentTarget.value = connectionUiState.activeId || "";
  requestConnectionSwitch(requestedId);
}

function requestConnectionSwitch(id) {
  const profile = getConnection(id);
  if (!profile || id === connectionUiState.activeId) return;
  const hasConversation = Boolean(document.querySelector("#chatMessages .chat-message"));
  if (!hasConversation) return activateSavedConnection(id);
  connectionUiState.pendingSwitchId = id;
  const review = document.querySelector("#connectionTransferReview");
  const copy = document.querySelector("#connectionTransferCopy");
  copy.textContent = `This chat already has messages. Switching to ${profile.name} (${profile.model} at ${safeHost(profile.baseUrl)}) means the next request may send the existing conversation to that destination so it can continue the chat.`;
  review.hidden = false;
  document.querySelector("#confirmConnectionSwitchButton")?.focus();
}

function cancelPendingSwitch() {
  connectionUiState.pendingSwitchId = null;
  document.querySelector("#connectionTransferReview").hidden = true;
  const picker = document.querySelector("#chatConnectionPicker");
  if (picker && connectionUiState.activeId) picker.value = connectionUiState.activeId;
}

async function confirmPendingSwitch() {
  const id = connectionUiState.pendingSwitchId;
  if (!id) return cancelPendingSwitch();
  connectionUiState.pendingSwitchId = null;
  document.querySelector("#connectionTransferReview").hidden = true;
  await activateSavedConnection(id);
}

async function activateSavedConnection(id) {
  try {
    const response = await rpc("ACTIVATE_CONNECTION", { connectionId: id });
    const profile = response.connection || getConnection(id);
    if (profile) applyProfileToSetupUi(profile);
    showConnectionNotice(`Now using ${profile?.name || "the selected AI connection"}.`);
  } catch (error) { showConnectionNotice(error.message); }
}

function applyProfileToSetupUi(profile) {
  document.querySelector(`.provider-card[data-provider="${profile.kind}"]`)?.click();
  document.querySelector("#modelInput").value = profile.model;
  document.querySelector("#serverInput").value = profile.baseUrl;
  document.querySelector("#apiKeyInput").value = "";
}

function setConnectionButtonBusy(busy) {
  const button = document.querySelector("#saveConnectionButton");
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? "Saving and testing…" : "Save and test connection";
}

function showConnectionNotice(message) {
  const box = document.querySelector("#connectionResult");
  if (box) {
    box.hidden = false;
    box.className = "connection-result";
    box.textContent = String(message || "");
  }
}

function getConnection(id) {
  return connectionUiState.connections.find((item) => item.id === id) || null;
}

function statusLabel(status) {
  if (status === "connected") return "Connected";
  if (status === "failed") return "Test failed";
  if (status === "permission_needed") return "Permission needed";
  return "Not tested";
}

function statusSymbol(status) {
  if (status === "connected") return "●";
  if (status === "failed") return "×";
  if (status === "permission_needed") return "!";
  return "○";
}

function safeHost(urlText) {
  try { return new URL(urlText).hostname; } catch { return "unknown destination"; }
}

function rpc(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      connectionUiState.pendingRpc.delete(requestId);
      reject(new Error("BrowserCrew's AI connection manager did not answer in time."));
    }, 35000);
    connectionUiState.pendingRpc.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    connectionUiState.port.postMessage({ type, requestId, ...payload });
  });
}

async function requestOriginPermission(urlText) {
  let url;
  try { url = new URL(urlText); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const origins = [`${url.origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}
