import {
  assertAgentConnectionAllowed,
  assertAgentNotCancelled,
  canonicalAgentJson,
  consumeAgentBudget,
  createAgentPolicy,
  policyError,
  publicAgentPolicy
} from "./agent-policy.js";

const C5_PORT = "browsercrew-chat-c5";
const CONNECTIONS_KEY = "browsercrew.connections.v1";
const ACTIVE_CONNECTION_KEY = "browsercrew.activeConnection.v1";
const CONNECTION_SECRETS_KEY = "browsercrew.connectionSecrets.v1";
const CHAT_STORAGE_KEY = "browsercrew.conversations.v1";
const C5_RUNS_KEY = "browsercrew.c5Runs.v1";
const C5_PENDING_KEY = "browsercrew.c5Pending.v1";
const MAX_RUNS = 60;
const MAX_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_CHARS = 12000;
const MAX_INSTRUCTION_CHARS = 4000;
const MAX_RESULT_CHARS = 24000;
const activeC5Runs = new Map();
const c5Ports = new Set();
const nativeFetch = globalThis.fetch.bind(globalThis);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== C5_PORT) return;
  c5Ports.add(port);
  port.onDisconnect.addListener(() => c5Ports.delete(port));
  port.onMessage.addListener((message) => {
    handleC5Message(message).then((response) => {
      if (response) safePost(port, { ...response, requestId: message?.requestId || null });
    }).catch((error) => safePost(port, {
      type: "C5_ERROR",
      ok: false,
      requestId: message?.requestId || null,
      error: serializeC5Error(error)
    }));
  });
});

reconcileC5Runs().catch(() => {});

async function handleC5Message(message) {
  switch (message?.type) {
    case "GET_C5_STATE":
      return { type: "C5_STATE", ok: true, ...(await getC5State()) };
    case "PREPARE_C5_RUN":
      return prepareC5Run(message.payload || {});
    case "APPROVE_C5_RUN":
      return approveC5Run(message.runId);
    case "CANCEL_C5_RUN":
      return cancelC5Run(message.runId);
    case "STOP_C5_RUN":
      return stopC5Run(message.runId);
    default:
      return { type: "C5_ERROR", ok: false, error: { code: "C5_UNKNOWN_MESSAGE", message: "BrowserCrew received an unknown compare or handoff request." } };
  }
}

async function prepareC5Run(payload) {
  const mode = payload.mode === "specialist" ? "specialist" : payload.mode === "compare" ? "compare" : null;
  if (!mode) throw coded("C5_MODE_REQUIRED", "Choose Compare two AIs or Hand off to another AI.");
  const instruction = String(payload.instruction || "").replace(/\u0000/g, "").trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) throw coded("C5_INSTRUCTION_REQUIRED", "Describe what you want the AIs to compare or what you want the specialist AI to do.");

  const { connections, activeId } = await getConnectionRegistry();
  const source = connections.find((item) => item.id === activeId);
  const target = connections.find((item) => item.id === String(payload.targetConnectionId || ""));
  if (!source) throw coded("C5_SOURCE_NOT_FOUND", "Choose an active saved AI connection before starting a compare or handoff.");
  if (!target) throw coded("C5_TARGET_NOT_FOUND", "Choose another saved AI connection first.");
  if (source.id === target.id) throw coded("C5_TARGET_SAME_AS_SOURCE", "Choose a different AI connection for the second destination.");
  if (source.status !== "connected") throw coded("C5_SOURCE_NOT_CONNECTED", "Test the current AI connection before using it in a compare run.");
  if (target.status !== "connected") throw coded("C5_TARGET_NOT_CONNECTED", "Test the destination AI connection before sending chat context to it.");

  const conversation = payload.conversationId ? await getConversation(payload.conversationId) : null;
  const context = buildBoundedContext(conversation);
  const allowedConnectionIds = mode === "compare" ? [source.id, target.id] : [target.id];
  const policy = createAgentPolicy({
    mode,
    allowedConnectionIds,
    requestedBudgets: payload.requestedBudgets || null
  });
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const privatePayload = {
    schemaVersion: 1,
    runId,
    mode,
    conversationId: conversation?.id || null,
    source: privateConnectionSnapshot(source),
    target: privateConnectionSnapshot(target),
    instruction,
    history: context.history,
    policy,
    createdAt: now
  };
  const contextDigest = await sha256Hex(canonicalAgentJson(privatePayload));
  const run = {
    id: runId,
    schemaVersion: 1,
    kind: "chat_c5",
    mode,
    status: "awaiting_approval",
    checkpoint: "c5_transfer_preview",
    conversationId: conversation?.id || null,
    source: publicConnectionSnapshot(source),
    target: publicConnectionSnapshot(target),
    context: {
      messageCount: context.messageCount,
      characters: context.characters,
      instructionCharacters: instruction.length,
      includesPageSnapshot: false,
      includesAttachmentContents: false,
      includesToolResults: false
    },
    policy: publicAgentPolicy(policy),
    contextDigest,
    results: [],
    activity: [activity("approval.requested", mode === "compare"
      ? "Review both AI destinations before BrowserCrew sends this compare context."
      : `Review the destination before BrowserCrew sends this chat context to ${target.name}.`, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      messageCount: context.messageCount,
      characters: context.characters
    })],
    createdAt: now,
    updatedAt: now
  };
  const runs = await getRuns();
  runs.unshift(run);
  await chrome.storage.local.set({ [C5_RUNS_KEY]: runs.slice(0, MAX_RUNS) });
  const pending = await getPendingMap();
  pending[runId] = { ...privatePayload, contextDigest };
  await chrome.storage.session.set({ [C5_PENDING_KEY]: pending });
  const preview = previewRun(run);
  broadcastC5({ type: "C5_PREVIEW_READY", ok: true, run: publicRun(run), preview });
  return { type: "C5_PREVIEW_READY", ok: true, run: publicRun(run), preview };
}

