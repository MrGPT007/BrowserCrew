const CONNECTIONS_KEY = "browsercrew.connections.v1";
const LEGACY_SETTINGS_KEY = "browsercrew.settings.v1";
const ANTHROPIC_KIND = "anthropic";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_COMPLETIONS_SUFFIX = "/chat/completions";
const THINKING_CACHE_TTL_MS = 5 * 60 * 1000;

const providerNativeFetch = globalThis.fetch.bind(globalThis);
const preservedThinkingByToolUseId = new Map();

globalThis.fetch = async (input, init = undefined) => {
  const prepared = await prepareAnthropicRequest(input, init);
  if (!prepared) return providerNativeFetch(input, init);
  return dispatchAnthropicRequest(prepared);
};

async function prepareAnthropicRequest(input, init) {
  if (!init || String(init.method || "GET").toUpperCase() !== "POST" || typeof init.body !== "string") return null;
  const urlText = requestUrl(input);
  if (!urlText || !urlText.endsWith(OPENAI_COMPLETIONS_SUFFIX)) return null;

  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  if (!body || typeof body !== "object" || !body.model || !Array.isArray(body.messages)) return null;

  const baseUrl = urlText.slice(0, -OPENAI_COMPLETIONS_SUFFIX.length).replace(/\/$/, "");
  if (!(await isAnthropicDestination(baseUrl, String(body.model)))) return null;

  const incomingHeaders = new Headers(init.headers || undefined);
  const authorization = String(incomingHeaders.get("authorization") || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";

  incomingHeaders.delete("authorization");
  incomingHeaders.delete("x-api-key");
  incomingHeaders.delete("anthropic-version");
  incomingHeaders.set("content-type", "application/json");
  incomingHeaders.set("anthropic-version", ANTHROPIC_VERSION);
  if (bearer) incomingHeaders.set("x-api-key", bearer);

  const anthropicBody = translateOpenAIRequest(body);
  return {
    endpoint: `${baseUrl}/messages`,
    init: { ...init, headers: incomingHeaders, body: JSON.stringify(anthropicBody) },
    requestedModel: String(body.model),
    wantsStream: body.stream === true
  };
}

async function isAnthropicDestination(baseUrl, model) {
  let url;
  try { url = new URL(baseUrl); } catch { return false; }

  if (url.origin === "https://api.anthropic.com" && /^claude-/i.test(model)) return true;

  const local = await chrome.storage.local.get([CONNECTIONS_KEY, LEGACY_SETTINGS_KEY]);
  const connections = Array.isArray(local[CONNECTIONS_KEY]) ? local[CONNECTIONS_KEY] : [];
  const exact = connections.some((profile) => profile?.kind === ANTHROPIC_KIND
    && sameBaseUrl(profile.baseUrl, baseUrl)
    && String(profile.model || "") === model);
  if (exact) return true;

  const legacy = local[LEGACY_SETTINGS_KEY];
  return legacy?.kind === ANTHROPIC_KIND
    && sameBaseUrl(legacy.baseUrl, baseUrl)
    && String(legacy.model || "") === model;
}

function sameBaseUrl(a, b) {
  return String(a || "").replace(/\/$/, "") === String(b || "").replace(/\/$/, "");
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return typeof input?.url === "string" ? input.url : "";
}

function translateOpenAIRequest(body) {
  const translated = translateMessages(body.messages);
  const request = {
    model: String(body.model),
    max_tokens: positiveInteger(body.max_tokens, 1200),
    messages: translated.messages,
    stream: body.stream === true
  };

  if (translated.system.length) request.system = translated.system.join("\n\n");

  const tools = translateTools(body.tools);
  if (tools.length) {
    request.tools = tools;
    const choice = translateToolChoice(body.tool_choice);
    if (choice) request.tool_choice = choice;
  }

  // BrowserCrew intentionally does not forward OpenAI sampling parameters. Current
  // Claude models accept the default sampling behavior across more model families,
  // while newer models reject non-default temperature/top-p/top-k values.
  return request;
}

function translateMessages(messages) {
  const system = [];
  const translated = [];

  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      const text = textContent(message.content);
      if (text) system.push(text);
      continue;
    }

    if (message.role === "assistant") {
      const blocks = [];
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length) blocks.push(...takePreservedThinking(toolCalls.map((item) => String(item?.id || "")).filter(Boolean)));
      const text = textContent(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of toolCalls) {
        const name = String(call?.function?.name || "");
        if (!name) continue;
        blocks.push({
          type: "tool_use",
          id: String(call?.id || crypto.randomUUID()),
          name,
          input: parseToolArguments(call?.function?.arguments)
        });
      }
      if (blocks.length) appendMessage(translated, "assistant", blocks);
      continue;
    }

    if (message.role === "tool") {
      const toolUseId = String(message.tool_call_id || "");
      if (!toolUseId) continue;
      appendMessage(translated, "user", [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: textContent(message.content) || ""
      }]);
      continue;
    }

    if (message.role === "user") {
      const text = textContent(message.content);
      if (text) appendMessage(translated, "user", [{ type: "text", text }]);
    }
  }

  if (!translated.length) translated.push({ role: "user", content: [{ type: "text", text: "" }] });
  return { system, messages: translated };
}

