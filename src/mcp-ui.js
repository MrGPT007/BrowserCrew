const MCP_PORT = "browsercrew-mcp";
const MCP_SERVERS_KEY = "browsercrew.mcpServers.v1";
const MCP_ACTIONS_KEY = "browsercrew.mcpActions.v1";
const mcpUiState = { port: null, servers: [], pendingWrite: null, requestId: 0, pending: new Map() };

installMcpSurface();
document.addEventListener("DOMContentLoaded", initMcpUi);

function installMcpSurface() {
  const toolsView = document.querySelector("#view-tools");
  if (toolsView && !document.querySelector("#mcpManagerCard")) {
    const oldExternal = [...toolsView.querySelectorAll("article.card")].find((card) => /Tool-server connections are not active yet/i.test(card.textContent || ""));
    if (oldExternal) oldExternal.hidden = true;
    const card = document.createElement("article");
    card.className = "card";
    card.id = "mcpManagerCard";
    card.innerHTML = `
      <div class="card-heading">
        <div><p class="step-label">EXTERNAL TOOLS · MCP</p><h2>Connect a tool server</h2></div>
        <span class="badge">MCP ${escapeHtml("2026-07-28")}</span>
      </div>
      <p class="helper">A tool server adds abilities from another service. BrowserCrew first discovers its tools, then you decide which ones are read only, which can change data, and which are available in Chat.</p>
      <label class="field-label" for="mcpServerName">Name this tool server</label>
      <input id="mcpServerName" type="text" maxlength="80" autocomplete="off" placeholder="Example: Inventory tools" />
      <p class="helper">Use a name you will recognize when Chat asks to use one of its tools.</p>
      <label class="field-label" for="mcpServerEndpoint">Tool-server address</label>
      <input id="mcpServerEndpoint" type="url" autocomplete="off" placeholder="https://tools.example.com/mcp" />
      <p class="helper">Remote servers must use HTTPS. Plain HTTP works only for a server on this computer, such as <code>http://127.0.0.1:3000/mcp</code>.</p>
      <label class="field-label" for="mcpServerSecret">Bearer token, if this server needs one</label>
      <input id="mcpServerSecret" type="password" autocomplete="off" placeholder="Optional" />
      <p class="helper">This secret stays in Chrome session storage. BrowserCrew does not copy it into saved server profiles, Chat history, or tool activity.</p>
      <div class="example-box">🔐 Connecting does <strong>not</strong> make every discovered tool usable. New tools start as <strong>Needs review</strong>.</div>
      <button class="button button-primary tactile full" id="mcpSaveTestButton" type="button">Save and discover tools</button>
      <div class="connection-result" id="mcpConnectionResult" hidden></div>
      <div class="mcp-server-list" id="mcpServerList"></div>`;
    toolsView.append(card);
  }

  const chatTools = document.querySelector("#chatToolsCard");
  if (chatTools && !document.querySelector("#mcpChatCard")) {
    const card = document.createElement("article");
    card.className = "card mcp-chat-card";
    card.id = "mcpChatCard";
    card.innerHTML = `
      <div class="card-heading">
        <div><p class="step-label">EXTERNAL TOOL FOR THIS MESSAGE</p><h2>Choose one connected MCP tool</h2></div>
        <span class="badge">Optional</span>
      </div>
      <label class="field-label" for="mcpChatToolSelect">External tool</label>
      <select id="mcpChatToolSelect"><option value="">Do not use an external tool</option></select>
      <p class="helper" id="mcpChatToolHelp">Only tools you reviewed and enabled in Tools appear here. Read-only tools can run once for this message. Tools that change data stop for a separate approval first.</p>
      <div class="mcp-chat-selection" id="mcpChatSelection" hidden></div>
      <div class="mcp-write-approval" id="mcpWriteApproval" hidden aria-live="polite"></div>
      <div class="mcp-write-result" id="mcpWriteResult" hidden aria-live="polite"></div>`;
    chatTools.after(card);
  }

  if (!document.querySelector('link[href="src/styles/mcp.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "src/styles/mcp.css";
    document.head.append(css);
  }
}

async function initMcpUi() {
  connectMcpPort();
  bindMcpEvents();
}

function connectMcpPort() {
  try { mcpUiState.port?.disconnect(); } catch {}
  const port = chrome.runtime.connect({ name: MCP_PORT });
  mcpUiState.port = port;
  port.onMessage.addListener(onMcpMessage);
  port.onDisconnect.addListener(() => {
    if (mcpUiState.port === port) {
      mcpUiState.port = null;
      setTimeout(connectMcpPort, 300);
    }
  });
  sendMcp("GET_MCP_STATE").catch(() => {});
}

function bindMcpEvents() {
  document.querySelector("#mcpSaveTestButton")?.addEventListener("click", saveAndTestServer);
  document.querySelector("#mcpServerList")?.addEventListener("click", onServerListClick);
  document.querySelector("#mcpServerList")?.addEventListener("change", onServerListChange);
  document.querySelector("#mcpChatToolSelect")?.addEventListener("change", onChatToolSelected);
  document.querySelector("#mcpWriteApproval")?.addEventListener("click", onApprovalClick);
  document.querySelector("#chatConversationSelect")?.addEventListener("change", clearStagedMcpTool);
  document.querySelector("#chatNewButton")?.addEventListener("click", clearStagedMcpTool);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[MCP_SERVERS_KEY] || changes[MCP_ACTIONS_KEY])) sendMcp("GET_MCP_STATE").catch(() => {});
  });
}

