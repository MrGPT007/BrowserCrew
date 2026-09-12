const MCP_PROTOCOL = "2026-07-28";
const MCP_PORT = "browsercrew-mcp";
const CHAT_STORAGE_KEY = "browsercrew.conversations.v1";
const SERVERS_KEY = "browsercrew.mcpServers.v1";
const SECRETS_KEY = "browsercrew.mcpSecrets.v1";
const CHAT_GRANT_KEY = "browsercrew.chatPendingMcpGrant.v1";
const PENDING_WRITE_KEY = "browsercrew.mcpPendingWrite.v1";
const ACTIONS_KEY = "browsercrew.mcpActions.v1";
const MAX_SERVERS = 8;
const MAX_TOOLS = 40;
const MAX_RESULT_CHARS = 20000;
const MAX_ARGUMENT_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 30000;
const mcpPorts = new Set();
const nativeFetch = globalThis.fetch.bind(globalThis);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MCP_PORT) return;
  mcpPorts.add(port);
  port.onDisconnect.addListener(() => mcpPorts.delete(port));
  port.onMessage.addListener((message) => {
    handleMcpMessage(message).then((response) => {
      if (response) safePost(port, { ...response, requestId: message?.requestId || null });
    }).catch((error) => safePost(port, { type: "MCP_ERROR", ok: false, requestId: message?.requestId || null, error: serializeMcpError(error) }));
  });
});

reconcileInterruptedMcpWrites().catch(() => {});

globalThis.fetch = async (input, init = undefined) => {
  const prepared = await prepareMcpChatRequest(input, init);
  if (!prepared) return nativeFetch(input, init);
  return executeMcpChatRequest(prepared);
};

async function handleMcpMessage(message) {
  switch (message?.type) {
    case "GET_MCP_STATE": return { type: "MCP_STATE", ok: true, ...(await getMcpState()) };
    case "SAVE_MCP_SERVER": return saveMcpServer(message.server || {}, message.secret);
    case "TEST_MCP_SERVER": return testMcpServer(message.serverId);
    case "DELETE_MCP_SERVER": return deleteMcpServer(message.serverId);
    case "SET_MCP_TOOL_POLICY": return setMcpToolPolicy(message.serverId, message.toolName, message.classification);
    case "SET_MCP_TOOL_ENABLED": return setMcpToolEnabled(message.serverId, message.toolName, message.enabled);
    case "STAGE_MCP_CHAT_TOOL": return stageMcpChatTool(message.serverId, message.toolName, message.scope);
    case "CLEAR_MCP_CHAT_TOOL": await chrome.storage.session.remove(CHAT_GRANT_KEY); return { type: "MCP_CHAT_TOOL_CLEARED", ok: true };
    case "GET_PENDING_MCP_WRITE": return { type: "MCP_PENDING_WRITE", ok: true, pending: await getPendingWriteSummary() };
    case "APPROVE_MCP_WRITE": return approveMcpWrite(message.actionId);
    case "CANCEL_MCP_WRITE": return cancelMcpWrite(message.actionId);
    default: return { type: "MCP_ERROR", ok: false, error: { code: "UNKNOWN_MCP_MESSAGE", message: "BrowserCrew received an unknown tool-server request." } };
  }
}

async function saveMcpServer(input, suppliedSecret) {
  const servers = await getServers();
  const normalized = validateServerInput(input);
  const existing = input.id ? servers.find((server) => server.id === input.id) : null;
  if (!existing && servers.length >= MAX_SERVERS) throw coded("MCP_SERVER_LIMIT", `BrowserCrew can keep up to ${MAX_SERVERS} tool-server connections in this build.`);
  const now = new Date().toISOString();
  const profile = {
    id: existing?.id || crypto.randomUUID(),
    schemaVersion: 1,
    name: normalized.name,
    endpoint: normalized.endpoint,
    protocolVersion: MCP_PROTOCOL,
    status: existing && existing.endpoint === normalized.endpoint ? existing.status : "not_tested",
    serverInfo: existing?.serverInfo || null,
    capabilities: existing?.capabilities || null,
    tools: existing?.tools || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastTestedAt: existing?.lastTestedAt || null
  };
  const next = servers.filter((server) => server.id !== profile.id);
  next.unshift(profile);
  await chrome.storage.local.set({ [SERVERS_KEY]: next });
  if (typeof suppliedSecret === "string") await saveServerSecret(profile.id, suppliedSecret);
  const state = await getMcpState();
  broadcastMcp({ type: "MCP_STATE", ok: true, ...state });
  return { type: "MCP_SERVER_SAVED", ok: true, server: withSecretFlag(profile, await getSecrets()), ...state };
}

