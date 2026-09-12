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

  const session = await chrome.storage.session.get(PENDING_TOOL_GRANT_KEY);
  const grant = session[PENDING_TOOL_GRANT_KEY];
  if (!grant || !Array.isArray(grant.tools) || !grant.tools.includes(TOOL_ID)) return null;

  const conversation = await matchingRunningConversation(grant.scope);
  if (!conversation) return null;

  await chrome.storage.session.remove(PENDING_TOOL_GRANT_KEY);
  return { input, init, body, grant, conversation };
}

async function executeToolEnabledRequest({ input, init, body, grant, conversation }) {
  const toolDefinition = {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: "Read bounded visible text from the exact browser tab the user approved for this message. This tool takes no URL and cannot change the page.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  };

  const firstBody = { ...body, tools: [toolDefinition], tool_choice: "auto" };
  const firstResponse = await providerFetch(input, { ...init, body: JSON.stringify(firstBody) });
  if (!firstResponse.ok) return firstResponse;
  const first = await readCompletion(firstResponse);

  if (!first.toolCalls.length) return completionResponse(first);
  if (first.toolCalls.length !== 1) {
    await addToolActivity(conversation.id, "warning", "The AI asked for more tool calls than this message allows, so BrowserCrew did not run them.", { tool: TOOL_ID, allowedCalls: 1, requestedCalls: first.toolCalls.length });
    return refusalResponse("BrowserCrew stopped the tool step because this message allows only one page read. Send another message if you want to read again.", first.model);
  }

  const requested = first.toolCalls[0];
  await addToolActivity(conversation.id, "tool.requested", "The AI asked to read the page you approved for this message.", {
    tool: TOOL_ID,
    host: safeHost(grant?.tab?.url),
    toolCallId: requested.id
  });

  if (init.signal?.aborted) return refusalResponse("The response was stopped before BrowserCrew started the tool.", first.model);
  if (requested.name !== TOOL_NAME || !emptyArguments(requested.arguments)) {
    await addToolActivity(conversation.id, "warning", "BrowserCrew refused a tool request that did not match the approved page-read contract.", { tool: TOOL_ID, toolCallId: requested.id });
    return refusalResponse("BrowserCrew refused the tool request because it did not match the page-read permission you approved.", first.model);
  }

  const validation = await validateGrant(grant);
  if (!validation.ok) {
    await addToolActivity(conversation.id, "warning", validation.message, { tool: TOOL_ID, host: safeHost(grant?.tab?.url), grantId: grant.id });
    return refusalResponse(validation.userMessage, first.model);
  }

  await addToolActivity(conversation.id, "tool.authorized", "Allowed for this message only: read visible text from this exact page.", {
    tool: TOOL_ID,
    host: safeHost(grant.tab.url),
    grantId: grant.id,
    access: "read_only"
  });
  if (init.signal?.aborted) return refusalResponse("The response was stopped before BrowserCrew started the tool.", first.model);

  await addToolActivity(conversation.id, "tool.started", "Reading bounded visible text from the approved page.", {
    tool: TOOL_ID,
    host: safeHost(grant.tab.url),
    grantId: grant.id
  });
  const observation = await observeGrantedPage(grant.tab);
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
    grantId: grant.id,
    exactUrlMatched: true
  });

  if (init.signal?.aborted) return refusalResponse("The response was stopped after the page read, before another model request started.", first.model);

  const assistantToolCall = {
    role: "assistant",
    content: first.text || null,
    tool_calls: [{
      id: requested.id,
      type: "function",
      function: { name: TOOL_NAME, arguments: requested.arguments || "{}" }
    }]
  };
  const toolResult = {
    role: "tool",
    tool_call_id: requested.id,
    content: JSON.stringify({
      pageTitle: observation.title,
      pageAddress: observation.url,
      visibleText: observation.text,
      boundedCharacters: observation.text.length
    })
  };
  const secondBody = {
    ...body,
    messages: [...body.messages, assistantToolCall, toolResult],
    stream: true
  };
  delete secondBody.tools;
  delete secondBody.tool_choice;

  const secondResponse = await providerFetch(input, { ...init, body: JSON.stringify(secondBody) });
  if (!secondResponse.ok) return secondResponse;
  const second = await readCompletion(secondResponse);
  if (second.toolCalls.length) {
    await addToolActivity(conversation.id, "warning", "The AI asked for another tool after the one-call budget was used, so BrowserCrew stopped tool dispatch.", { tool: TOOL_ID, allowedCalls: 1 });
    return refusalResponse("BrowserCrew used the one page-read tool call allowed for this message. Send another message if another read is needed.", second.model || first.model);
  }
  return completionResponse(second);
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

function safePost(port, message) {
  try { port.postMessage(message); } catch {}
}
