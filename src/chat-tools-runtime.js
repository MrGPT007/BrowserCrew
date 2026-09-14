import {
  BROWSER_CONTROL_TOOL_ID,
  BROWSER_CONTROL_TOOL_NAME,
  browserControlToolDefinition,
  executeBrowserControlAction,
  getBrowserControlGrant
} from "./browser-control-runtime.js";

const PENDING_TOOL_GRANT_KEY = "browsercrew.chatPendingToolGrant.v1";
const CHAT_STORAGE_KEY = "browsercrew.conversations.v1";
const CHAT_PORT = "browsercrew-chat";
const MAX_PAGE_CHARS = 12000;
const TOOL_NAME = "browsercrew_page_read";
const TOOL_ID = "page.read";
const toolPorts = new Set();
const providerFetch = globalThis.fetch.bind(globalThis);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHAT_PORT) return;
  toolPorts.add(port);
  port.onDisconnect.addListener(() => toolPorts.delete(port));
});

globalThis.fetch = async (input, init = undefined) => {
  const prepared = await prepareToolEnabledRequest(input, init);
  if (!prepared) return providerFetch(input, init);
  return executeToolEnabledRequest(prepared);
};

async function prepareToolEnabledRequest(input, init) {
  if (!init || String(init.method || "GET").toUpperCase() !== "POST" || typeof init.body !== "string") return null;
  const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (!String(urlText || "").includes("/chat/completions")) return null;

  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  if (body?.stream !== true || !Array.isArray(body.messages)) return null;

  const [session, controlGrant] = await Promise.all([
    chrome.storage.session.get(PENDING_TOOL_GRANT_KEY),
    getBrowserControlGrant().catch(() => null)
  ]);
  const pageGrant = session[PENDING_TOOL_GRANT_KEY];
  const hasPageGrant = Boolean(pageGrant && Array.isArray(pageGrant.tools) && pageGrant.tools.includes(TOOL_ID));
  if (!hasPageGrant && !controlGrant) return null;

  const scope = hasPageGrant ? pageGrant.scope : "new";
  const conversation = await matchingRunningConversation(scope);
  if (!conversation) return null;

  if (hasPageGrant) await chrome.storage.session.remove(PENDING_TOOL_GRANT_KEY);
  return { input, init, body, pageGrant: hasPageGrant ? pageGrant : null, controlGrant, conversation };
}

async function executeToolEnabledRequest({ input, init, body, pageGrant, controlGrant, conversation }) {
  const pageDefinition = pageGrant ? pageReadToolDefinition() : null;
  const controlDefinition = controlGrant ? browserControlToolDefinition() : null;
  const tools = [pageDefinition, controlDefinition].filter(Boolean);
  let messages = [...body.messages];
  let pageReadUsed = false;
  let browserSteps = 0;
  const maxBrowserSteps = Number(controlGrant?.maxSteps || 0);
  let model = null;

  for (;;) {
    if (init.signal?.aborted) return refusalResponse("Stopped. BrowserCrew will not start another tool or model step.", model);
    const canUsePage = Boolean(pageDefinition && !pageReadUsed);
    const canUseBrowser = Boolean(controlDefinition && browserSteps < maxBrowserSteps);
    const availableTools = [canUsePage ? pageDefinition : null, canUseBrowser ? controlDefinition : null].filter(Boolean);
    const requestBody = {
      ...body,
      messages,
      tools,
      tool_choice: availableTools.length ? "auto" : "none",
      stream: true
    };
    const response = await providerFetch(input, { ...init, body: JSON.stringify(requestBody) });
    if (!response.ok) return response;
    const completion = await readCompletion(response);
    model = completion.model || model;

    if (!completion.toolCalls.length) return completionResponse(completion);
    if (!availableTools.length) {
      await addToolActivity(conversation.id, "warning", "The AI asked for another tool after the active tool budget was exhausted, so BrowserCrew stopped tool dispatch.", { tool: "tool-budget", browserSteps, pageReadUsed });
      return refusalResponse("BrowserCrew reached the active tool limit for this message. Send another message to continue.", model);
    }
    if (completion.toolCalls.length !== 1) {
      await addToolActivity(conversation.id, "warning", "The AI asked for multiple browser actions at once. BrowserCrew requires one verified action at a time.", { tool: "tool-dispatch", requestedCalls: completion.toolCalls.length });
      return refusalResponse("BrowserCrew requires one browser action at a time so every step can be checked before the next one.", model);
    }

    const requested = completion.toolCalls[0];
    const assistantToolCall = assistantToolCallMessage(completion, requested);

    if (requested.name === TOOL_NAME && canUsePage) {
      const outcome = await runPageReadTool({ requested, pageGrant, conversation, signal: init.signal });
      if (outcome.directResponse) return outcome.directResponse;
      pageReadUsed = true;
      messages = [...messages, assistantToolCall, toolMessage(requested.id, outcome.result)];
      continue;
    }

    if (requested.name === BROWSER_CONTROL_TOOL_NAME && canUseBrowser) {
      const outcome = await runBrowserControlTool({ requested, initialGrant: controlGrant, conversation, signal: init.signal, step: browserSteps + 1 });
      browserSteps += 1;
      messages = [...messages, assistantToolCall, toolMessage(requested.id, outcome.result)];
      if (outcome.halt) {
        const finalBody = { ...body, messages, tools, tool_choice: "none", stream: true };
        const finalResponse = await providerFetch(input, { ...init, body: JSON.stringify(finalBody) });
        if (!finalResponse.ok) return finalResponse;
        const final = await readCompletion(finalResponse);
        if (final.toolCalls.length) return refusalResponse("BrowserCrew paused browser control and is waiting for you.", final.model || model);
        return completionResponse(final);
      }
      continue;
    }

    await addToolActivity(conversation.id, "warning", "BrowserCrew refused a tool request outside the active grant.", { tool: safeToolName(requested.name), toolCallId: requested.id });
    return refusalResponse("BrowserCrew refused a tool request that was outside the active permission or had already used its budget.", model);
  }
}