async function approveC5Run(runId) {
  const runs = await getRuns();
  const runRecord = runs.find((item) => item.id === runId);
  if (!runRecord || runRecord.status !== "awaiting_approval") throw coded("C5_NOT_APPROVABLE", "That compare or handoff is no longer waiting for approval.");
  const pendingMap = await getPendingMap();
  const pending = pendingMap[runId];
  if (!pending) throw coded("C5_PRIVATE_CONTEXT_GONE", "The private transfer context is no longer available in this Chrome session. Review the handoff again.");
  const digest = await sha256Hex(canonicalAgentJson(stripDigest(pending)));
  if (digest !== runRecord.contextDigest || digest !== pending.contextDigest) throw coded("C5_CONTEXT_CHANGED", "The transfer context changed after review, so BrowserCrew refused to send it.");

  const { connections, activeId } = await getConnectionRegistry();
  const source = connections.find((item) => item.id === pending.source.id);
  const target = connections.find((item) => item.id === pending.target.id);
  if (!source || !target || activeId !== source.id) throw coded("C5_CONNECTION_CHANGED", "The active or destination AI changed after review. Review the transfer again.");
  verifyConnectionSnapshot(source, pending.source);
  verifyConnectionSnapshot(target, pending.target);
  if (source.status !== "connected" || target.status !== "connected") throw coded("C5_CONNECTION_NOT_CONNECTED", "One of the reviewed AI connections is no longer connected. Test it again before sending context.");

  const runtimePolicy = hydratePolicy(runRecord.policy);
  assertAgentConnectionAllowed(runtimePolicy, target.id);
  if (pending.mode === "compare") assertAgentConnectionAllowed(runtimePolicy, source.id);

  const runtime = { id: runId, cancelled: false, controller: null };
  activeC5Runs.set(runId, runtime);
  runRecord.status = "running";
  runRecord.checkpoint = "c5_approved";
  runRecord.approvedAt = new Date().toISOString();
  runRecord.updatedAt = runRecord.approvedAt;
  runRecord.activity.push(activity("tool.authorized", pending.mode === "compare"
    ? "You approved one bounded compare across the two reviewed AI connections."
    : `You approved one bounded context handoff to ${target.name}.`, {
    handoffBudget: runRecord.policy.budget.handoffs.max,
    modelBudget: runRecord.policy.budget.modelCalls.max,
    toolBudget: runRecord.policy.budget.toolCalls.max
  }));
  await saveRuns(runs);
  broadcastC5({ type: "C5_RUN_STARTED", ok: true, run: publicRun(runRecord) });

  try {
    assertAgentNotCancelled(runtime);
    consumeAgentBudget(runtimePolicy, "handoffs");
    syncPolicy(runRecord, runtimePolicy);
    runRecord.checkpoint = "c5_handoff_authorized";
    runRecord.activity.push(activity("checkpoint.saved", "The destination and run limits were locked before any new model request.", {
      handoffsUsed: runtimePolicy.budget.handoffs.used
    }));
    await saveRuns(runs);

    if (pending.mode === "compare") {
      const first = await dispatchModel(runtime, runtimePolicy, runRecord, source, pending, "first");
      runRecord.results.push(first);
      syncPolicy(runRecord, runtimePolicy);
      await saveRuns(runs);
      broadcastC5({ type: "C5_RESULT", ok: true, runId, result: first, run: publicRun(runRecord) });

      const second = await dispatchModel(runtime, runtimePolicy, runRecord, target, pending, "second");
      runRecord.results.push(second);
      syncPolicy(runRecord, runtimePolicy);
      await saveRuns(runs);
      broadcastC5({ type: "C5_RESULT", ok: true, runId, result: second, run: publicRun(runRecord) });
    } else {
      const result = await dispatchModel(runtime, runtimePolicy, runRecord, target, pending, "specialist");
      runRecord.results.push(result);
      syncPolicy(runRecord, runtimePolicy);
      await saveRuns(runs);
      broadcastC5({ type: "C5_RESULT", ok: true, runId, result, run: publicRun(runRecord) });
    }

    runRecord.status = "completed";
    runRecord.checkpoint = "c5_completed";
    runRecord.completedAt = new Date().toISOString();
    runRecord.updatedAt = runRecord.completedAt;
    runRecord.activity.push(activity("verification", "Checked that every model request stayed inside the approved connection list and declared run limits.", {
      modelCallsUsed: runtimePolicy.budget.modelCalls.used,
      toolCallsUsed: runtimePolicy.budget.toolCalls.used,
      handoffsUsed: runtimePolicy.budget.handoffs.used
    }));
    runRecord.activity.push(activity("done", pending.mode === "compare" ? "Two-model comparison complete." : "Specialist handoff complete.", null));
    delete pendingMap[runId];
    await chrome.storage.session.set({ [C5_PENDING_KEY]: pendingMap });
    await saveRuns(runs);
    const payload = { type: "C5_RUN_DONE", ok: true, run: publicRun(runRecord) };
    broadcastC5(payload);
    return payload;
  } catch (error) {
    const stopped = runtime.cancelled || error?.code === "AGENT_RUN_STOPPED" || error?.name === "AbortError";
    const budgetExhausted = /_BUDGET_EXHAUSTED$/.test(String(error?.code || ""));
    runRecord.status = stopped ? "stopped" : budgetExhausted ? "budget_exhausted" : "failed";
    runRecord.checkpoint = stopped ? "c5_stopped" : budgetExhausted ? "c5_budget_exhausted" : "c5_failed";
    runRecord.updatedAt = new Date().toISOString();
    syncPolicy(runRecord, runtimePolicy);
    runRecord.error = {
      code: stopped ? "AGENT_RUN_STOPPED" : String(error?.code || "C5_FAILED"),
      message: stopped ? "Stopped before BrowserCrew started more model work." : safeErrorMessage(error)
    };
    runRecord.activity.push(activity(stopped || budgetExhausted ? "warning" : "error", runRecord.error.message, {
      code: runRecord.error.code,
      modelCallsUsed: runtimePolicy.budget.modelCalls.used,
      handoffsUsed: runtimePolicy.budget.handoffs.used
    }));
    delete pendingMap[runId];
    await chrome.storage.session.set({ [C5_PENDING_KEY]: pendingMap });
    await saveRuns(runs);
    const payload = { type: "C5_RUN_DONE", ok: false, stopped, budgetExhausted, run: publicRun(runRecord), error: runRecord.error };
    broadcastC5(payload);
    return payload;
  } finally {
    activeC5Runs.delete(runId);
  }
}

