const SETTINGS_KEY = "browsercrew.settings.v1";
const CONNECTIONS_KEY = "browsercrew.connections.v1";
const ANTHROPIC_VERSION = "2023-06-01";
const nativeProviderFetch = globalThis.fetch.bind(globalThis);

// BrowserCrew runtimes speak one internal OpenAI-like contract. This transport is the
// final network boundary: it leaves existing policy/tool/attachment wrappers intact,
// converts only Anthropic requests on the wire, and normalizes responses back.
globalThis.fetch = async (input, init = undefined) => {
  const prepared = await prepareAnthropicRequest(input, init);
  if (!prepared) return nativeProviderFetch(input, init);

  const response = await nativeProviderFetch(prepared.url, prepared.init);
  if (!response.ok) return response;
  return prepared.stream ? normalizeAnthropicStream(response, prepared.model) : normalizeAnthropicJsonResponse(response, prepared.model);
};

async function prepareAnthropicRequest(input, init) {
  if (!init || String(init.method || "GET").toUpperCase() !== "POST" || typeof init.body !== "string") return null;
  const urlText = requestUrl(input);
  if (!urlText) return null;
  let url;
  try { url = new URL(urlText); } catch { return null; }
  if (!url.pathname.endsWith("/chat/completions")) return null;

  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  if (!(await isAnthropicDestination(url))) return null;

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const bearer = String(headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  headers.delete("authorization");
  headers.delete("x-browsercrew-provider-kind");
  headers.set("content-type", "application/json");
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  if (bearer) headers.set("x-api-key", bearer);

  const anthropicBody = toAnthropicBody(body);
  const endpoint = new URL(url.href);
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions$/, "/messages");
  return {
    url: endpoint.href,
    model: String(body.model || ""),
    stream: body.stream === true,
    init: { ...init, headers, body: JSON.stringify(anthropicBody) }
  };
}

async function isAnthropicDestination(url) {
  if (url.hostname === "api.anthropic.com") return true;
  const requestedBase = url.href.replace(/\/chat\/completions(?:\?.*)?$/, "").replace(/\/$/, "");
  const stored = await chrome.storage.local.get([SETTINGS_KEY, CONNECTIONS_KEY]);
  const settings = stored[SETTINGS_KEY];
  if (settings?.kind === "anthropic" && normalizedBase(settings.baseUrl) === requestedBase) return true;
  const connections = Array.isArray(stored[CONNECTIONS_KEY]) ? stored[CONNECTIONS_KEY] : [];
  return connections.some((profile) => profile?.kind === "anthropic" && normalizedBase(profile.baseUrl) === requestedBase);
}

function toAnthropicBody(body) {
  const system = [];
  const messages = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "system") {
      const text = textContent(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message?.role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: String(message.tool_call_id || ""),
          content: textContent(message.content)
        }]
      });
      continue;
    }
    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const blocks = [];
      const text = textContent(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of message.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: String(call?.id || crypto.randomUUID()),
          name: String(call?.function?.name || ""),
          input: parseToolArguments(call?.function?.arguments)
        });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (["user", "assistant"].includes(message?.role)) {
      messages.push({ role: message.role, content: textContent(message.content) });
    }
  }

  const converted = {
    model: String(body.model || ""),
    max_tokens: positiveInteger(body.max_tokens, 1200),
    messages,
    stream: body.stream === true,
    // BrowserCrew never exposes hidden provider chain-of-thought. Keeping thinking
    // disabled also avoids signed hidden blocks entering the client-tool loop.
    thinking: { type: "disabled" }
  };
  if (system.length) converted.system = system.join("\n\n");
  if (Array.isArray(body.tools) && body.tools.length) {
    converted.tools = body.tools.map(openAiToolToAnthropic).filter(Boolean);
    if (converted.tools.length) {
      converted.tool_choice = body.tool_choice === "none"
        ? { type: "none" }
        : { type: "auto", disable_parallel_tool_use: true };
    }
  }
  return converted;
}

function openAiToolToAnthropic(tool) {
  const fn = tool?.type === "function" ? tool.function : null;
  if (!fn?.name) return null;
  return {
    name: String(fn.name),
    description: String(fn.description || ""),
    input_schema: fn.parameters && typeof fn.parameters === "object"
      ? fn.parameters
      : { type: "object", properties: {}, additionalProperties: false }
  };
}