function onMcpMessage(message) {
  if (!message) return;
  if (message.requestId && mcpUiState.pending.has(message.requestId)) {
    const pending = mcpUiState.pending.get(message.requestId);
    mcpUiState.pending.delete(message.requestId);
    if (message.ok === false || message.type === "MCP_ERROR") pending.reject(new Error(message.error?.message || "The tool-server request failed."));
    else pending.resolve(message);
  }
  if (Array.isArray(message.servers)) {
    mcpUiState.servers = message.servers;
    mcpUiState.pendingWrite = message.pendingWrite || null;
    renderMcpState();
  }
  if (message.type === "MCP_WRITE_APPROVAL_REQUIRED" && message.pending) {
    mcpUiState.pendingWrite = message.pending;
    renderWriteApproval(message.pending);
  }
  if (message.type === "MCP_WRITE_DONE") renderWriteResult(message);
  if (message.type === "MCP_WRITE_CANCELLED") {
    mcpUiState.pendingWrite = null;
    const box = document.querySelector("#mcpWriteApproval");
    if (box) { box.hidden = true; box.replaceChildren(); }
    notifyMcp("External change cancelled. The write tool was not called.");
  }
  if (message.type === "MCP_CHAT_ACTIVITY" && message.event) appendMcpActivity(message.event);
}

async function saveAndTestServer() {
  const name = document.querySelector("#mcpServerName")?.value.trim() || "";
  const endpoint = document.querySelector("#mcpServerEndpoint")?.value.trim() || "";
  const secret = document.querySelector("#mcpServerSecret")?.value || "";
  const box = document.querySelector("#mcpConnectionResult");
  const button = document.querySelector("#mcpSaveTestButton");
  setBusy(button, true, "Saving and discovering…");
  try {
    if (!(await requestEndpointPermission(endpoint))) throw new Error("Chrome access to this tool-server address was not approved. Nothing was sent.");
    const saved = await sendMcp("SAVE_MCP_SERVER", { server: { name, endpoint }, secret });
    const serverId = saved.server?.id || saved.servers?.[0]?.id;
    if (!serverId) throw new Error("BrowserCrew could not save that tool server.");
    const tested = await sendMcp("TEST_MCP_SERVER", { serverId });
    if (box) {
      box.hidden = false;
      box.className = "connection-result success";
      box.textContent = `✓ Connected. Found ${tested.toolCount} tool${tested.toolCount === 1 ? "" : "s"}. Review each tool below before Chat can use it.`;
    }
    document.querySelector("#mcpServerSecret").value = "";
    notifyMcp("Tool server connected. Review the discovered tools before enabling them.");
  } catch (error) {
    if (box) { box.hidden = false; box.className = "connection-result error"; box.textContent = error?.message || "BrowserCrew could not connect to this tool server."; }
  } finally { setBusy(button, false, "Save and discover tools"); }
}

