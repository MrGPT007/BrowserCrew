import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "anthropic-smoke");
const timeoutMs = 45_000;
const TEST_KEY = "bc_test_key_not_a_real_credential";
const PRIVATE_CANARY = "BC_PRIVATE_REASONING_TEST_CANARY";
const ERROR_CANARY = "BC_RAW_ANTHROPIC_ERROR_CANARY";
const VISIBLE = "TOOL_VISIBLE_CANARY_71ac9";
const FORBIDDEN = ["TOOL_PASSWORD_CANARY_9921", "TOOL_HIDDEN_CANARY_5512", "TOOL_SCRIPT_CANARY_7733"];

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const fixture = await startFixtureServer();
const provider = await startAnthropicFixture();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-anthropic-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, [fixture.origin, provider.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await configureAnthropic(panel, provider.origin);
  assert.equal(provider.wrongPathRequests, 0, "Anthropic must never receive BrowserCrew's internal /chat/completions path.");
  const setupRequest = provider.requests.find((item) => item.body.stream !== true);
  assert.ok(setupRequest, "Anthropic fixture should receive a connection-test Messages request.");
  assert.equal(setupRequest.path, "/v1/messages");
  assert.equal(setupRequest.headers.authorization, undefined, "Internal Bearer header must not reach Anthropic.");
  assert.equal(setupRequest.headers["x-api-key"], TEST_KEY);
  assert.equal(setupRequest.headers["anthropic-version"], "2023-06-01");
  assert.equal(setupRequest.body.model, "claude-sonnet-5");
  assert.equal(Object.hasOwn(setupRequest.body, "temperature"), false);
  pass("Connection test used native Anthropic Messages request shape and headers");

  const stored = await panel.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert.equal(JSON.stringify(stored.local).includes(TEST_KEY), false, "Anthropic test key must not enter durable local storage.");
  assert.equal(JSON.stringify(stored.session).includes(TEST_KEY), true, "Anthropic test key should remain available only in session storage.");
  assert.match(JSON.stringify(stored.local), /"kind":"anthropic"/);
  pass("Anthropic identity persisted while its key remained session-only");

  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#chatInput").fill("Anthropic streaming protocol test");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Anthropic streaming works.");
  const streamRequest = provider.requests.find((item) => item.body.stream === true && userText(item.body).includes("streaming protocol test"));
  assert.ok(streamRequest, "Chat should send a streaming Messages request through the Anthropic adapter.");
  pass("Chat consumed normalized Anthropic streaming text through the existing BrowserCrew stream contract");

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/chat-tool-page.html`);
  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#chatNewButton").click();
  await panel.waitForTimeout(150);
  await enablePageRead(panel, target);
  await panel.locator("#chatInput").fill("Use the page tool and tell me the shipping days.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Tuesdays and Fridays");
  assert.equal(provider.sawAnthropicToolSchema, true, "OpenAI-shaped internal tool schema must be converted to Anthropic input_schema.");
  assert.equal(provider.sawThinkingRoundTrip, true, "Private thinking blocks required for a tool result must be round-tripped ephemerally.");
  const afterTool = await panel.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(afterTool).includes(PRIVATE_CANARY), false, "Private Anthropic thinking must never be written to durable BrowserCrew state.");
  assert.equal((await panel.locator("body").innerText()).includes(PRIVATE_CANARY), false, "Private Anthropic thinking must never appear in the UI.");
  for (const canary of FORBIDDEN) assert.equal(JSON.stringify(afterTool).includes(canary), false, `Forbidden page canary became durable: ${canary}`);
  pass("Anthropic tool calls normalized into C3 without exposing hidden thinking or forbidden page data");

  await panel.locator("#chatNewButton").click();
  await panel.waitForTimeout(150);
  await panel.locator("#chatInput").fill("Anthropic cancellation protocol test");
  await panel.locator("#chatSendButton").click();
  await waitUntil(() => provider.requests.some((item) => item.body.stream === true && userText(item.body).includes("cancellation protocol test")), "Anthropic cancellation request did not reach fixture.");
  await panel.locator("#chatStopButton").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.evaluate(() => document.querySelector("#chatStopButton")?.click());
  await waitForText(panel.locator("#chatRunStatus"), "Stopped");
  await waitUntil(() => provider.abortedRequests >= 1, "AbortController cancellation did not close the Anthropic fixture request.");
  pass("Chat Stop propagated AbortController cancellation to the native Anthropic request");

  await panel.getByRole("tab", { name: "Connect AI" }).click();
  provider.mode = "unauthorized";
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "rejected the connection credentials");
  assert.equal((await panel.locator("#connectionResult").innerText()).includes(ERROR_CANARY), false);

  provider.mode = "limited";
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "temporarily limiting requests");
  assert.equal((await panel.locator("#connectionResult").innerText()).includes(ERROR_CANARY), false);

  provider.mode = "malformed";
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "HTTP 502");
  assert.equal((await panel.locator("#connectionResult").innerText()).includes(ERROR_CANARY), false);
  const afterErrors = await panel.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(afterErrors).includes(ERROR_CANARY), false, "Raw Anthropic provider errors must not become durable.");
  pass("401, 429, and malformed Anthropic responses stayed typed and raw-error-safe");

  provider.mode = "timeout";
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "did not answer within 30 seconds");
  provider.mode = "normal";
  pass("Anthropic connection timeout preserved the existing 30-second bounded failure path");

  await panel.screenshot({ path: join(artifactDir, "anthropic-v02-b04.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.provider = {
    totalRequests: provider.requests.length,
    wrongPathRequests: provider.wrongPathRequests,
    abortedRequests: provider.abortedRequests,
    sawAnthropicToolSchema: provider.sawAnthropicToolSchema,
    sawThinkingRoundTrip: provider.sawThinkingRoundTrip
  };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Anthropic installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await provider.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function configureAnthropic(panel, origin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /Anthropic API/ }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("radio", { name: /Anthropic API/ }).click();
  await panel.locator("#connectionNameInput").fill("Anthropic Fixture");
  await panel.locator("#modelInput").fill("claude-sonnet-5");
  await panel.locator("#serverInput").fill(`${origin}/v1`);
  await panel.locator("#apiKeyInput").fill(TEST_KEY);
  await panel.locator("#saveConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  await waitForText(panel.locator("#connectionList"), "Anthropic Fixture");
}

async function enablePageRead(panel, target) {
  await target.bringToFront();
  await panel.evaluate(() => {
    const checkbox = document.querySelector("#chatEnablePageReadTool");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForText(panel.locator("#chatToolGrantSummary"), "Allowed once");
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/chat-tool-page.html") { response.writeHead(404); response.end("Not found"); return; }
    const html = await readFile(join(repoRoot, "tests", "fixtures", "chat-tool-page.html"), "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  return listen(server);
}

async function startAnthropicFixture() {
  const state = {
    mode: "normal",
    requests: [],
    wrongPathRequests: 0,
    abortedRequests: 0,
    sawAnthropicToolSchema: false,
    sawThinkingRoundTrip: false
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      if (url.pathname.includes("chat/completions")) state.wrongPathRequests += 1;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }

    let aborted = false;
    response.on("close", () => {
      if (!response.writableEnded && !aborted) { aborted = true; state.abortedRequests += 1; }
    });

    const body = JSON.parse(await readBody(request));
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value]));
    state.requests.push({ path: url.pathname, body, headers });

    if (state.mode === "unauthorized") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: ERROR_CANARY } }));
      return;
    }
    if (state.mode === "limited") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: ERROR_CANARY } }));
      return;
    }
    if (state.mode === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`not-json-${ERROR_CANARY}`);
      return;
    }
    if (state.mode === "timeout") return;

    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg-connection",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "BrowserCrew connection works" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 4 }
      }));
      return;
    }

    const text = userText(body);
    if (/cancellation protocol test/i.test(text)) {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(packet({ type: "message_start", message: { id: "msg-cancel", model: body.model, usage: { input_tokens: 7, output_tokens: 0 } } }));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (response.destroyed || response.writableEnded) return;
      sendTextStream(response, body.model, "This text should have been cancelled.");
      return;
    }

    const tool = body.tools?.find((item) => item.name === "browsercrew_page_read");
    const toolResult = findToolResult(body);
    if (tool) {
      state.sawAnthropicToolSchema = Boolean(tool.input_schema && !tool.function);
      if (toolResult) {
        state.sawThinkingRoundTrip = body.messages.some((message) => message.role === "assistant" && message.content?.some((block) => block.type === "thinking" && block.thinking === PRIVATE_CANARY));
        assert.ok(String(toolResult.content || "").includes(VISIBLE), "Anthropic tool result should contain approved visible page text.");
        for (const canary of FORBIDDEN) assert.equal(String(toolResult.content || "").includes(canary), false, `Anthropic tool result leaked forbidden page canary: ${canary}`);
        sendTextStream(response, body.model, "I read the approved page: the warehouse ships on Tuesdays and Fridays.");
        return;
      }
      sendToolStream(response, body.model);
      return;
    }

    sendTextStream(response, body.model, "Anthropic streaming works.");
  });
  const bound = await listen(server);
  return {
    ...bound,
    get mode() { return state.mode; },
    set mode(value) { state.mode = value; },
    get requests() { return state.requests; },
    get wrongPathRequests() { return state.wrongPathRequests; },
    get abortedRequests() { return state.abortedRequests; },
    get sawAnthropicToolSchema() { return state.sawAnthropicToolSchema; },
    get sawThinkingRoundTrip() { return state.sawThinkingRoundTrip; }
  };
}

function sendTextStream(response, model, text) {
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  response.write(packet({ type: "message_start", message: { id: `msg-${Date.now()}`, model, usage: { input_tokens: 10, output_tokens: 0 } } }));
  response.write(packet({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  response.write(packet({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
  response.write(packet({ type: "content_block_stop", index: 0 }));
  response.write(packet({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }));
  response.write(packet({ type: "message_stop" }));
  response.end();
}

function sendToolStream(response, model) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  response.write(packet({ type: "message_start", message: { id: "msg-tool", model, usage: { input_tokens: 15, output_tokens: 0 } } }));
  response.write(packet({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
  response.write(packet({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: PRIVATE_CANARY } }));
  response.write(packet({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "test-signature" } }));
  response.write(packet({ type: "content_block_stop", index: 0 }));
  response.write(packet({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_page", name: "browsercrew_page_read", input: {} } }));
  response.write(packet({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }));
  response.write(packet({ type: "content_block_stop", index: 1 }));
  response.write(packet({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }));
  response.write(packet({ type: "message_stop" }));
  response.end();
}

function userText(body) {
  const user = [...(body.messages || [])].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("\n");
}

function findToolResult(body) {
  for (const message of body.messages || []) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const result = message.content.find((block) => block.type === "tool_result");
    if (result) return result;
  }
  return null;
}

function packet(value) {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function waitForText(locator, text) {
  await waitUntil(async () => (await locator.innerText().catch(() => "")).includes(text), `Timed out waiting for text: ${text}`);
}

async function waitUntil(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
