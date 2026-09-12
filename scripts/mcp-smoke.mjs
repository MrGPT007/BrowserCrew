import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "mcp-smoke");
const timeoutMs = 40_000;
const MCP_SECRET = "MCP_BEARER_CANARY_239ab7";
const MCP_RESULT = "MCP_READ_RESULT_CANARY_904c1";

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const modelServer = await startModelServer();
const mcpServer = await startMcpServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-mcp-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, [modelServer.origin, mcpServer.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await configureModel(panel, modelServer.origin);

  await panel.getByRole("tab", { name: "Tools" }).click();
  await panel.locator("#mcpManagerCard").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#mcpServerName").fill("Inventory MCP");
  await panel.locator("#mcpServerEndpoint").fill(`${mcpServer.origin}/mcp`);
  await panel.locator("#mcpServerSecret").fill(MCP_SECRET);
  await panel.locator("#mcpSaveTestButton").click();
  await waitForText(panel.locator("#mcpConnectionResult"), "Found 2 tools");
  await waitForText(panel.locator("#mcpServerList"), "lookup_inventory");
  pass("Connected to a stateless MCP 2026-07-28 server and discovered two tools");

  assert.ok(mcpServer.methods.includes("server/discover"));
  assert.ok(mcpServer.methods.includes("tools/list"));
  for (const request of mcpServer.requests) {
    assert.equal(request.protocol, "2026-07-28");
    assert.equal(request.authorization, `Bearer ${MCP_SECRET}`);
    assert.equal(request.mcpMethod, request.method);
  }
  const storageAfterConnect = await panel.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert.equal(JSON.stringify(storageAfterConnect.local).includes(MCP_SECRET), false);
  assert.equal(JSON.stringify(storageAfterConnect.session).includes(MCP_SECRET), true);
  pass("MCP bearer authentication stayed session-only and modern routing headers matched each JSON-RPC method");

  await classifyAndEnable(panel, "lookup_inventory", "read");
  await classifyAndEnable(panel, "set_priority", "write");
  const readEnabled = panel.locator('input[data-mcp-enabled][data-tool-name="lookup_inventory"]');
  await readEnabled.uncheck();
  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#mcpChatToolSelect").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await optionExists(panel, /Lookup inventory/i), false, "Disabled MCP tool must disappear from Chat choices.");
  await panel.getByRole("tab", { name: "Tools" }).click();
  await panel.locator('input[data-mcp-enabled][data-tool-name="lookup_inventory"]').check();
  pass("Per-tool enablement controls whether a discovered MCP tool is available to Chat");

  await panel.getByRole("tab", { name: "Chat" }).click();
  await chooseMcpTool(panel, /Lookup inventory/i);
  await panel.locator("#chatInput").fill("Use the external inventory tool to check SKU-42.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "12 units are available");
  assert.equal(mcpServer.readCalls, 1);
  const readCall = mcpServer.requests.find((item) => item.method === "tools/call" && item.name === "lookup_inventory");
  assert.ok(readCall);
  assert.equal(readCall.mcpName, "lookup_inventory");
  const modelToolTurn = modelServer.requests.find((item) => item.toolText.includes(MCP_RESULT));
  assert.ok(modelToolTurn);
  const afterRead = await panel.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(afterRead).includes(MCP_RESULT), false);
  pass("Read-only MCP invocation ran once, returned to the selected model, and kept raw result text out of durable storage");

  await newChat(panel);
  await chooseMcpTool(panel, /Set priority/i);
  await panel.locator("#chatInput").fill("Use the external tool to set SKU-42 priority to urgent.");
  await panel.locator("#chatSendButton").click();
  await panel.locator("#mcpWriteApproval").waitFor({ state: "visible", timeout: timeoutMs });
  await waitForText(panel.locator("#mcpWriteApproval"), "Approve this change");
  assert.equal(mcpServer.writeCalls, 0);
  const approvalText = await panel.locator("#mcpWriteApproval").innerText();
  assert.match(approvalText, /SKU-42/);
  assert.match(approvalText, /urgent/i);
  const preApprovalStorage = await panel.evaluate(async () => chrome.storage.local.get("browsercrew.mcpActions.v1"));
  const awaiting = preApprovalStorage["browsercrew.mcpActions.v1"]?.find((item) => item.status === "awaiting_approval");
  assert.ok(awaiting?.argumentDigest);
  assert.equal(JSON.stringify(awaiting).includes("SKU-42"), false);
  pass("Write-capable MCP invocation stopped at a visible argument review before any external mutation");

  await panel.evaluate(() => document.querySelector('[data-mcp-write-action="approve"]')?.click());
  await waitUntil(() => mcpServer.writeCalls === 1, 6_000, async () => `writeCalls=${mcpServer.writeCalls}; ${await diagnosticState(panel)}`);
  pass("Approved write reached the exact MCP server once");
  await waitUntilAsync(async () => {
    const stored = await panel.evaluate(async () => chrome.storage.local.get("browsercrew.mcpActions.v1"));
    return stored["browsercrew.mcpActions.v1"]?.some((item) => item.id === awaiting.id && item.status === "completed");
  }, 6_000, async () => diagnosticState(panel));
  const completedStorage = await panel.evaluate(async () => chrome.storage.local.get("browsercrew.mcpActions.v1"));
  const completed = completedStorage["browsercrew.mcpActions.v1"]?.find((item) => item.id === awaiting.id);
  assert.equal(completed?.checkpoint, "mcp_write_completed");
  await waitForText(panel.locator("#mcpWriteResult"), "Priority updated", 6_000);
  pass("Approved MCP write persisted intent, completed exactly once, and rendered its receipt");

  await newChat(panel);
  await chooseMcpTool(panel, /Set priority/i);
  await panel.locator("#chatInput").fill("Use the external tool to set SKU-99 priority to high. This is the recovery test.");
  await panel.locator("#chatSendButton").click();
  await panel.locator("#mcpWriteApproval").waitFor({ state: "visible", timeout: timeoutMs });
  const writeStarted = withTimeout(mcpServer.waitForCrashWrite(), 10_000, "Timed out waiting for the crash-test MCP write to reach the server.");
  await panel.evaluate(() => document.querySelector('[data-mcp-write-action="approve"]')?.click());
  await writeStarted;
  assert.equal(mcpServer.writeCalls, 2);

  const cdp = await panel.context().newCDPSession(panel);
  const targets = await cdp.send("Target.getTargets");
  const swTarget = targets.targetInfos.find((info) => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
  assert.ok(swTarget?.targetId);
  await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
  await cdp.detach();
  await panel.waitForTimeout(300);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
  let recovered;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const stored = await panel.evaluate(async () => chrome.storage.local.get("browsercrew.mcpActions.v1"));
    recovered = stored["browsercrew.mcpActions.v1"]?.find((item) => item.toolName === "set_priority" && item.status === "outcome_unknown");
    if (recovered) break;
    await panel.waitForTimeout(150);
  }
  assert.ok(recovered, "Interrupted MCP write should reconcile to outcome_unknown.");
  assert.equal(recovered.checkpoint, "mcp_write_outcome_unknown");
  await panel.waitForTimeout(1200);
  assert.equal(mcpServer.writeCalls, 2, "Recovery must never replay an uncertain MCP write.");
  pass("Service-worker recovery marked an uncertain external write outcome unknown and did not replay it");

  await panel.screenshot({ path: join(artifactDir, "mcp-c4.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew C4 MCP installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  if (context) {
    const pages = context.pages();
    const panel = pages.find((page) => page.url().includes("sidepanel.html"));
    if (panel) {
      report.diagnostic = await diagnosticState(panel).catch(() => "unavailable");
      await panel.screenshot({ path: join(artifactDir, "mcp-c4-failure.png"), fullPage: true }).catch(() => {});
    }
  }
  report.server = { readCalls: mcpServer.readCalls, writeCalls: mcpServer.writeCalls, methods: mcpServer.methods, requests: mcpServer.requests.map((item) => ({ method: item.method, name: item.name, protocol: item.protocol, mcpMethod: item.mcpMethod, mcpName: item.mcpName })) };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await modelServer.close();
  await mcpServer.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function diagnosticState(panel) {
  return panel.evaluate(async () => {
    const actions = await chrome.storage.local.get("browsercrew.mcpActions.v1");
    return JSON.stringify({
      result: document.querySelector("#mcpWriteResult")?.innerText || "",
      approval: document.querySelector("#mcpWriteApproval")?.innerText || "",
      toast: document.querySelector("#toast")?.innerText || "",
      actions: actions["browsercrew.mcpActions.v1"] || []
    });
  });
}

async function waitUntil(predicate, ms, details) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for condition. ${await details()}`);
}

async function waitUntilAsync(predicate, ms, details) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for condition. ${await details()}`);
}

async function newChat(panel) {
  await panel.locator("#chatNewButton").click();
  await panel.waitForTimeout(180);
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "artifacts"].includes(relative.split(/[/\\]/)[0]);
  }});
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function configureModel(panel, origin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#modelInput").fill("browsercrew-mcp-smoke");
  await panel.locator("#serverInput").fill(`${origin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
}

async function classifyAndEnable(panel, toolName, classification) {
  const policy = panel.locator(`select[data-mcp-policy][data-tool-name="${toolName}"]`);
  await policy.waitFor({ state: "visible", timeout: timeoutMs });
  await policy.selectOption(classification);
  await panel.waitForTimeout(120);
  const checkbox = panel.locator(`input[data-mcp-enabled][data-tool-name="${toolName}"]`);
  await checkbox.waitFor({ state: "visible", timeout: timeoutMs });
  await checkbox.check();
  await panel.waitForTimeout(120);
}

async function chooseMcpTool(panel, pattern) {
  const select = panel.locator("#mcpChatToolSelect");
  await select.waitFor({ state: "visible", timeout: timeoutMs });
  let value = null;
  for (const option of await select.locator("option").all()) {
    if (pattern.test(await option.innerText())) { value = await option.getAttribute("value"); break; }
  }
  assert.ok(value, `Could not find MCP Chat option matching ${pattern}`);
  await select.selectOption(value);
  await panel.locator("#mcpChatSelection").waitFor({ state: "visible", timeout: timeoutMs });
}

async function optionExists(panel, pattern) {
  for (const option of await panel.locator("#mcpChatToolSelect option").all()) if (pattern.test(await option.innerText())) return true;
  return false;
}

async function startModelServer() {
  const state = { requests: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(await readBody(req));
    const toolMessage = [...(body.messages || [])].reverse().find((m) => m.role === "tool");
    const userText = String([...(body.messages || [])].reverse().find((m) => m.role === "user")?.content || "");
    state.requests.push({ body, toolText: String(toolMessage?.content || ""), userText });
    if (!body.stream) { json(res, { model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "BrowserCrew connection works" }, finish_reason: "stop" }] }); return; }
    if (toolMessage) { sseText(res, body.model, /inventory/i.test(userText) ? "Inventory says 12 units are available." : "External tool result received."); return; }
    const alias = body.tools?.[0]?.function?.name;
    if (!alias) { sseText(res, body.model, "No external tool was enabled."); return; }
    if (/SKU-99/i.test(userText)) { sseTool(res, body.model, alias, { sku: "SKU-99", priority: "high" }); return; }
    if (/priority/i.test(userText)) { sseTool(res, body.model, alias, { sku: "SKU-42", priority: "urgent" }); return; }
    sseTool(res, body.model, alias, { sku: "SKU-42" });
  });
  const bound = await listen(server);
  return { ...bound, get requests() { return state.requests; } };
}

async function startMcpServer() {
  const state = { requests: [], methods: [], readCalls: 0, writeCalls: 0, crashWaiters: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/mcp") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(await readBody(req));
    const record = { method: body.method, name: body.params?.name || null, protocol: req.headers["mcp-protocol-version"], mcpMethod: req.headers["mcp-method"], mcpName: req.headers["mcp-name"] || null, authorization: req.headers.authorization || null, body };
    state.requests.push(record); state.methods.push(body.method);
    if (record.protocol !== "2026-07-28" || record.mcpMethod !== body.method || record.authorization !== `Bearer ${MCP_SECRET}`) { json(res, { jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "Header mismatch" } }, 400); return; }
    if (body.method === "server/discover") { json(res, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "BrowserCrew MCP Fixture", version: "1.0.0" } } }); return; }
    if (body.method === "tools/list") { json(res, { jsonrpc: "2.0", id: body.id, result: { tools: [
      { name: "lookup_inventory", title: "Lookup inventory", description: "Read the current inventory count for a SKU.", inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false } },
      { name: "set_priority", title: "Set priority", description: "Change the priority assigned to a SKU.", inputSchema: { type: "object", properties: { sku: { type: "string" }, priority: { type: "string" } }, required: ["sku", "priority"], additionalProperties: false } }
    ] } }); return; }
    if (body.method === "tools/call") {
      if (record.mcpName !== body.params?.name) { json(res, { jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "Name header mismatch" } }, 400); return; }
      if (body.params.name === "lookup_inventory") { state.readCalls += 1; json(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `${MCP_RESULT}: ${body.params.arguments?.sku} has 12 units.` }], isError: false } }); return; }
      if (body.params.name === "set_priority") {
        state.writeCalls += 1;
        const args = body.params.arguments || {};
        if (args.sku === "SKU-99") { for (const resolve of state.crashWaiters.splice(0)) resolve(); await new Promise((resolve) => setTimeout(resolve, 5000)); }
        json(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `Priority updated for ${args.sku} to ${args.priority}.` }], isError: false } });
        return;
      }
    }
    json(res, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  });
  const bound = await listen(server);
  return { ...bound, get requests() { return state.requests; }, get methods() { return state.methods; }, get readCalls() { return state.readCalls; }, get writeCalls() { return state.writeCalls; }, waitForCrashWrite() { return new Promise((resolve) => state.crashWaiters.push(resolve)); } };
}

function json(res, payload, status = 200) { res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(payload)); }
function sseTool(res, model, name, args) { res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" }); res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`); res.write("data: [DONE]\n\n"); res.end(); }
function sseText(res, model, content) { res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" }); res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`); res.write("data: [DONE]\n\n"); res.end(); }
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); req.on("error", reject); }); }
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); resolve({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) }); }); }); }
async function waitForText(locator, text, ms = timeoutMs) { const deadline = Date.now() + ms; let value = ""; while (Date.now() < deadline) { value = await locator.innerText().catch(() => ""); if (value.includes(text)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out waiting for text: ${text}; last text: ${value}`); }
function withTimeout(promise, ms, message) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]); }
