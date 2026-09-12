import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "tools-smoke");
const timeoutMs = 35_000;
const VISIBLE = "TOOL_VISIBLE_CANARY_71ac9";
const FORBIDDEN = ["TOOL_PASSWORD_CANARY_9921", "TOOL_HIDDEN_CANARY_5512", "TOOL_SCRIPT_CANARY_7733"];

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const fixtureServer = await startFixtureServer();
const providerServer = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-tools-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, [fixtureServer.origin, providerServer.origin]);
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
  await configureLocalProvider(panel, providerServer.origin);

  const target = await context.newPage();
  await target.goto(`${fixtureServer.origin}/chat-tool-page.html`);
  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#chatEnablePageReadTool").waitFor({ state: "visible", timeout: timeoutMs });

  await enablePageRead(panel, target);
  pass("User explicitly granted one read of one exact tab for the next message");

  await panel.locator("#chatInput").fill("Use the page tool and tell me the shipping days.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Tuesdays and Fridays");
  await waitForText(panel.locator("#chatMessages"), "Page read result");

  const first = providerServer.requests.find((item) => item.stream && !item.hasToolResult && /shipping days/i.test(item.userText));
  assert.ok(first, "Provider should receive the initial Chat tool-decision request.");
  const tool = first.body.tools?.[0]?.function;
  assert.equal(tool?.name, "browsercrew_page_read");
  assert.deepEqual(tool?.parameters?.properties || {}, {}, "page.read schema must not let the model supply a URL or wider scope.");
  assert.equal(tool?.parameters?.additionalProperties, false);

  const second = providerServer.requests.find((item) => item.hasToolResult && item.toolText.includes(VISIBLE));
  assert.ok(second, "Provider should receive the externally executed page result.");
  for (const canary of FORBIDDEN) assert.equal(second.toolText.includes(canary), false, `Tool result leaked forbidden page canary: ${canary}`);
  assert.equal(providerServer.requests.filter((item) => item.hasToolResult).length, 1, "Exactly one tool-result model turn should follow the one-call grant.");
  pass("Model tool call executed outside the model with bounded visible text and no hidden/password/script canaries");

  const storageAfterRead = await panel.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert.equal(JSON.stringify(storageAfterRead.local).includes(VISIBLE), false, "Raw page-read text must not be persisted in durable local storage.");
  for (const canary of FORBIDDEN) assert.equal(JSON.stringify(storageAfterRead.local).includes(canary), false, "Forbidden canary must not be durable.");
  assert.equal(Boolean(storageAfterRead.session["browsercrew.chatPendingToolGrant.v1"]), false, "One-message tool grant must be consumed after Send.");
  const activityText = await panel.locator("#chatActivityList").innerText();
  for (const phrase of ["asked to read", "Allowed for this message only", "Page read finished", "exact approved tab"]) assert.match(activityText, new RegExp(phrase, "i"));
  pass("Tool authorization, execution, and verification were visible without persisting raw page text");

  await panel.locator("#chatNewButton").click();
  await panel.waitForTimeout(150);
  await enablePageRead(panel, target);
  const toolResultsBeforeBadArgs = providerServer.requests.filter((item) => item.hasToolResult).length;
  await panel.locator("#chatInput").fill("Unsafe arguments test: try to change the page URL.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "refused the tool request");
  assert.equal(providerServer.requests.filter((item) => item.hasToolResult).length, toolResultsBeforeBadArgs, "A tool call with model-supplied URL arguments must not execute.");
  pass("BrowserCrew refused model arguments that attempted to widen page.read scope");

  await panel.locator("#chatNewButton").click();
  await panel.waitForTimeout(150);
  await enablePageRead(panel, target);
  const toolResultsBeforeStop = providerServer.requests.filter((item) => item.hasToolResult).length;
  await panel.locator("#chatInput").fill("Stop before tool dispatch test.");
  await panel.locator("#chatSendButton").click();
  await panel.locator("#chatStopButton").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.evaluate(() => document.querySelector("#chatStopButton")?.click());
  await waitForText(panel.locator("#chatRunStatus"), "Stopped");
  await panel.waitForTimeout(1800);
  assert.equal(providerServer.requests.filter((item) => item.hasToolResult).length, toolResultsBeforeStop, "Stop must prevent a delayed model tool request from dispatching page.read.");
  pass("Stop prevented a delayed tool dispatch after cancellation was recorded");

  await panel.screenshot({ path: join(artifactDir, "chat-tools-c3.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew C3 tools installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixtureServer.close();
  await providerServer.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "artifacts"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function configureLocalProvider(panel, origin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#modelInput").fill("browsercrew-tools-smoke");
  await panel.locator("#serverInput").fill(`${origin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
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

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/chat-tool-page.html") { response.writeHead(404); response.end("Not found"); return; }
    const html = await readFile(join(repoRoot, "tests", "fixtures", "chat-tool-page.html"), "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
  });
  return listen(server);
}

async function startProviderServer() {
  const state = { requests: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "Not found" } })); return;
    }
    const body = JSON.parse(await readBody(request));
    const userText = [...(body.messages || [])].reverse().find((message) => message.role === "user")?.content || "";
    const toolMessage = [...(body.messages || [])].reverse().find((message) => message.role === "tool");
    state.requests.push({ body, stream: body.stream === true, userText: String(userText), hasToolResult: Boolean(toolMessage), toolText: String(toolMessage?.content || "") });

    if (!body.stream) {
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({ model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "BrowserCrew connection works" }, finish_reason: "stop" }] }));
      return;
    }
    if (toolMessage) { sendSseContent(response, body.model, "I read the approved page: the warehouse ships on Tuesdays and Fridays."); return; }
    if (/stop before tool dispatch/i.test(userText)) {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      if (response.destroyed) return;
      sendToolCall(response, body.model, "{}");
      return;
    }
    if (/unsafe arguments/i.test(userText)) { sendToolCall(response, body.model, JSON.stringify({ url: "https://example.invalid/other" })); return; }
    sendToolCall(response, body.model, "{}");
  });
  const bound = await listen(server);
  return { ...bound, get requests() { return state.requests; } };
}

function sendToolCall(response, model, args) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
  response.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function", function: { name: "browsercrew_page_read", arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendSseContent(response, model, content) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
  response.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}