async function normalizeAnthropicJsonResponse(response, fallbackModel) {
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch {
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const normalized = anthropicMessageToOpenAi(body, fallbackModel);
  return new Response(JSON.stringify(normalized), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "application/json" }
  });
}

function anthropicMessageToOpenAi(body, fallbackModel) {
  const content = Array.isArray(body?.content) ? body.content : [];
  const text = content.filter((block) => block?.type === "text").map((block) => String(block.text || "")).join("");
  const toolCalls = content.filter((block) => block?.type === "tool_use").map((block, index) => ({
    id: String(block.id || `tool-${index + 1}`),
    type: "function",
    function: { name: String(block.name || ""), arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}) }
  }));
  const message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: String(body?.id || ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(body?.model || fallbackModel || ""),
    choices: [{ index: 0, message, finish_reason: mapStopReason(body?.stop_reason) }],
    usage: normalizeUsage(body?.usage)
  };
}

function normalizeAnthropicStream(response, fallbackModel) {
  if (!response.body) return response;
  const upstream = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let model = fallbackModel || "";
  let inputTokens = 0;
  let outputTokens = 0;
  let doneSent = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { value, done } = await upstream.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            let event;
            try { event = JSON.parse(data); } catch { continue; }

            if (event.type === "error") throw new Error("The Anthropic stream ended with a provider error.");
            if (event.type === "message_start") {
              model = String(event.message?.model || model);
              inputTokens = Number(event.message?.usage?.input_tokens || 0);
              outputTokens = Number(event.message?.usage?.output_tokens || 0);
              emitOpenAi(controller, {
                model,
                choices: [{ index: 0, delta: {}, finish_reason: null }],
                usage: normalizeUsage({ input_tokens: inputTokens, output_tokens: outputTokens })
              });
              continue;
            }
            if (event.type === "content_block_start") {
              const block = event.content_block || {};
              if (block.type === "text" && block.text) {
                emitOpenAi(controller, { model, choices: [{ index: 0, delta: { content: String(block.text) }, finish_reason: null }] });
              } else if (block.type === "tool_use") {
                emitOpenAi(controller, {
                  model,
                  choices: [{ index: 0, delta: { tool_calls: [{ index: Number(event.index || 0), id: String(block.id || ""), type: "function", function: { name: String(block.name || ""), arguments: "" } }] }, finish_reason: null }]
                });
              }
              // thinking/redacted_thinking blocks are intentionally never normalized into BrowserCrew output.
              continue;
            }
            if (event.type === "content_block_delta") {
              const delta = event.delta || {};
              if (delta.type === "text_delta" && delta.text) {
                emitOpenAi(controller, { model, choices: [{ index: 0, delta: { content: String(delta.text) }, finish_reason: null }] });
              } else if (delta.type === "input_json_delta") {
                emitOpenAi(controller, {
                  model,
                  choices: [{ index: 0, delta: { tool_calls: [{ index: Number(event.index || 0), function: { arguments: String(delta.partial_json || "") } }] }, finish_reason: null }]
                });
              }
              continue;
            }
            if (event.type === "message_delta") {
              outputTokens = Number(event.usage?.output_tokens ?? outputTokens);
              emitOpenAi(controller, {
                model,
                choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(event.delta?.stop_reason) }],
                usage: normalizeUsage({ input_tokens: inputTokens, output_tokens: outputTokens })
              });
              continue;
            }
            if (event.type === "message_stop") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              doneSent = true;
            }
          }
        }
        if (!doneSent) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        controller.error(new Error("BrowserCrew could not safely read the Anthropic response stream."));
      }
    },
    cancel() { upstream.cancel().catch(() => {}); }
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }
  });
}

function emitOpenAi(controller, payload) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.input_tokens || 0);
  const completion = Number(usage.output_tokens || 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function mapStopReason(reason) {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (["end_turn", "stop_sequence", "refusal", "pause_turn"].includes(reason)) return "stop";
  return reason ? String(reason) : null;
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : String(value);
  return value.filter((block) => block?.type === "text" || typeof block === "string").map((block) => typeof block === "string" ? block : String(block.text || "")).join("\n");
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url || "";
}

function normalizedBase(value) {
  try { return new URL(String(value || "").replace(/\/$/, "")).href.replace(/\/$/, ""); }
  catch { return ""; }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