function pageReadToolDefinition() {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: "Read bounded visible text from the exact browser tab the user approved for this message. This tool takes no URL and cannot change the page.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  };
}

async function runPageReadTool({ requested, pageGrant, conversation, signal }) {
  await addToolActivity(conversation.id, "tool.requested", "The AI asked to read the page you approved for this message.", {
    tool: TOOL_ID,
    host: safeHost(pageGrant?.tab?.url),
    toolCallId: requested.id
  });

  if (signal?.aborted) return { directResponse: refusalResponse("The response was stopped before BrowserCrew started the tool.", null) };
  if (!emptyArguments(requested.arguments)) {
    await addToolActivity(conversation.id, "warning", "BrowserCrew refused a tool request that did not match the approved page-read contract.", { tool: TOOL_ID, toolCallId: requested.id });
    return { directResponse: refusalResponse("BrowserCrew refused the tool request because it did not match the page-read permission you approved.", null) };
  }

  const validation = await validateGrant(pageGrant);
  if (!validation.ok) {
    await addToolActivity(conversation.id, "warning", validation.message, { tool: TOOL_ID, host: safeHost(pageGrant?.tab?.url), grantId: pageGrant?.id });
    return { directResponse: refusalResponse(validation.userMessage, null) };
  }

  await addToolActivity(conversation.id, "tool.authorized", "Allowed for this message only: read visible text from this exact page.", {
    tool: TOOL_ID,
    host: safeHost(pageGrant.tab.url),
    grantId: pageGrant.id,
    access: "read_only"
  });
  if (signal?.aborted) return { directResponse: refusalResponse("The response was stopped before BrowserCrew started the tool.", null) };

  await addToolActivity(conversation.id, "tool.started", "Reading bounded visible text from the approved page.", {
    tool: TOOL_ID,
    host: safeHost(pageGrant.tab.url),
    grantId: pageGrant.id
  });
  const observation = await observeGrantedPage(pageGrant.tab);
  await addToolActivity(conversation.id, "tool.completed", "Page read finished and the bounded result is ready for the AI.", {
    tool: TOOL_ID,
    host: safeHost(observation.url),
    pageTitle: observation.title,
    characters: observation.text.length,
    toolCallId: requested.id
  });
  await addToolActivity(conversation.id, "verification", "Checked that the tool stayed inside the exact approved tab and page address.", {
    tool: TOOL_ID,
    host: safeHost(observation.url),
    grantId: pageGrant.id,
    exactUrlMatched: true
  });
  if (signal?.aborted) return { directResponse: refusalResponse("The response was stopped after the page read, before another model request started.", null) };
  return {
    result: {
      pageTitle: observation.title,
      pageAddress: observation.url,
      visibleText: observation.text,
      boundedCharacters: observation.text.length
    }
  };
}