async function onServerListClick(event) {
  const button = event.target.closest("button[data-mcp-action]");
  if (!button) return;
  const serverId = button.dataset.serverId;
  const action = button.dataset.mcpAction;
  try {
    if (action === "delete") {
      if (!confirm("Delete this saved tool-server connection? Its session secret and Chat availability will be removed too.")) return;
      await sendMcp("DELETE_MCP_SERVER", { serverId });
      notifyMcp("Tool server deleted from this Chrome profile.");
    } else if (action === "test") {
      const server = mcpUiState.servers.find((item) => item.id === serverId);
      if (!(await requestEndpointPermission(server?.endpoint))) throw new Error("Chrome access to this tool server was not approved.");
      button.disabled = true;
      await sendMcp("TEST_MCP_SERVER", { serverId });
      notifyMcp("Tool list refreshed.");
      button.disabled = false;
    }
  } catch (error) { button.disabled = false; notifyMcp(error?.message || "The tool-server action failed safely."); }
}

async function onServerListChange(event) {
  const policy = event.target.closest("select[data-mcp-policy]");
  const enabled = event.target.closest("input[data-mcp-enabled]");
  try {
    if (policy) {
      await sendMcp("SET_MCP_TOOL_POLICY", { serverId: policy.dataset.serverId, toolName: policy.dataset.toolName, classification: policy.value });
      notifyMcp(policy.value === "review" ? "Tool returned to Needs review and is no longer available in Chat." : "Tool safety classification saved.");
    }
    if (enabled) {
      await sendMcp("SET_MCP_TOOL_ENABLED", { serverId: enabled.dataset.serverId, toolName: enabled.dataset.toolName, enabled: enabled.checked });
      notifyMcp(enabled.checked ? "Tool is now available to choose in Chat." : "Tool removed from Chat choices.");
    }
  } catch (error) {
    notifyMcp(error?.message || "BrowserCrew could not change that tool setting.");
    await sendMcp("GET_MCP_STATE").catch(() => {});
  }
}

async function onChatToolSelected(event) {
  const value = event.currentTarget.value;
  const selection = document.querySelector("#mcpChatSelection");
  if (!value) {
    await clearStagedMcpTool();
    return;
  }
  const [serverId, ...nameParts] = value.split("::");
  const toolName = nameParts.join("::");
  try {
    const scope = document.querySelector("#chatConversationSelect")?.value || "new";
    const response = await sendMcp("STAGE_MCP_CHAT_TOOL", { serverId, toolName, scope });
    const grant = response.grant;
    if (selection) {
      selection.hidden = false;
      selection.innerHTML = grant.classification === "read"
        ? `<strong>Ready once:</strong> ${escapeHtml(grant.toolTitle)} from ${escapeHtml(grant.serverName)}<br><span>If the AI requests it, BrowserCrew will run this read-only tool once for the next message.</span>`
        : `<strong>Can request, but cannot run yet:</strong> ${escapeHtml(grant.toolTitle)} from ${escapeHtml(grant.serverName)}<br><span>If the AI requests a change, BrowserCrew will show the exact argument preview and wait for your approval.</span>`;
    }
  } catch (error) { notifyMcp(error?.message || "BrowserCrew could not stage that tool for Chat."); event.currentTarget.value = ""; }
}

async function clearStagedMcpTool() {
  document.querySelector("#mcpChatToolSelect") && (document.querySelector("#mcpChatToolSelect").value = "");
  const selection = document.querySelector("#mcpChatSelection");
  if (selection) { selection.hidden = true; selection.replaceChildren(); }
  await sendMcp("CLEAR_MCP_CHAT_TOOL").catch(() => {});
}

async function onApprovalClick(event) {
  const button = event.target.closest("button[data-mcp-write-action]");
  if (!button) return;
  const actionId = button.dataset.actionId;
  button.disabled = true;
  try {
    if (button.dataset.mcpWriteAction === "approve") {
      button.textContent = "Running approved change…";
      const response = await sendMcp("APPROVE_MCP_WRITE", { actionId });
      renderWriteResult(response);
    } else await sendMcp("CANCEL_MCP_WRITE", { actionId });
  } catch (error) {
    notifyMcp(error?.message || "BrowserCrew could not finish that external change safely.");
    button.disabled = false;
  }
}