async function testMcpServer(serverId) {
  const servers = await getServers();
  const server = servers.find((item) => item.id === serverId);
  if (!server) throw coded("MCP_SERVER_NOT_FOUND", "That tool-server connection could not be found.");
  await ensureEndpointPermission(server.endpoint);
  const secrets = await getSecrets();
  try {
    const discovery = await mcpRequest(server, secrets[server.id] || "", "server/discover", {});
    const supported = Array.isArray(discovery?.supportedVersions) ? discovery.supportedVersions : [];
    if (!supported.includes(MCP_PROTOCOL)) throw coded("MCP_PROTOCOL_UNSUPPORTED", `This server does not advertise MCP ${MCP_PROTOCOL}. BrowserCrew does not silently downgrade tool-server security contracts.`);
    const tools = await listAllTools(server, secrets[server.id] || "");
    const previous = new Map((server.tools || []).map((tool) => [tool.name, tool]));
    server.tools = tools.map((tool) => {
      const old = previous.get(tool.name);
      return { ...tool, classification: old?.classification || "review", enabled: Boolean(old?.enabled && old?.classification && old.classification !== "review") };
    });
    server.status = "connected";
    server.serverInfo = sanitizeServerInfo(discovery?.serverInfo);
    server.capabilities = sanitizeCapabilities(discovery?.capabilities);
    server.lastTestedAt = new Date().toISOString();
    server.updatedAt = server.lastTestedAt;
    await chrome.storage.local.set({ [SERVERS_KEY]: servers });
    const state = await getMcpState();
    broadcastMcp({ type: "MCP_STATE", ok: true, ...state });
    return { type: "MCP_SERVER_TESTED", ok: true, serverId, toolCount: server.tools.length, ...state };
  } catch (error) {
    server.status = error?.code === "MCP_PERMISSION_DENIED" ? "permission_needed" : "failed";
    server.lastTestedAt = new Date().toISOString();
    server.updatedAt = server.lastTestedAt;
    await chrome.storage.local.set({ [SERVERS_KEY]: servers });
    throw error;
  }
}

async function deleteMcpServer(serverId) {
  const servers = await getServers();
  if (!servers.some((server) => server.id === serverId)) throw coded("MCP_SERVER_NOT_FOUND", "That tool-server connection could not be found.");
  await chrome.storage.local.set({ [SERVERS_KEY]: servers.filter((server) => server.id !== serverId) });
  const secrets = await getSecrets();
  delete secrets[serverId];
  await chrome.storage.session.set({ [SECRETS_KEY]: secrets });
  const grant = (await chrome.storage.session.get(CHAT_GRANT_KEY))[CHAT_GRANT_KEY];
  if (grant?.serverId === serverId) await chrome.storage.session.remove(CHAT_GRANT_KEY);
  const state = await getMcpState();
  broadcastMcp({ type: "MCP_STATE", ok: true, ...state });
  return { type: "MCP_SERVER_DELETED", ok: true, ...state };
}

async function setMcpToolPolicy(serverId, toolName, classification) {
  if (!["review", "read", "write"].includes(classification)) throw coded("MCP_BAD_CLASSIFICATION", "Choose Needs review, Read only, or Changes data for this tool.");
  const servers = await getServers();
  const server = servers.find((item) => item.id === serverId);
  const tool = server?.tools?.find((item) => item.name === toolName);
  if (!tool) throw coded("MCP_TOOL_NOT_FOUND", "That discovered tool could not be found.");
  tool.classification = classification;
  if (classification === "review") tool.enabled = false;
  server.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [SERVERS_KEY]: servers });
  const state = await getMcpState();
  broadcastMcp({ type: "MCP_STATE", ok: true, ...state });
  return { type: "MCP_TOOL_POLICY_UPDATED", ok: true, ...state };
}

async function setMcpToolEnabled(serverId, toolName, enabled) {
  const servers = await getServers();
  const server = servers.find((item) => item.id === serverId);
  const tool = server?.tools?.find((item) => item.name === toolName);
  if (!tool) throw coded("MCP_TOOL_NOT_FOUND", "That discovered tool could not be found.");
  if (tool.classification === "review") throw coded("MCP_TOOL_NEEDS_REVIEW", "Classify this tool as read only or changes data before making it available in Chat.");
  tool.enabled = Boolean(enabled);
  server.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [SERVERS_KEY]: servers });
  const state = await getMcpState();
  broadcastMcp({ type: "MCP_STATE", ok: true, ...state });
  return { type: "MCP_TOOL_ENABLED_UPDATED", ok: true, ...state };
}