async function dispatchModel(runtime, policy, runRecord, profile, pending, position) {
  assertAgentNotCancelled(runtime);
  assertAgentConnectionAllowed(policy, profile.id);
  consumeAgentBudget(policy, "modelCalls");
  assertAgentNotCancelled(runtime);
  syncPolicy(runRecord, policy);
  runRecord.checkpoint = "c5_model_dispatch_intent";
  runRecord.activity.push(activity("model.request.started", `Asking ${profile.name} (${profile.model}).`, {
    connectionId: profile.id,
    model: profile.model,
    destination: new URL(profile.baseUrl).origin,
    position,
    modelCallsUsed: policy.budget.modelCalls.used
  }));
  await replaceRun(runRecord);

  const secret = (await getConnectionSecrets())[profile.id] || "";
  await ensureProviderPermission(profile.baseUrl);
  runtime.controller = new AbortController();
  const response = await callProvider(profile, secret, buildMessages(pending, position), runtime);
  assertAgentNotCancelled(runtime);
  const result = {
    connectionId: profile.id,
    connectionName: profile.name,
    model: response.model || profile.model,
    destination: new URL(profile.baseUrl).origin,
    text: String(response.text || "").trim().slice(0, MAX_RESULT_CHARS),
    completedAt: new Date().toISOString()
  };
  if (!result.text) throw coded("C5_EMPTY_RESPONSE", `${profile.name} finished without a readable answer.`);
  runRecord.activity.push(activity("model.request.completed", `${profile.name} finished its bounded model call.`, {
    connectionId: profile.id,
    model: result.model,
    characters: result.text.length,
    modelCallsUsed: policy.budget.modelCalls.used
  }));
  syncPolicy(runRecord, policy);
  await replaceRun(runRecord);
  runtime.controller = null;
  return result;
}