async function runBrowserControlTool({ requested, initialGrant, conversation, signal, step }) {
  await addToolActivity(conversation.id, "control.requested", `Browser control requested step ${step}.`, {
    tool: BROWSER_CONTROL_TOOL_ID,
    toolCallId: requested.id,
    step
  });
  if (signal?.aborted) return { result: { ok: false, code: "BROWSER_CONTROL_STOPPED", message: "Stopped before the browser action started." }, halt: true };

  const currentGrant = await getBrowserControlGrant().catch(() => null);
  if (!currentGrant || currentGrant.id !== initialGrant?.id) {
    await addToolActivity(conversation.id, "control.blocked", "Browser control was turned off before the next action, so BrowserCrew did not dispatch it.", { tool: BROWSER_CONTROL_TOOL_ID, step });
    return { result: { ok: false, code: "BROWSER_CONTROL_OFF", message: "Browser control is off. Turn it on again to continue." }, halt: true };
  }

  let args;
  try { args = JSON.parse(String(requested.arguments || "{}")); }
  catch {
    await addToolActivity(conversation.id, "control.blocked", "The AI supplied invalid browser-action arguments, so BrowserCrew did not dispatch them.", { tool: BROWSER_CONTROL_TOOL_ID, step });
    return { result: { ok: false, code: "BROWSER_ACTION_ARGS_INVALID", message: "The browser action arguments were invalid." }, halt: false };
  }

  const action = safeActionName(args?.action);
  await addToolActivity(conversation.id, "control.authorized", `Browser control is ON. Step ${step} may use ${action}.`, {
    tool: BROWSER_CONTROL_TOOL_ID,
    action,
    grantId: currentGrant.id,
    step,
    access: "browser_control"
  });
  await addToolActivity(conversation.id, "control.started", `Running browser action: ${action}.`, {
    tool: BROWSER_CONTROL_TOOL_ID,
    action,
    step
  });

  try {
    const result = await executeBrowserControlAction(args, currentGrant, { signal });
    const blocked = result?.ok === false;
    const halt = blocked && ["CONFIRMATION_REQUIRED", "SECRET_FIELD_BLOCKED", "BROWSER_CONTROL_OFF", "BROWSER_CONTROL_STOPPED"].includes(String(result.code || ""));
    await addToolActivity(
      conversation.id,
      blocked ? "control.blocked" : "control.completed",
      blocked ? safeActivityMessage(result.message || `Browser action ${action} was blocked.`) : `Browser action finished: ${action}.`,
      { tool: BROWSER_CONTROL_TOOL_ID, action, step, code: result?.code || null, tabId: result?.tab?.id || null }
    );
    if (!blocked) {
      await addToolActivity(conversation.id, "control.verification", `Verified completion of browser action ${action} before allowing another step.`, {
        tool: BROWSER_CONTROL_TOOL_ID,
        action,
        step,
        tabId: result?.tab?.id || null
      });
    }
    return { result, halt };
  } catch (error) {
    const code = String(error?.code || "BROWSER_ACTION_FAILED");
    const message = safeActivityMessage(error?.message || "BrowserCrew could not complete that browser action.");
    const halt = ["BROWSER_CONTROL_OFF", "BROWSER_CONTROL_STOPPED", "BROWSER_URL_BLOCKED"].includes(code);
    await addToolActivity(conversation.id, "control.blocked", message, { tool: BROWSER_CONTROL_TOOL_ID, action, step, code });
    return { result: { ok: false, code, message }, halt };
  }
}

function assistantToolCallMessage(completion, requested) {
  return {
    role: "assistant",
    content: completion.text || null,
    tool_calls: [{
      id: requested.id,
      type: "function",
      function: { name: requested.name, arguments: requested.arguments || "{}" }
    }]
  };
}

function toolMessage(toolCallId, result) {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(result ?? { ok: true }) };
}

async function validateGrant(grant) {
  if (!grant?.id || !grant?.tab?.id || !grant?.tab?.url || !Array.isArray(grant.tools) || !grant.tools.includes(TOOL_ID)) {
    return { ok: false, message: "The saved tool permission was incomplete, so BrowserCrew refused the read.", userMessage: "Choose the page-read tool again before sending." };
  }
  let url;
  try { url = new URL(grant.tab.url); } catch {
    return { ok: false, message: "The approved page address was invalid, so BrowserCrew refused the read.", userMessage: "Choose the page-read tool again on a normal website page." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, message: "The approved resource was not a normal website page.", userMessage: "The page-read tool works only on normal website pages." };
  }
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, message: "Chrome site access was no longer available when the tool was requested.", userMessage: "BrowserCrew no longer has access to that site. Enable the page-read tool again and approve Chrome access." };
  }
  const tab = await chrome.tabs.get(grant.tab.id).catch(() => null);
  if (!tab?.url || tab.url !== grant.tab.url) {
    return { ok: false, message: "The approved tab changed pages before the tool ran, so BrowserCrew did not read the new page.", userMessage: "The approved page changed before BrowserCrew could read it. Enable the tool again on the page you want." };
  }
  return { ok: true };
}