async function stageMcpChatTool(serverId, toolName, scope = "new") {
  const servers = await getServers();
  const server = servers.find((item) => item.id === serverId);
  const tool = server?.tools?.find((item) => item.name === toolName);
  if (!server || server.status !== "connected") throw coded("MCP_SERVER_NOT_READY", "Connect and test this tool server before using one of its tools in Chat.");
  if (!tool || !tool.enabled) throw coded("MCP_TOOL_DISABLED", "This tool is not enabled for Chat.");
  if (!["read", "write"].includes(tool.classification)) throw coded("MCP_TOOL_NEEDS_REVIEW", "Classify this tool before using it in Chat.");
  const grant = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    scope: String(scope || "new"),
    serverId,
    toolName,
    classification: tool.classification,
    alias: toolAlias(serverId, toolName),
    maxCalls: 1,
    stagedAt: new Date().toISOString()
  };
  await chrome.storage.session.set({ [CHAT_GRANT_KEY]: grant });
  return { type: "MCP_CHAT_TOOL_STAGED", ok: true, grant: { ...grant, serverName: server.name, toolTitle: tool.title || tool.name } };
}

async function prepareMcpChatRequest(input, init) {
  if (!init || String(init.method || "GET").toUpperCase() !== "POST" || typeof init.body !== "string") return null;
  const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (!String(urlText || "").includes("/chat/completions")) return null;
  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  if (body?.stream !== true || !Array.isArray(body.messages)) return null;
  const session = await chrome.storage.session.get(CHAT_GRANT_KEY);
  const grant = session[CHAT_GRANT_KEY];
  if (!grant?.serverId || !grant?.toolName) return null;
  const conversation = await matchingRunningConversation(grant.scope);
  if (!conversation) return null;
  await chrome.storage.session.remove(CHAT_GRANT_KEY);
  return { input, init, body, grant, conversation };
}

async function executeMcpChatRequest({ input, init, body, grant, conversation }) {
  const servers = await getServers();
  const server = servers.find((item) => item.id === grant.serverId);
  const tool = server?.tools?.find((item) => item.name === grant.toolName);
  if (!server || !tool || !tool.enabled || tool.classification !== grant.classification) return syntheticChatResponse("BrowserCrew refused this external tool because its saved permission changed. Choose the tool again.", body.model);
  const alias = toolAlias(server.id, tool.name);
  const firstBody = {
    ...body,
    tools: [{ type: "function", function: { name: alias, description: mcpToolDescription(server, tool), parameters: tool.openAiSchema } }],
    tool_choice: "auto"
  };
  const firstResponse = await nativeFetch(input, { ...init, body: JSON.stringify(firstBody) });
  if (!firstResponse.ok) return firstResponse;
  const first = await readProviderCompletion(firstResponse);
  if (!first.toolCalls.length) return completionResponse(first);
  if (first.toolCalls.length !== 1) return syntheticChatResponse("BrowserCrew allows one external tool call per message in this build. Send another message for another tool.", first.model || body.model);
  const requested = first.toolCalls[0];
  await addChatActivity(conversation.id, "tool.requested", `The AI asked to use ${tool.title || tool.name} from ${server.name}.`, { source: "mcp", serverId: server.id, serverName: server.name, tool: tool.name, classification: tool.classification });
  if (init.signal?.aborted) return syntheticChatResponse("The response was stopped before BrowserCrew started the external tool.", first.model || body.model);
  if (requested.name !== alias) return syntheticChatResponse("BrowserCrew refused an external tool request that did not match the tool you enabled.", first.model || body.model);
  const args = parseAndBoundArguments(requested.arguments);

  if (tool.classification === "write") {
    const action = await stageWriteApproval(conversation.id, server, tool, args, requested, body.model);
    await addChatActivity(conversation.id, "approval.requested", `Review the requested change before BrowserCrew lets ${server.name} run ${tool.title || tool.name}.`, { source: "mcp", actionId: action.id, serverName: server.name, tool: tool.name, classification: "write", argumentKeys: Object.keys(args).slice(0, 20).join(", ") });
    broadcastMcp({ type: "MCP_WRITE_APPROVAL_REQUIRED", ok: true, pending: approvalSummary(action, server, tool, args) });
    return syntheticChatResponse(`BrowserCrew paused the external write tool ${tool.title || tool.name}. Review and approve the requested change in Chat before it can run.`, first.model || body.model);
  }

  await addChatActivity(conversation.id, "tool.authorized", `Allowed for this message only: ${tool.title || tool.name} on ${server.name}.`, { source: "mcp", serverName: server.name, tool: tool.name, classification: "read", access: "read_only" });
  await addChatActivity(conversation.id, "tool.started", `Running ${tool.title || tool.name} on ${server.name}.`, { source: "mcp", serverName: server.name, tool: tool.name });
  const secrets = await getSecrets();
  const result = await callMcpTool(server, secrets[server.id] || "", tool, args);
  await addChatActivity(conversation.id, "tool.completed", `${tool.title || tool.name} finished on ${server.name}.`, { source: "mcp", serverName: server.name, tool: tool.name, characters: result.text.length, isError: result.isError });
  await addChatActivity(conversation.id, "verification", "Checked that the external call stayed on the exact enabled server and tool.", { source: "mcp", serverId: server.id, tool: tool.name, oneCallBudget: true });
  if (init.signal?.aborted) return syntheticChatResponse("The response was stopped after the external read, before another model request started.", first.model || body.model);
  const secondBody = {
    ...body,
    messages: [...body.messages, {
      role: "assistant",
      content: first.text || null,
      tool_calls: [{ id: requested.id, type: "function", function: { name: alias, arguments: requested.arguments || "{}" } }]
    }, {
      role: "tool",
      tool_call_id: requested.id,
      content: result.text
    }],
    stream: true
  };
  delete secondBody.tools;
  delete secondBody.tool_choice;
  const secondResponse = await nativeFetch(input, { ...init, body: JSON.stringify(secondBody) });
  if (!secondResponse.ok) return secondResponse;
  const second = await readProviderCompletion(secondResponse);
  if (second.toolCalls.length) return syntheticChatResponse("BrowserCrew used the one external tool call allowed for this message. Send another message if another tool is needed.", second.model || first.model || body.model);
  return completionResponse(second);
}