async function cancelC5Run(runId) {
  const runs = await getRuns();
  const run = runs.find((item) => item.id === runId);
  if (!run || run.status !== "awaiting_approval") throw coded("C5_NOT_CANCELLABLE", "That compare or handoff is no longer waiting for review.");
  run.status = "cancelled";
  run.checkpoint = "c5_cancelled_before_transfer";
  run.updatedAt = new Date().toISOString();
  run.activity.push(activity("warning", "Cancelled before any new AI destination received the reviewed context.", null));
  const pending = await getPendingMap();
  delete pending[runId];
  await chrome.storage.session.set({ [C5_PENDING_KEY]: pending });
  await saveRuns(runs);
  const payload = { type: "C5_RUN_DONE", ok: true, cancelled: true, run: publicRun(run) };
  broadcastC5(payload);
  return payload;
}

async function stopC5Run(runId) {
  const runtime = activeC5Runs.get(runId);
  if (!runtime) return { type: "C5_STOPPED", ok: true, runId, alreadyFinished: true };
  runtime.cancelled = true;
  runtime.controller?.abort();
  return { type: "C5_STOPPED", ok: true, runId };
}

async function getC5State() {
  const { connections, activeId } = await getConnectionRegistry();
  return {
    activeId,
    connections: connections.map(publicConnectionSnapshot),
    runs: (await getRuns()).slice(0, 20).map(publicRun),
    activeRunIds: [...activeC5Runs.keys()]
  };
}

async function reconcileC5Runs() {
  const runs = await getRuns();
  const pending = await getPendingMap();
  let changed = false;
  for (const run of runs) {
    if (run?.kind !== "chat_c5") continue;
    if (run.status === "running") {
      run.status = "stopped";
      run.checkpoint = "c5_interrupted_no_replay";
      run.updatedAt = new Date().toISOString();
      run.error = { code: "C5_INTERRUPTED", message: "BrowserCrew restarted during this model-only run. It did not replay any model or tool dispatch." };
      run.activity = Array.isArray(run.activity) ? run.activity : [];
      run.activity.push(activity("warning", run.error.message, { recovery: true, noReplay: true }));
      changed = true;
    } else if (run.status === "awaiting_approval" && !pending[run.id]) {
      run.status = "needs_review";
      run.checkpoint = "c5_private_context_expired";
      run.updatedAt = new Date().toISOString();
      run.error = { code: "C5_PRIVATE_CONTEXT_GONE", message: "The private transfer context expired. Review the handoff again before sending anything." };
      changed = true;
    }
  }
  if (changed) await saveRuns(runs);
}

function buildMessages(pending, position) {
  const modeText = pending.mode === "compare"
    ? `You are one of two independently selected AIs answering the same reviewed request. This is the ${position === "first" ? "first" : "second"} answer. Do not imitate or speculate about the other AI.`
    : "You are the explicitly selected specialist AI receiving a bounded handoff from BrowserCrew.";
  const messages = [{
    role: "system",
    content: `${modeText} Use only the supplied saved chat text and the user's instruction. Do not ask for tools. Do not expose hidden chain-of-thought; provide a useful final answer.`
  }];
  for (const item of pending.history || []) messages.push({ role: item.role, content: item.content });
  messages.push({ role: "user", content: pending.instruction });
  return messages;
}