function renderMcpState() {
  renderServerList();
  renderChatToolChoices();
  if (mcpUiState.pendingWrite) renderWriteApproval(mcpUiState.pendingWrite);
}

function renderServerList() {
  const list = document.querySelector("#mcpServerList");
  if (!list) return;
  if (!mcpUiState.servers.length) {
    list.innerHTML = `<div class="empty">No tool servers saved yet. Add one above; BrowserCrew will discover its tools before you can enable anything.</div>`;
    return;
  }
  list.innerHTML = mcpUiState.servers.map((server) => `
    <article class="mcp-server-card">
      <div class="mcp-server-head">
        <div><strong>${escapeHtml(server.name)}</strong><p>${escapeHtml(server.endpoint)}</p></div>
        <span class="mcp-status mcp-status-${escapeAttribute(server.status)}"><span aria-hidden="true"></span>${escapeHtml(statusText(server.status))}</span>
      </div>
      <p class="helper">Protocol: MCP ${escapeHtml(server.protocolVersion || "2026-07-28")} · ${server.hasSecret ? "session token present" : "no bearer token saved for this session"}</p>
      <div class="button-row"><button class="button button-small tactile" type="button" data-mcp-action="test" data-server-id="${escapeAttribute(server.id)}">Refresh tools</button><button class="button button-small button-danger tactile" type="button" data-mcp-action="delete" data-server-id="${escapeAttribute(server.id)}">Delete</button></div>
      <div class="mcp-tool-list">${(server.tools || []).map((tool) => renderDiscoveredTool(server, tool)).join("") || `<div class="empty">No tools discovered.</div>`}</div>
    </article>`).join("");
}

function renderDiscoveredTool(server, tool) {
  return `<article class="mcp-tool-card">
    <div><strong>${escapeHtml(tool.title || tool.name)}</strong><p>${escapeHtml(tool.description || "No description supplied by this server.")}</p><code>${escapeHtml(tool.name)}</code></div>
    <label class="field-label">What can this tool do?
      <select data-mcp-policy data-server-id="${escapeAttribute(server.id)}" data-tool-name="${escapeAttribute(tool.name)}">
        <option value="review" ${tool.classification === "review" ? "selected" : ""}>Needs review — keep disabled</option>
        <option value="read" ${tool.classification === "read" ? "selected" : ""}>Read only — does not change data</option>
        <option value="write" ${tool.classification === "write" ? "selected" : ""}>Changes data — always review before run</option>
      </select>
    </label>
    <label class="mcp-enable-choice"><input type="checkbox" data-mcp-enabled data-server-id="${escapeAttribute(server.id)}" data-tool-name="${escapeAttribute(tool.name)}" ${tool.enabled ? "checked" : ""} ${tool.classification === "review" || !tool.schemaSupported ? "disabled" : ""}/><span><strong>Make available in Chat</strong><small>${tool.schemaSupported ? "This only makes the tool selectable. Normal per-message permission and write approval still apply." : "This tool uses an input schema this Chat adapter cannot safely expose yet."}</small></span></label>
  </article>`;
}