async function stageWriteApproval(conversationId, server, tool, args, requested, model) {
  const digest = await sha256Hex(JSON.stringify(args));
  const now = new Date().toISOString();
  const action = {
    id: crypto.randomUUID(), schemaVersion: 1, kind: "mcp_write", conversationId, serverId: server.id, toolName: tool.name,
    serverName: server.name, toolTitle: tool.title || tool.name, status: "awaiting_approval", checkpoint: "mcp_write_preview",
    argumentDigest: digest, argumentKeys: Object.keys(args).slice(0, 20), createdAt: now, updatedAt: now, model: String(model || "")
  };
  const actions = await getActions();
  actions.unshift(action);
  await chrome.storage.local.set({ [ACTIONS_KEY]: actions.slice(0, 100) });
  await chrome.storage.session.set({ [PENDING_WRITE_KEY]: { actionId: action.id, arguments: args, toolCallId: requested.id, stagedAt: now } });
  return action;
}

async function approveMcpWrite(actionId) {
  const actions = await getActions();
  const action = actions.find((item) => item.id === actionId);
  if (!action || action.status !== "awaiting_approval" || action.checkpoint !== "mcp_write_preview") throw coded("MCP_WRITE_NOT_APPROVABLE", "That external change is no longer waiting for approval.");
  const pending = (await chrome.storage.session.get(PENDING_WRITE_KEY))[PENDING_WRITE_KEY];
  if (!pending || pending.actionId !== actionId) throw coded("MCP_WRITE_DETAILS_GONE", "The private tool arguments are no longer available in this Chrome session. Ask the AI to prepare the change again.");
  const digest = await sha256Hex(JSON.stringify(pending.arguments || {}));
  if (digest !== action.argumentDigest) throw coded("MCP_WRITE_CHANGED", "The external tool arguments changed after preview, so BrowserCrew refused the write.");
  const servers = await getServers();
  const server = servers.find((item) => item.id === action.serverId);
  const tool = server?.tools?.find((item) => item.name === action.toolName);
  if (!server || !tool || !tool.enabled || tool.classification !== "write") throw coded("MCP_WRITE_PERMISSION_CHANGED", "The server or tool permission changed after preview. BrowserCrew did not run the write.");
  await ensureEndpointPermission(server.endpoint);
  action.status = "committing";
  action.checkpoint = "mcp_write_intent";
  action.approvedAt = new Date().toISOString();
  action.updatedAt = action.approvedAt;
  await saveActions(actions);
  await addChatActivity(action.conversationId, "tool.authorized", `You approved ${tool.title || tool.name} on ${server.name}.`, { source: "mcp", actionId, serverName: server.name, tool: tool.name, classification: "write" });
  await addChatActivity(action.conversationId, "tool.started", `Running the approved change with ${tool.title || tool.name}.`, { source: "mcp", actionId, serverName: server.name, tool: tool.name });
  try {
    const secrets = await getSecrets();
    const result = await callMcpTool(server, secrets[server.id] || "", tool, pending.arguments || {});
    action.status = result.isError ? "failed" : "completed";
    action.checkpoint = result.isError ? "mcp_write_error" : "mcp_write_completed";
    action.completedAt = new Date().toISOString();
    action.updatedAt = action.completedAt;
    action.resultSummary = safeResultSummary(result.text);
    await saveActions(actions);
    await chrome.storage.session.remove(PENDING_WRITE_KEY);
    await addChatActivity(action.conversationId, "tool.completed", result.isError ? `The approved external tool reported an error.` : `The approved external change finished.`, { source: "mcp", actionId, serverName: server.name, tool: tool.name, isError: result.isError, characters: result.text.length });
    await addChatActivity(action.conversationId, "verification", result.isError ? "The server reported the tool error; BrowserCrew did not retry the write." : "Recorded the completed external write and consumed its one-time approval.", { source: "mcp", actionId, tool: tool.name, noReplay: true });
    const payload = { type: "MCP_WRITE_DONE", ok: !result.isError, action: publicAction(action), result: result.text };
    broadcastMcp(payload);
    return payload;
  } catch (error) {
    action.status = "outcome_unknown";
    action.checkpoint = "mcp_write_outcome_unknown";
    action.updatedAt = new Date().toISOString();
    action.error = { code: "MCP_WRITE_OUTCOME_UNKNOWN", message: "The tool-server write started, but BrowserCrew could not prove the outcome. It will not retry automatically." };
    await saveActions(actions);
    await chrome.storage.session.remove(PENDING_WRITE_KEY);
    await addChatActivity(action.conversationId, "warning", action.error.message, { source: "mcp", actionId, tool: tool.name, noReplay: true });
    throw coded(action.error.code, action.error.message);
  }
}