async function observeGrantedPage(tab) {
  const current = await chrome.tabs.get(tab.id);
  if (!current?.url || current.url !== tab.url) throw new Error("Approved page changed before tool execution.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (maxChars) => {
      const clone = document.body?.cloneNode(true);
      if (!clone) return { title: document.title, url: location.href, text: "" };
      clone.querySelectorAll("script,style,noscript,template,input[type='password'],[hidden],[aria-hidden='true']").forEach((node) => node.remove());
      const text = String(clone.innerText || clone.textContent || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
      return { title: document.title, url: location.href, text };
    },
    args: [MAX_PAGE_CHARS]
  });
  if (!result?.text) throw new Error("Approved page had no readable visible text.");
  if (result.url !== tab.url) throw new Error("Approved page changed during tool execution.");
  return { title: String(result.title || "Untitled page").slice(0, 240), url: result.url, text: result.text };
}

async function matchingRunningConversation(scope) {
  const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
  const conversations = Array.isArray(stored[CHAT_STORAGE_KEY]) ? stored[CHAT_STORAGE_KEY] : [];
  const running = conversations.filter((item) => item?.status === "running");
  if (scope && scope !== "new") return running.find((item) => item.id === scope) || null;
  return running.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

async function addToolActivity(conversationId, type, summary, meta = null) {
  const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
  const conversations = Array.isArray(stored[CHAT_STORAGE_KEY]) ? stored[CHAT_STORAGE_KEY] : [];
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return null;
  const event = {
    id: crypto.randomUUID(),
    type,
    at: new Date().toISOString(),
    summary: String(summary || "").slice(0, 1000),
    meta: sanitizeMeta(meta)
  };
  conversation.activity = Array.isArray(conversation.activity) ? conversation.activity : [];
  conversation.activity.push(event);
  conversation.activity = conversation.activity.slice(-300);
  conversation.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [CHAT_STORAGE_KEY]: conversations });
  for (const port of toolPorts) safePost(port, { type: "CHAT_ACTIVITY", ok: true, conversationId, event });
  return event;
}

async function readCompletion(response) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/event-stream")) {
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body) return { text: "", model: null, usage: null, toolCalls: [] };
    const message = body.choices?.[0]?.message || {};
    return {
      text: typeof message.content === "string" ? message.content : "",
      model: body.model || null,
      usage: body.usage || null,
      toolCalls: normalizeToolCalls(message.tool_calls)
    };
  }

  const raw = await response.text();
  let text = "";
  let model = null;
  let usage = null;
  const calls = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.model) model = event.model;
    if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta || {};
    if (typeof delta.content === "string") text += delta.content;
    for (const fragment of delta.tool_calls || []) {
      const index = Number.isInteger(fragment.index) ? fragment.index : 0;
      const current = calls.get(index) || { id: "", name: "", arguments: "" };
      if (fragment.id) current.id = fragment.id;
      if (fragment.function?.name) current.name += fragment.function.name;
      if (fragment.function?.arguments) current.arguments += fragment.function.arguments;
      calls.set(index, current);
    }
  }
  return { text, model, usage, toolCalls: [...calls.values()].map((item, index) => ({ id: item.id || `tool-${index + 1}`, name: item.name, arguments: item.arguments || "{}" })) };
}

function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => ({
    id: String(item?.id || `tool-${index + 1}`),
    name: String(item?.function?.name || ""),
    arguments: String(item?.function?.arguments || "{}")
  }));
}

function completionResponse(completion) {
  const payload = {
    model: completion.model || undefined,
    choices: [{ index: 0, delta: { content: completion.text || "" }, finish_reason: null }],
    usage: completion.usage || undefined
  };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" }
  });
}

function refusalResponse(message, model) {
  return completionResponse({ text: message, model: model || null, usage: null });
}

function emptyArguments(value) {
  const text = String(value || "{}").trim();
  if (!text || text === "{}") return true;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch { return false; }
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const safe = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/secret|key|authorization|cookie|token|prompt|content|text|argument/i.test(key)) continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) safe[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return safe;
}

function safeHost(value) {
  try { return new URL(value).hostname; } catch { return "unknown site"; }
}

function safeToolName(value) {
  return String(value || "unknown").replace(/[^a-z0-9_.-]/gi, "").slice(0, 120) || "unknown";
}

function safeActionName(value) {
  return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 80) || "unknown";
}

function safeActivityMessage(value) {
  return String(value || "Browser action did not finish.").replace(/\u0000/g, "").slice(0, 700);
}

function safePost(port, message) {
  try { port.postMessage(message); } catch {}
}