function renderChatToolChoices() {
  const select = document.querySelector("#mcpChatToolSelect");
  if (!select) return;
  const previous = select.value;
  const choices = [];
  for (const server of mcpUiState.servers) {
    if (server.status !== "connected") continue;
    for (const tool of server.tools || []) if (tool.enabled && ["read", "write"].includes(tool.classification)) choices.push({ server, tool });
  }
  select.innerHTML = `<option value="">Do not use an external tool</option>${choices.map(({ server, tool }) => `<option value="${escapeAttribute(`${server.id}::${tool.name}`)}">${escapeHtml(tool.title || tool.name)} — ${escapeHtml(server.name)} (${tool.classification === "read" ? "read only" : "approval required"})</option>`).join("")}`;
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function renderWriteApproval(pending) {
  const box = document.querySelector("#mcpWriteApproval");
  if (!box || !pending) return;
  const args = Object.entries(pending.argumentsPreview || {}).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`).join("");
  box.hidden = false;
  box.innerHTML = `
    <div class="mcp-approval-head"><div><p class="step-label">REVIEW EXTERNAL CHANGE</p><h3>${escapeHtml(pending.toolTitle || pending.toolName)}</h3></div><span class="badge badge-warning">Approval required</span></div>
    <p><strong>Where:</strong> ${escapeHtml(pending.serverName || "Tool server")}</p>
    <p class="helper">The AI prepared this write-tool request. BrowserCrew has <strong>not</strong> called the tool yet. Review the fields below.</p>
    <dl class="mcp-args-preview">${args || `<dt>Arguments</dt><dd>No arguments</dd>`}</dl>
    <div class="warning-box">⚠ Approving can change data outside BrowserCrew. If the connection is interrupted after the server receives the write, BrowserCrew will mark the outcome unknown and will not retry automatically.</div>
    <div class="button-row"><button class="button tactile" type="button" data-mcp-write-action="cancel" data-action-id="${escapeAttribute(pending.actionId)}">Cancel change</button><button class="button button-primary tactile" type="button" data-mcp-write-action="approve" data-action-id="${escapeAttribute(pending.actionId)}">Approve this change</button></div>`;
}

function renderWriteResult(message) {
  const approval = document.querySelector("#mcpWriteApproval");
  if (approval) approval.hidden = true;
  const box = document.querySelector("#mcpWriteResult");
  if (!box) return;
  box.hidden = false;
  if (message?.ok) box.innerHTML = `<strong>External change finished</strong><p>${escapeHtml(String(message.result || "The tool server reported completion.").slice(0, 1000))}</p><small>BrowserCrew consumed the one-time approval. Run another message for another external change.</small>`;
  else box.innerHTML = `<strong>Could not verify the external change</strong><p>${escapeHtml(message?.error?.message || "BrowserCrew did not retry the write.")}</p>`;
  mcpUiState.pendingWrite = null;
}

function appendMcpActivity(event) {
  const list = document.querySelector("#chatActivityList");
  if (!list || !event?.summary) return;
  const existing = list.querySelector(`[data-mcp-event-id="${CSS.escape(event.id)}"]`);
  if (existing) return;
  const item = document.createElement("li");
  item.dataset.mcpEventId = event.id;
  item.className = "chat-activity-item";
  item.innerHTML = `<strong>${escapeHtml(activityLabel(event.type))}</strong><p>${escapeHtml(event.summary)}</p>`;
  list.append(item);
}

function activityLabel(type) {
  if (type === "approval.requested") return "Approval needed";
  if (type === "tool.authorized") return "Tool allowed";
  if (type === "tool.started") return "Tool running";
  if (type === "tool.completed") return "Tool finished";
  if (type === "verification") return "Tool checked";
  if (type === "warning") return "Warning";
  return "External tool";
}

function sendMcp(type, payload = {}) {
  if (!mcpUiState.port) return Promise.reject(new Error("The tool-server connection is restarting. Try again."));
  const requestId = `mcp-ui-${Date.now()}-${++mcpUiState.requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mcpUiState.pending.delete(requestId); reject(new Error("BrowserCrew did not receive a tool-server reply in time.")); }, 35000);
    mcpUiState.pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    mcpUiState.port.postMessage({ type, requestId, ...payload });
  });
}

async function requestEndpointPermission(endpoint) {
  let url; try { url = new URL(endpoint); } catch { throw new Error("Enter the full tool-server address first."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("Remote tool servers must use HTTPS. Plain HTTP is allowed only for a tool server on this computer.");
  const pattern = `${url.origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

function statusText(status) {
  if (status === "connected") return "Connected";
  if (status === "failed") return "Connection failed";
  if (status === "permission_needed") return "Permission needed";
  return "Not tested";
}
function setBusy(button, busy, label) { if (!button) return; button.disabled = busy; button.textContent = label; }
function notifyMcp(message) { const toast = document.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.hidden = false; clearTimeout(notifyMcp.timer); notifyMcp.timer = setTimeout(() => { toast.hidden = true; }, 4500); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value); }