async function cancelMcpWrite(actionId) {
  const actions = await getActions();
  const action = actions.find((item) => item.id === actionId);
  if (!action || action.status !== "awaiting_approval") throw coded("MCP_WRITE_NOT_CANCELLABLE", "That external change is no longer waiting for approval.");
  action.status = "cancelled";
  action.checkpoint = "mcp_write_cancelled";
  action.updatedAt = new Date().toISOString();
  await saveActions(actions);
  const pending = (await chrome.storage.session.get(PENDING_WRITE_KEY))[PENDING_WRITE_KEY];
  if (pending?.actionId === actionId) await chrome.storage.session.remove(PENDING_WRITE_KEY);
  await addChatActivity(action.conversationId, "warning", "External change cancelled. BrowserCrew did not call the write tool.", { source: "mcp", actionId, tool: action.toolName });
  const payload = { type: "MCP_WRITE_CANCELLED", ok: true, action: publicAction(action) };
  broadcastMcp(payload);
  return payload;
}

async function reconcileInterruptedMcpWrites() {
  const actions = await getActions();
  let changed = false;
  for (const action of actions) {
    if (action?.kind === "mcp_write" && action.status === "committing") {
      action.status = "outcome_unknown";
      action.checkpoint = "mcp_write_outcome_unknown";
      action.updatedAt = new Date().toISOString();
      action.error = { code: "MCP_WRITE_OUTCOME_UNKNOWN", message: "Chrome restarted BrowserCrew after an external write started. BrowserCrew will not replay it automatically." };
      changed = true;
      await addChatActivity(action.conversationId, "warning", action.error.message, { source: "mcp", actionId: action.id, tool: action.toolName, recovery: true, noReplay: true }).catch(() => {});
    }
  }
  if (changed) await saveActions(actions);
  if (changed) await chrome.storage.session.remove(PENDING_WRITE_KEY);
}