function appendMessage(target, role, blocks) {
  const safeBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!safeBlocks.length) return;
  const previous = target[target.length - 1];
  if (previous?.role === role) {
    if (role === "user") {
      const toolResults = safeBlocks.filter((block) => block.type === "tool_result");
      const rest = safeBlocks.filter((block) => block.type !== "tool_result");
      previous.content = [...toolResults, ...previous.content, ...rest];
    } else {
      previous.content.push(...safeBlocks);
    }
    return;
  }
  target.push({ role, content: safeBlocks });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "{}").trim();
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (tool?.type !== "function" || !tool.function?.name) return [];
    return [{
      name: String(tool.function.name),
      description: String(tool.function.description || ""),
      input_schema: tool.function.parameters && typeof tool.function.parameters === "object"
        ? tool.function.parameters
        : { type: "object", properties: {} }
    }];
  });
}

function translateToolChoice(choice) {
  if (!choice || choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice?.type === "function" && choice.function?.name) return { type: "tool", name: String(choice.function.name) };
  return null;
}

async function dispatchAnthropicRequest(prepared) {
  let response;
  try {
    response = await providerNativeFetch(prepared.endpoint, prepared.init);
  } catch (error) {
    throw error;
  }

  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    return sanitizedErrorResponse(response.status);
  }

  if (prepared.wantsStream) return translateAnthropicStream(response, prepared.requestedModel);
  return translateAnthropicJson(response, prepared.requestedModel);
}

async function translateAnthropicJson(response, fallbackModel) {
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!body || typeof body !== "object") return invalidProviderResponse();

  const text = [];
  const toolCalls = [];
  const preservedThinking = [];
  for (const block of Array.isArray(body.content) ? body.content : []) {
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || `tool-${toolCalls.length + 1}`),
        type: "function",
        function: { name: String(block.name || ""), arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}) }
      });
    } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      preservedThinking.push(clonePreservedThinkingBlock(block));
    }
  }
  if (toolCalls.length && preservedThinking.length) savePreservedThinking(toolCalls.map((item) => item.id), preservedThinking);

  const message = { role: "assistant", content: text.join("") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const normalized = {
    id: String(body.id || ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(body.model || fallbackModel),
    choices: [{ index: 0, message, finish_reason: normalizeStopReason(body.stop_reason) }],
    usage: normalizeUsage(body.usage)
  };
  return new Response(JSON.stringify(normalized), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function translateAnthropicStream(response, fallbackModel) {
  if (!response.body) return invalidProviderResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = {
    model: fallbackModel,
    usage: { input_tokens: 0, output_tokens: 0 },
    nextToolIndex: 0,
    toolIndexByBlock: new Map(),
    toolIds: [],
    thinkingByBlock: new Map(),
    stopped: false
  };

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const packets = buffer.split(/\r?\n\r?\n/);
          buffer = packets.pop() || "";
          for (const packet of packets) handleAnthropicPacket(packet, state, controller, encoder);
          if (state.stopped) break;
        }
        buffer += decoder.decode();
        if (!state.stopped && buffer.trim()) handleAnthropicPacket(buffer, state, controller, encoder);
        if (!state.stopped) {
          persistStreamThinking(state);
          emitDone(controller, encoder);
        }
        controller.close();
      } catch (error) {
        if (error?.name === "AbortError") controller.error(error);
        else controller.error(new Error("The Anthropic response stream ended before BrowserCrew could finish reading it."));
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }
  });
}