async function callProvider(profile, secret, messages, runtime) {
  assertAgentNotCancelled(runtime);
  const endpoint = `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const timeout = setTimeout(() => runtime.controller?.abort(), 60000);
  let response;
  try {
    response = await nativeFetch(endpoint, {
      method: "POST",
      headers,
      signal: runtime.controller.signal,
      body: JSON.stringify({ model: profile.model, messages, temperature: 0.2, max_tokens: 1200, stream: false })
    });
  } catch (error) {
    if (runtime.cancelled || error?.name === "AbortError") throw policyError("AGENT_RUN_STOPPED", "This compare or handoff was stopped before BrowserCrew started more work.");
    throw coded("C5_PROVIDER_UNREACHABLE", `BrowserCrew could not reach ${profile.name}. Check that connection and try again.`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw coded("C5_PROVIDER_ERROR", `${profile.name} returned HTTP ${response.status}. BrowserCrew did not save the provider's raw error body.`);
  let body;
  try { body = await response.json(); } catch { body = null; }
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw coded("C5_BAD_MODEL_RESPONSE", `${profile.name} answered in a format BrowserCrew could not read.`);
  return { text, model: body.model || profile.model };
}

function buildBoundedContext(conversation) {
  const candidates = (conversation?.messages || []).filter((item) => ["user", "assistant"].includes(item?.role)).slice(-MAX_CONTEXT_MESSAGES);
  const selected = [];
  let characters = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index];
    const remaining = MAX_CONTEXT_CHARS - characters;
    if (remaining <= 0) break;
    const content = String(item.text || "").replace(/\u0000/g, "").slice(0, Math.min(remaining, 5000));
    if (!content) continue;
    selected.unshift({ role: item.role, content });
    characters += content.length;
  }
  return { history: selected, messageCount: selected.length, characters };
}

function previewRun(run) {
  return {
    runId: run.id,
    mode: run.mode,
    source: run.source,
    target: run.target,
    context: run.context,
    policy: run.policy,
    disclosure: run.mode === "compare"
      ? `BrowserCrew will send the same bounded saved-chat text and this instruction to ${run.source.name} and ${run.target.name} only after you approve.`
      : `BrowserCrew will send the bounded saved-chat text and this instruction to ${run.target.name} only after you approve.`,
    excluded: "Current-page snapshots, raw attachment contents, tool results, credentials, browser cookies, and hidden reasoning are not included by this C5 transfer."
  };
}

function privateConnectionSnapshot(profile) {
  return { id: profile.id, name: profile.name, kind: profile.kind, model: profile.model, baseUrl: profile.baseUrl, status: profile.status };
}

function publicConnectionSnapshot(profile) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    model: profile.model,
    destination: safeOrigin(profile.baseUrl),
    status: profile.status
  };
}

function verifyConnectionSnapshot(profile, snapshot) {
  if (profile.id !== snapshot.id || profile.kind !== snapshot.kind || profile.model !== snapshot.model || profile.baseUrl !== snapshot.baseUrl) {
    throw coded("C5_CONNECTION_CHANGED", "An AI connection changed after review. BrowserCrew did not send the transfer.");
  }
}

function hydratePolicy(publicPolicy) {
  return {
    schemaVersion: publicPolicy.schemaVersion,
    mode: publicPolicy.mode,
    allowedConnectionIds: [...publicPolicy.allowedConnectionIds],
    budget: {
      modelCalls: { ...publicPolicy.budget.modelCalls },
      toolCalls: { ...publicPolicy.budget.toolCalls },
      handoffs: { ...publicPolicy.budget.handoffs }
    }
  };
}

function syncPolicy(run, policy) {
  run.policy = publicAgentPolicy(policy);
  run.updatedAt = new Date().toISOString();
}

function activity(type, summary, meta) {
  return { id: crypto.randomUUID(), type, at: new Date().toISOString(), summary: String(summary || "").slice(0, 1000), meta: sanitizeMeta(meta) };
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const safe = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/secret|key|authorization|cookie|token|prompt|content|text|reasoning/i.test(key)) continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) safe[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return safe;
}

function publicRun(run) {
  return {
    ...run,
    contextDigest: run.contextDigest ? "present" : null,
    activity: (run.activity || []).map((item) => ({ ...item, meta: sanitizeMeta(item.meta) })),
    results: (run.results || []).map((item) => ({ ...item, text: String(item.text || "").slice(0, MAX_RESULT_CHARS) }))
  };
}