async function listAllTools(server, secret) {
  const found = [];
  let cursor = undefined;
  for (let page = 0; page < 5 && found.length < MAX_TOOLS; page += 1) {
    const result = await mcpRequest(server, secret, "tools/list", cursor ? { cursor } : {});
    for (const raw of Array.isArray(result?.tools) ? result.tools : []) {
      if (found.length >= MAX_TOOLS) break;
      const tool = sanitizeTool(raw);
      if (tool) found.push(tool);
    }
    cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return found;
}

async function callMcpTool(server, secret, tool, args) {
  const result = await mcpRequest(server, secret, "tools/call", { name: tool.name, arguments: args }, tool.name);
  const textParts = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === "text" && typeof block.text === "string") textParts.push(block.text);
  }
  if (result?.structuredContent !== undefined) textParts.push(`Structured result:\n${safeJson(result.structuredContent)}`);
  const text = textParts.join("\n\n").trim().slice(0, MAX_RESULT_CHARS) || (result?.isError ? "The external tool reported an error without readable text." : "The external tool finished without readable text output.");
  return { text, isError: Boolean(result?.isError) };
}

async function mcpRequest(server, secret, method, params = {}, name = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL,
    "Mcp-Method": method
  };
  if (name) headers["Mcp-Name"] = name;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "BrowserCrew", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  };
  let response;
  try {
    response = await nativeFetch(server.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw coded("MCP_TIMEOUT", "The tool server did not answer within 30 seconds.");
    throw coded("MCP_UNREACHABLE", "BrowserCrew could not reach this tool server. Check the address and make sure the server is running.");
  } finally { clearTimeout(timeout); }
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!response.ok) throw coded("MCP_HTTP_ERROR", `The tool server returned HTTP ${response.status}. BrowserCrew did not save the server's raw error body.`);
  if (!payload || payload.jsonrpc !== "2.0") throw coded("MCP_BAD_RESPONSE", "The tool server returned a response BrowserCrew could not read as MCP JSON-RPC.");
  if (payload.error) throw coded("MCP_RPC_ERROR", `The tool server rejected ${method}. BrowserCrew did not copy the server's raw error details into history.`);
  return payload.result || {};
}

async function getMcpState() {
  const servers = await getServers();
  const secrets = await getSecrets();
  return { servers: servers.map((server) => withSecretFlag(server, secrets)), pendingWrite: await getPendingWriteSummary(), actions: (await getActions()).slice(0, 20).map(publicAction) };
}

async function getPendingWriteSummary() {
  const pending = (await chrome.storage.session.get(PENDING_WRITE_KEY))[PENDING_WRITE_KEY];
  if (!pending?.actionId) return null;
  const action = (await getActions()).find((item) => item.id === pending.actionId);
  if (!action || action.status !== "awaiting_approval") return null;
  const servers = await getServers();
  const server = servers.find((item) => item.id === action.serverId);
  const tool = server?.tools?.find((item) => item.name === action.toolName);
  return approvalSummary(action, server, tool, pending.arguments || {});
}

function approvalSummary(action, server, tool, args) {
  return { actionId: action.id, serverId: action.serverId, serverName: server?.name || action.serverName, toolName: action.toolName, toolTitle: tool?.title || action.toolTitle || action.toolName, classification: "write", argumentKeys: Object.keys(args).slice(0, 20), argumentsPreview: redactArguments(args), createdAt: action.createdAt };
}

function redactArguments(args) {
  const preview = {};
  for (const [key, value] of Object.entries(args || {}).slice(0, 20)) {
    if (/secret|password|key|token|authorization|cookie/i.test(key)) preview[key] = "[hidden]";
    else if (typeof value === "string") preview[key] = value.length > 120 ? `${value.slice(0, 117)}…` : value;
    else if (["number", "boolean"].includes(typeof value) || value === null) preview[key] = value;
    else preview[key] = "[structured value]";
  }
  return preview;
}