function handleAnthropicPacket(packet, state, controller, encoder) {
  const data = packet.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .join("\n");
  if (!data) return;

  let event;
  try { event = JSON.parse(data); } catch { return; }
  if (!event || typeof event !== "object") return;

  if (event.type === "error") {
    state.stopped = true;
    controller.error(new Error("Anthropic reported a streaming error. BrowserCrew did not expose the provider's raw error text."));
    return;
  }

  if (event.type === "message_start") {
    state.model = String(event.message?.model || state.model);
    mergeUsage(state.usage, event.message?.usage);
    emitChunk(controller, encoder, { model: state.model, choices: [], usage: normalizeUsage(state.usage) });
    return;
  }

  if (event.type === "content_block_start") {
    const block = event.content_block || {};
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      state.thinkingByBlock.set(event.index, clonePreservedThinkingBlock(block));
      return;
    }
    if (block.type === "text") {
      if (block.text) emitTextDelta(controller, encoder, state.model, String(block.text));
      return;
    }
    if (block.type === "tool_use") {
      const toolIndex = state.nextToolIndex++;
      state.toolIndexByBlock.set(event.index, toolIndex);
      const id = String(block.id || `tool-${toolIndex + 1}`);
      state.toolIds.push(id);
      const initialArguments = block.input && typeof block.input === "object" && Object.keys(block.input).length
        ? JSON.stringify(block.input)
        : "";
      emitChunk(controller, encoder, {
        model: state.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, id, type: "function", function: { name: String(block.name || ""), arguments: initialArguments } }] }, finish_reason: null }]
      });
    }
    return;
  }

  if (event.type === "content_block_delta") {
    const delta = event.delta || {};
    if (delta.type === "thinking_delta") {
      const block = state.thinkingByBlock.get(event.index);
      if (block && typeof delta.thinking === "string") block.thinking = `${block.thinking || ""}${delta.thinking}`;
      return;
    }
    if (delta.type === "signature_delta") {
      const block = state.thinkingByBlock.get(event.index);
      if (block && typeof delta.signature === "string") block.signature = `${block.signature || ""}${delta.signature}`;
      return;
    }
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      emitTextDelta(controller, encoder, state.model, delta.text);
      return;
    }
    if (delta.type === "input_json_delta") {
      const toolIndex = state.toolIndexByBlock.get(event.index);
      if (Number.isInteger(toolIndex) && typeof delta.partial_json === "string") {
        emitChunk(controller, encoder, {
          model: state.model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }, finish_reason: null }]
        });
      }
    }
    return;
  }

  if (event.type === "message_delta") {
    mergeUsage(state.usage, event.usage);
    emitChunk(controller, encoder, {
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: normalizeStopReason(event.delta?.stop_reason) }],
      usage: normalizeUsage(state.usage)
    });
    return;
  }

  if (event.type === "message_stop") {
    persistStreamThinking(state);
    state.stopped = true;
    emitDone(controller, encoder);
  }
}

function persistStreamThinking(state) {
  if (!state.toolIds.length || !state.thinkingByBlock.size) return;
  savePreservedThinking(state.toolIds, [...state.thinkingByBlock.values()]);
}

function emitTextDelta(controller, encoder, model, text) {
  if (!text) return;
  emitChunk(controller, encoder, {
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  });
}

function emitChunk(controller, encoder, payload) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function emitDone(controller, encoder) {
  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
}

function normalizeStopReason(reason) {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "refusal" || reason === "pause_turn") return "stop";
  return reason ? "stop" : null;
}

function normalizeUsage(usage) {
  const prompt = nonNegativeInteger(usage?.input_tokens);
  const completion = nonNegativeInteger(usage?.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== "object") return;
  if (Number.isFinite(Number(usage.input_tokens))) target.input_tokens = nonNegativeInteger(usage.input_tokens);
  if (Number.isFinite(Number(usage.output_tokens))) target.output_tokens = nonNegativeInteger(usage.output_tokens);
}

function clonePreservedThinkingBlock(block) {
  if (block?.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: String(block.data || "") };
  }
  return {
    type: "thinking",
    thinking: String(block?.thinking || ""),
    signature: String(block?.signature || "")
  };
}

function savePreservedThinking(toolUseIds, blocks) {
  pruneThinkingCache();
  const safeBlocks = blocks.filter((block) => block?.type === "thinking" || block?.type === "redacted_thinking").map(clonePreservedThinkingBlock);
  if (!safeBlocks.length) return;
  const entry = { blocks: safeBlocks, expiresAt: Date.now() + THINKING_CACHE_TTL_MS };
  for (const id of toolUseIds) if (id) preservedThinkingByToolUseId.set(String(id), entry);
}

function takePreservedThinking(toolUseIds) {
  pruneThinkingCache();
  let entry = null;
  for (const id of toolUseIds) {
    const candidate = preservedThinkingByToolUseId.get(String(id));
    if (candidate) { entry = candidate; break; }
  }
  if (!entry) return [];
  for (const [id, candidate] of preservedThinkingByToolUseId.entries()) {
    if (candidate === entry) preservedThinkingByToolUseId.delete(id);
  }
  return entry.blocks.map(clonePreservedThinkingBlock);
}

function pruneThinkingCache() {
  const now = Date.now();
  for (const [id, entry] of preservedThinkingByToolUseId.entries()) {
    if (!entry || entry.expiresAt <= now) preservedThinkingByToolUseId.delete(id);
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function sanitizedErrorResponse(status) {
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  return new Response(JSON.stringify({ error: { type: "provider_error", message: "Provider request failed. BrowserCrew removed the raw provider error body." } }), {
    status: safeStatus,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function invalidProviderResponse() {
  return new Response(JSON.stringify({ error: { type: "provider_response_error", message: "Provider response could not be normalized." } }), {
    status: 502,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
