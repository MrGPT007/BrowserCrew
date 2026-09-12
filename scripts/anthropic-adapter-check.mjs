import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapterPath = resolve(repoRoot, "src", "provider-adapters.js");
const CONNECTIONS_KEY = "browsercrew.connections.v1";
const TEST_KEY = "bc_test_key_not_a_real_credential";
const BASE_URL = "http://127.0.0.1:43123/v1";
const MODEL = "claude-sonnet-5";
const PRIVATE_CANARY = "BC_PRIVATE_REASONING_TEST_CANARY";
const ERROR_CANARY = "BC_RAW_ERROR_TEST_CANARY";

let fixtureFetch = async () => { throw new Error("Provider fixture was not configured."); };
globalThis.fetch = (...args) => fixtureFetch(...args);
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({
        [CONNECTIONS_KEY]: [{ id: "anthropic-test", kind: "anthropic", model: MODEL, baseUrl: BASE_URL }]
      })
    }
  }
};

await import(`${pathToFileURL(adapterPath).href}?contract=${Date.now()}`);
const adapterFetch = globalThis.fetch;

await normalGeneration();
await streamingGeneration();
await toolRoundTrip();
await safeErrors();
await malformedResponse();
await cancellation();
console.log("BrowserCrew Anthropic adapter contract checks passed.");

async function normalGeneration() {
  fixtureFetch = async (url, init) => {
    assert.equal(url, `${BASE_URL}/messages`);
    checkHeaders(init.headers);
    const request = JSON.parse(init.body);
    assert.equal(request.model, MODEL);
    assert.equal(request.system, "System rule");
    assert.equal(request.stream, false);
    assert.equal(Object.hasOwn(request, "temperature"), false);
    assert.deepEqual(request.messages, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
    return json({ id: "msg-normal", model: MODEL, content: [{ type: "text", text: "Hello from Claude" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 4 } });
  };
  const response = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({
    model: MODEL,
    messages: [{ role: "system", content: "System rule" }, { role: "user", content: "Hello" }],
    temperature: 0.2,
    max_tokens: 1200,
    stream: false
  }));
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Hello from Claude");
  assert.deepEqual(body.usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
}

async function streamingGeneration() {
  fixtureFetch = async (_url, init) => {
    checkHeaders(init.headers);
    assert.equal(JSON.parse(init.body).stream, true);
    const body = [
      packet({ type: "message_start", message: { model: MODEL, usage: { input_tokens: 11, output_tokens: 0 } } }),
      packet({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      packet({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Streamed answer" } }),
      packet({ type: "content_block_stop", index: 0 }),
      packet({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      packet({ type: "message_stop" })
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const response = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({ model: MODEL, messages: [{ role: "user", content: "Stream" }], stream: true }));
  const text = await response.text();
  assert.match(text, /Streamed answer/);
  assert.match(text, /"prompt_tokens":11/);
  assert.match(text, /"completion_tokens":5/);
  assert.match(text, /data: \[DONE\]/);
}

async function toolRoundTrip() {
  let phase = 0;
  fixtureFetch = async (_url, init) => {
    phase += 1;
    const request = JSON.parse(init.body);
    if (phase === 1) {
      assert.equal(request.tools?.[0]?.name, "browsercrew_page_read");
      assert.deepEqual(request.tools?.[0]?.input_schema, { type: "object", properties: {}, additionalProperties: false });
      return json({
        id: "msg-tool",
        model: MODEL,
        content: [
          { type: "thinking", thinking: PRIVATE_CANARY, signature: "test-signature" },
          { type: "tool_use", id: "toolu_page", name: "browsercrew_page_read", input: {} }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 8 }
      });
    }
    const assistant = request.messages.find((message) => message.role === "assistant");
    const preserved = assistant?.content?.find((block) => block.type === "thinking");
    const result = request.messages.find((message) => message.role === "user" && message.content?.some((block) => block.type === "tool_result"));
    assert.equal(preserved?.thinking, PRIVATE_CANARY);
    assert.equal(preserved?.signature, "test-signature");
    assert.equal(result?.content?.[0]?.type, "tool_result");
    assert.equal(result?.content?.[0]?.tool_use_id, "toolu_page");
    return json({ id: "msg-final", model: MODEL, content: [{ type: "text", text: "Tool finished" }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 3 } });
  };

  const first = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({
    model: MODEL,
    messages: [{ role: "user", content: "Use the page tool" }],
    tools: [{ type: "function", function: { name: "browsercrew_page_read", description: "Read approved page", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    tool_choice: "auto"
  }));
  const normalized = await first.json();
  assert.equal(JSON.stringify(normalized).includes(PRIVATE_CANARY), false);
  assert.equal(normalized.choices[0].finish_reason, "tool_calls");
  assert.equal(normalized.choices[0].message.tool_calls[0].function.name, "browsercrew_page_read");

  const second = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({
    model: MODEL,
    messages: [
      { role: "user", content: "Use the page tool" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_page", type: "function", function: { name: "browsercrew_page_read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "toolu_page", content: "Visible page result" }
    ],
    tools: [{ type: "function", function: { name: "browsercrew_page_read", description: "Read approved page", parameters: { type: "object", properties: {}, additionalProperties: false } } }]
  }));
  assert.equal((await second.json()).choices[0].message.content, "Tool finished");
  assert.equal(phase, 2);
}

async function safeErrors() {
  fixtureFetch = async () => new Response(JSON.stringify({ error: { message: ERROR_CANARY } }), { status: 401 });
  const unauthorized = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({ model: MODEL, messages: [{ role: "user", content: "Auth" }] }));
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.text()).includes(ERROR_CANARY), false);

  fixtureFetch = async () => new Response(ERROR_CANARY, { status: 429 });
  const limited = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({ model: MODEL, messages: [{ role: "user", content: "Rate" }] }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.text()).includes(ERROR_CANARY), false);
}

async function malformedResponse() {
  fixtureFetch = async () => new Response("not-json", { status: 200 });
  const response = await adapterFetch(`${BASE_URL}/chat/completions`, requestInit({ model: MODEL, messages: [{ role: "user", content: "Malformed" }] }));
  assert.equal(response.status, 502);
}

async function cancellation() {
  fixtureFetch = async (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
  });
  const controller = new AbortController();
  const pending = adapterFetch(`${BASE_URL}/chat/completions`, requestInit({ model: MODEL, messages: [{ role: "user", content: "Cancel" }], stream: true }, controller.signal));
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
}

function requestInit(body, signal = undefined) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
    body: JSON.stringify(body),
    signal
  };
}

function checkHeaders(value) {
  const headers = new Headers(value);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-api-key"), TEST_KEY);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
}

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function packet(value) {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}