function validateServerInput(input) {
  const name = String(input.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw coded("MCP_NAME_REQUIRED", "Give this tool server a name you will recognize, such as Inventory tools.");
  let url;
  try { url = new URL(String(input.endpoint || "").trim()); } catch { throw coded("MCP_ENDPOINT_REQUIRED", "Enter the full tool-server address, such as https://tools.example.com/mcp."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw coded("MCP_UNSAFE_ENDPOINT", "Remote tool servers must use HTTPS. Plain HTTP is allowed only for a tool server running on this computer.");
  url.hash = "";
  return { name, endpoint: url.href.replace(/\/$/, "") };
}

function sanitizeTool(raw) {
  const name = String(raw?.name || "").trim().slice(0, 120);
  if (!name) return null;
  const inputSchema = safeSchema(raw?.inputSchema);
  const objectSchema = inputSchema?.type === "object" || !inputSchema?.type;
  return {
    name,
    title: String(raw?.title || name).replace(/\s+/g, " ").trim().slice(0, 160),
    description: String(raw?.description || "No description supplied by this server.").replace(/\s+/g, " ").trim().slice(0, 1000),
    inputSchema,
    openAiSchema: objectSchema ? { ...inputSchema, type: "object", additionalProperties: inputSchema.additionalProperties ?? false } : { type: "object", properties: {}, additionalProperties: false },
    schemaSupported: objectSchema,
    classification: "review",
    enabled: false
  };
}

function safeSchema(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object", properties: {}, additionalProperties: false };
  let text;
  try { text = JSON.stringify(value); } catch { return { type: "object", properties: {}, additionalProperties: false }; }
  if (text.length > 12000) return { type: "object", properties: {}, additionalProperties: false };
  try { return JSON.parse(text); } catch { return { type: "object", properties: {}, additionalProperties: false }; }
}

function parseAndBoundArguments(raw) {
  const text = String(raw || "{}").trim() || "{}";
  if (text.length > MAX_ARGUMENT_CHARS) throw coded("MCP_ARGUMENTS_TOO_LARGE", "The AI prepared too much data for one external tool call. Shorten the request and try again.");
  let args;
  try { args = JSON.parse(text); } catch { throw coded("MCP_BAD_ARGUMENTS", "The AI prepared external tool arguments BrowserCrew could not read safely."); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw coded("MCP_BAD_ARGUMENTS", "External tool arguments must be a named set of fields.");
  return args;
}

async function ensureEndpointPermission(endpoint) {
  const pattern = `${new URL(endpoint).origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw coded("MCP_PERMISSION_DENIED", "Chrome access to this tool-server address is not approved. Save and test it again so Chrome can ask you first.");
}

async function getServers() {
  const stored = await chrome.storage.local.get(SERVERS_KEY);
  return Array.isArray(stored[SERVERS_KEY]) ? stored[SERVERS_KEY] : [];
}
async function getSecrets() {
  const stored = await chrome.storage.session.get(SECRETS_KEY);
  return stored[SECRETS_KEY] && typeof stored[SECRETS_KEY] === "object" ? stored[SECRETS_KEY] : {};
}
async function saveServerSecret(serverId, secret) {
  const secrets = await getSecrets();
  if (secret) secrets[serverId] = secret; else delete secrets[serverId];
  await chrome.storage.session.set({ [SECRETS_KEY]: secrets });
}
async function getActions() {
  const stored = await chrome.storage.local.get(ACTIONS_KEY);
  return Array.isArray(stored[ACTIONS_KEY]) ? stored[ACTIONS_KEY] : [];
}
async function saveActions(actions) { await chrome.storage.local.set({ [ACTIONS_KEY]: actions.slice(0, 100) }); }

async function matchingRunningConversation(scope) {
  const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
  const conversations = Array.isArray(stored[CHAT_STORAGE_KEY]) ? stored[CHAT_STORAGE_KEY] : [];
  const running = conversations.filter((item) => item?.status === "running");
  if (scope && scope !== "new") return running.find((item) => item.id === scope) || null;
  return running.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

async function addChatActivity(conversationId, type, summary, meta = null) {
  const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
  const conversations = Array.isArray(stored[CHAT_STORAGE_KEY]) ? stored[CHAT_STORAGE_KEY] : [];
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  const event = { id: crypto.randomUUID(), type, at: new Date().toISOString(), summary: String(summary || "").slice(0, 1000), meta: sanitizeMeta(meta) };
  conversation.activity = Array.isArray(conversation.activity) ? conversation.activity : [];
  conversation.activity.push(event);
  conversation.activity = conversation.activity.slice(-300);
  conversation.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [CHAT_STORAGE_KEY]: conversations });
  broadcastChatActivity(conversationId, event);
}

function broadcastChatActivity(conversationId, event) {
  chrome.runtime.connect;
  for (const port of mcpPorts) safePost(port, { type: "MCP_CHAT_ACTIVITY", ok: true, conversationId, event });
  try { chrome.runtime.sendMessage({ type: "MCP_CHAT_ACTIVITY_BRIDGE", conversationId, event }).catch(() => {}); } catch {}
}

async function readProviderCompletion(response) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/event-stream")) {
    const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = null; }
    const message = body?.choices?.[0]?.message || {};
    return { text: typeof message.content === "string" ? message.content : "", model: body?.model || null, usage: body?.usage || null, toolCalls: normalizeToolCalls(message.tool_calls) };
  }
  const raw = await response.text();
  let text = ""; let model = null; let usage = null; const calls = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim(); if (!data || data === "[DONE]") continue;
    let event; try { event = JSON.parse(data); } catch { continue; }
    if (event.model) model = event.model; if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta || {}; if (typeof delta.content === "string") text += delta.content;
    for (const fragment of delta.tool_calls || []) {
      const index = Number.isInteger(fragment.index) ? fragment.index : 0;
      const current = calls.get(index) || { id: "", name: "", arguments: "" };
      if (fragment.id) current.id = fragment.id;
      if (fragment.function?.name) current.name += fragment.function.name;
      if (fragment.function?.arguments) current.arguments += fragment.function.arguments;
      calls.set(index, current);
    }
  }
  return { text, model, usage, toolCalls: [...calls.values()].map((item, index) => ({ id: item.id || `mcp-call-${index + 1}`, name: item.name, arguments: item.arguments || "{}" })) };
}

function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => ({ id: String(item?.id || `mcp-call-${index + 1}`), name: String(item?.function?.name || ""), arguments: String(item?.function?.arguments || "{}") }));
}
function completionResponse(completion) {
  const payload = { model: completion.model || undefined, choices: [{ index: 0, delta: { content: completion.text || "" }, finish_reason: null }], usage: completion.usage || undefined };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
}
function syntheticChatResponse(message, model) { return completionResponse({ text: message, model, usage: null }); }
function toolAlias(serverId, toolName) { return `browsercrew_mcp_${serverId.replace(/-/g, "").slice(0, 8)}_${fnv1a(toolName)}`.slice(0, 64); }
function fnv1a(value) { let hash = 2166136261; for (const ch of String(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
function mcpToolDescription(server, tool) { return `${tool.description} Source: ${server.name}. BrowserCrew enforces this tool as ${tool.classification === "read" ? "read only" : "write with separate user approval"}.`; }
function sanitizeServerInfo(value) { return value && typeof value === "object" ? { name: String(value.name || "").slice(0, 120), version: String(value.version || "").slice(0, 80) } : null; }
function sanitizeCapabilities(value) { return value && typeof value === "object" ? { tools: Boolean(value.tools) } : { tools: true }; }
function withSecretFlag(server, secrets) { return { ...server, hasSecret: Boolean(secrets[server.id]) }; }
function publicAction(action) { const { argumentDigest, ...safe } = action; return { ...safe, hasArgumentDigest: Boolean(argumentDigest) }; }
function safeResultSummary(text) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500); }
function safeJson(value) { try { return JSON.stringify(value, null, 2).slice(0, MAX_RESULT_CHARS); } catch { return "[unreadable structured result]"; } }
function sanitizeMeta(meta) { if (!meta || typeof meta !== "object") return null; const safe = {}; for (const [key, value] of Object.entries(meta)) { if (/secret|token|authorization|cookie|prompt|content|text/i.test(key)) continue; if (value === null || ["string", "number", "boolean"].includes(typeof value)) safe[key] = typeof value === "string" ? value.slice(0, 500) : value; } return safe; }
async function sha256Hex(text) { const bytes = new TextEncoder().encode(String(text)); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function broadcastMcp(message) { for (const port of mcpPorts) safePost(port, message); }
function safePost(port, message) { try { port.postMessage(message); } catch {} }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function serializeMcpError(error) { const code = String(error?.code || "MCP_FAILED"); const allowed = new Set(["MCP_SERVER_LIMIT","MCP_SERVER_NOT_FOUND","MCP_BAD_CLASSIFICATION","MCP_TOOL_NOT_FOUND","MCP_TOOL_NEEDS_REVIEW","MCP_SERVER_NOT_READY","MCP_TOOL_DISABLED","MCP_WRITE_NOT_APPROVABLE","MCP_WRITE_DETAILS_GONE","MCP_WRITE_CHANGED","MCP_WRITE_PERMISSION_CHANGED","MCP_WRITE_OUTCOME_UNKNOWN","MCP_WRITE_NOT_CANCELLABLE","MCP_TIMEOUT","MCP_UNREACHABLE","MCP_HTTP_ERROR","MCP_BAD_RESPONSE","MCP_RPC_ERROR","MCP_NAME_REQUIRED","MCP_ENDPOINT_REQUIRED","MCP_UNSAFE_ENDPOINT","MCP_ARGUMENTS_TOO_LARGE","MCP_BAD_ARGUMENTS","MCP_PERMISSION_DENIED","MCP_PROTOCOL_UNSUPPORTED"]); return { code: allowed.has(code) ? code : "MCP_FAILED", message: allowed.has(code) ? String(error.message || "The tool-server request failed.") : "The tool-server request failed safely. Check the server and try again." }; }