async function getConnectionRegistry() {
  const stored = await chrome.storage.local.get([CONNECTIONS_KEY, ACTIVE_CONNECTION_KEY]);
  const connections = Array.isArray(stored[CONNECTIONS_KEY]) ? stored[CONNECTIONS_KEY] : [];
  return { connections, activeId: stored[ACTIVE_CONNECTION_KEY] || connections[0]?.id || null };
}

async function getConnectionSecrets() {
  const stored = await chrome.storage.session.get(CONNECTION_SECRETS_KEY);
  return stored[CONNECTION_SECRETS_KEY] && typeof stored[CONNECTION_SECRETS_KEY] === "object" ? stored[CONNECTION_SECRETS_KEY] : {};
}

async function getConversation(id) {
  const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
  return (Array.isArray(stored[CHAT_STORAGE_KEY]) ? stored[CHAT_STORAGE_KEY] : []).find((item) => item.id === id) || null;
}

async function getRuns() {
  const stored = await chrome.storage.local.get(C5_RUNS_KEY);
  return Array.isArray(stored[C5_RUNS_KEY]) ? stored[C5_RUNS_KEY] : [];
}

async function saveRuns(runs) {
  await chrome.storage.local.set({ [C5_RUNS_KEY]: runs.slice(0, MAX_RUNS) });
}

async function replaceRun(run) {
  const runs = await getRuns();
  const index = runs.findIndex((item) => item.id === run.id);
  if (index >= 0) runs[index] = run; else runs.unshift(run);
  await saveRuns(runs);
}

async function getPendingMap() {
  const stored = await chrome.storage.session.get(C5_PENDING_KEY);
  return stored[C5_PENDING_KEY] && typeof stored[C5_PENDING_KEY] === "object" ? stored[C5_PENDING_KEY] : {};
}

async function ensureProviderPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw coded("C5_UNSAFE_PROVIDER_URL", "Cloud AI connections must use HTTPS. Plain HTTP is allowed only for local AI on this computer.");
  }
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    throw coded("C5_PROVIDER_PERMISSION_DENIED", `Chrome access to ${url.hostname} is not approved. Test that saved connection first.`);
  }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function stripDigest(pending) {
  const { contextDigest, ...rest } = pending;
  return rest;
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return "unknown destination"; }
}

function safeErrorMessage(error) {
  return String(error?.message || "BrowserCrew could not finish this compare or handoff safely.").slice(0, 1000);
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeC5Error(error) {
  const allowed = new Set([
    "C5_MODE_REQUIRED", "C5_INSTRUCTION_REQUIRED", "C5_SOURCE_NOT_FOUND", "C5_TARGET_NOT_FOUND", "C5_TARGET_SAME_AS_SOURCE",
    "C5_SOURCE_NOT_CONNECTED", "C5_TARGET_NOT_CONNECTED", "C5_NOT_APPROVABLE", "C5_PRIVATE_CONTEXT_GONE", "C5_CONTEXT_CHANGED",
    "C5_CONNECTION_CHANGED", "C5_CONNECTION_NOT_CONNECTED", "C5_NOT_CANCELLABLE", "C5_PROVIDER_UNREACHABLE", "C5_PROVIDER_ERROR",
    "C5_BAD_MODEL_RESPONSE", "C5_EMPTY_RESPONSE", "C5_UNSAFE_PROVIDER_URL", "C5_PROVIDER_PERMISSION_DENIED", "AGENT_MODE_UNSUPPORTED",
    "AGENT_CONNECTION_ALLOWLIST_EMPTY", "AGENT_CONNECTION_NOT_ALLOWED", "AGENT_RUN_STOPPED", "AGENT_MODEL_BUDGET_EXHAUSTED",
    "AGENT_TOOL_BUDGET_EXHAUSTED", "AGENT_HANDOFF_BUDGET_EXHAUSTED", "AGENT_BUDGET_UNKNOWN"
  ]);
  const code = String(error?.code || "C5_FAILED");
  return { code: allowed.has(code) ? code : "C5_FAILED", message: allowed.has(code) ? safeErrorMessage(error) : "BrowserCrew stopped the compare or handoff safely. Review the destinations and try again." };
}

function broadcastC5(message) {
  for (const port of c5Ports) safePost(port, message);
}

function safePost(port, message) {
  try { port.postMessage(message); } catch {}
}
