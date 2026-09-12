import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "c5-smoke");
const timeoutMs = 40_000;
const CHAT_CANARY = "C5_SAVED_CHAT_CANARY_71bf";
const report = { startedAt: new Date().toISOString(), checks: [] };

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const modelA = await startModelServer("A");
const modelB = await startModelServer("B");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-c5-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;

try {
  await prepareTestExtension(extensionDir, [modelA.origin, modelB.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedState(panel, modelA.origin, modelB.origin);
  await panel.reload();
  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#c5Card").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#chatConversationSelect").selectOption("chat-c5-fixture");
  await panel.locator("#c5Target").selectOption("conn-b");

  await panel.locator("#c5Instruction").fill("Compare the current recommendation and explain the most important trade-off.");
  await panel.locator("#c5ReviewButton").click();
  await panel.locator("#c5Review").waitFor({ state: "visible", timeout: timeoutMs });
  const reviewText = await panel.locator("#c5Review").innerText();
  assert.match(reviewText, /Local A/);
  assert.match(reviewText, /Local B/);
  assert.match(reviewText, /Maximum AI calls\s*2/i);
  assert.match(reviewText, /Maximum tool calls\s*0/i);
  assert.match(reviewText, /Maximum transfers\s*1/i);
  assert.equal(modelA.requests.length, 0, "Preview must not contact the current provider.");
  assert.equal(modelB.requests.length, 0, "Preview must not transfer context to the second provider.");
  pass("Cross-provider compare preview disclosed both destinations and transferred no context before approval");

  await panel.locator('#c5Review [data-c5-action="approve"]').click();
  await waitForText(panel.locator("#c5Results"), "Answer from A");
  await waitForText(panel.locator("#c5Results"), "Answer from B");
  assert.equal(modelA.requests.length, 1);
  assert.equal(modelB.requests.length, 1);
  assert.ok(JSON.stringify(modelA.requests[0].body).includes(CHAT_CANARY));
  assert.ok(JSON.stringify(modelB.requests[0].body).includes(CHAT_CANARY));
  const completedCompare = await latestRun(panel);
  assert.equal(completedCompare.status, "completed");
  assert.deepEqual(completedCompare.policy.budget.modelCalls, { max: 2, used: 2 });
  assert.deepEqual(completedCompare.policy.budget.toolCalls, { max: 0, used: 0 });
  assert.deepEqual(completedCompare.policy.budget.handoffs, { max: 1, used: 1 });
  pass("Approved compare used exactly two connected-model calls, zero tools, and one transfer budget");

  await panel.locator("#c5Mode").selectOption("specialist");
  await panel.locator("#c5Instruction").fill("Act as a security specialist and identify the highest-risk assumption.");
  await panel.locator("#c5ReviewButton").click();
  await panel.locator("#c5Review").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(modelA.requests.length, 1);
  assert.equal(modelB.requests.length, 1);
  await panel.locator('#c5Review [data-c5-action="approve"]').click();
  await waitUntil(() => modelB.requests.length === 2, 8_000, () => `A=${modelA.requests.length} B=${modelB.requests.length}`);
  assert.equal(modelA.requests.length, 1, "Specialist handoff must not silently call the current provider.");
  await waitForText(panel.locator("#c5Results"), "Answer from B");
  const specialist = await latestRun(panel);
  assert.equal(specialist.mode, "specialist");
  assert.equal(specialist.status, "completed");
  assert.deepEqual(specialist.policy.budget.modelCalls, { max: 1, used: 1 });
  assert.deepEqual(specialist.policy.budget.handoffs, { max: 1, used: 1 });
  pass("Specialist handoff contacted only the explicitly approved destination and stayed inside its one-call budget");

  const beforeBudgetA = modelA.requests.length;
  const beforeBudgetB = modelB.requests.length;
  const prepared = await c5Rpc(panel, "PREPARE_C5_RUN", {
    payload: {
      mode: "compare",
      targetConnectionId: "conn-b",
      conversationId: "chat-c5-fixture",
      instruction: "Budget test: compare once but do not exceed the declared one-model-call cap.",
      requestedBudgets: { modelCalls: 1, toolCalls: 0, handoffs: 1 }
    }
  });
  assert.equal(prepared.ok, true);
  assert.equal(modelA.requests.length, beforeBudgetA);
  assert.equal(modelB.requests.length, beforeBudgetB);
  const exhausted = await c5Rpc(panel, "APPROVE_C5_RUN", { runId: prepared.run.id });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.budgetExhausted, true);
  assert.equal(exhausted.run.status, "budget_exhausted");
  assert.equal(exhausted.run.policy.budget.modelCalls.max, 1);
  assert.equal(exhausted.run.policy.budget.modelCalls.used, 1);
  assert.equal(modelA.requests.length, beforeBudgetA + 1, "The first allowed model call should run.");
  assert.equal(modelB.requests.length, beforeBudgetB, "Budget exhaustion must block the second provider dispatch.");
  pass("Installed-extension budget exhaustion blocked an additional model dispatch before the second provider received context");

  const beforeStopA = modelA.requests.length;
  const beforeStopB = modelB.requests.length;
  await panel.locator("#c5Mode").selectOption("compare");
  await panel.locator("#c5Instruction").fill("STOP_AFTER_FIRST: compare these recommendations, but this fixture intentionally delays the first answer.");
  await panel.locator("#c5ReviewButton").click();
  await panel.locator("#c5Review").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator('#c5Review [data-c5-action="approve"]').click();
  await waitUntil(() => modelA.requests.length === beforeStopA + 1, 8_000, () => `A=${modelA.requests.length} B=${modelB.requests.length}`);
  await panel.locator("#c5StopButton").click();
  await waitUntilAsync(async () => (await latestRun(panel)).status === "stopped", 8_000, async () => JSON.stringify(await latestRun(panel)));
  assert.equal(modelB.requests.length, beforeStopB, "Stop must prevent the next provider dispatch.");
  pass("Stop aborted the active compare call and prevented the next model dispatch");

  const localDump = await panel.evaluate(async () => chrome.storage.local.get(null));
  const durable = JSON.stringify(localDump);
  assert.equal(/Bearer\s+/i.test(durable), false);
  assert.equal(durable.includes("browsercrew.connectionSecrets.v1"), false);
  assert.equal(durable.includes("hidden chain-of-thought"), false);
  const c5Runs = localDump["browsercrew.c5Runs.v1"] || [];
  assert.ok(c5Runs.every((run) => !JSON.stringify(run.activity || []).includes(CHAT_CANARY)), "C5 activity must remain redacted and must not copy raw chat context.");
  pass("Durable C5 policy/activity records stayed redacted and contained no credentials or raw transferred chat text");

  await panel.screenshot({ path: join(artifactDir, "c5-bounded-handoff.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew AGT-01 / C5 installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  report.servers = { aRequests: modelA.requests.length, bRequests: modelB.requests.length };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "c5-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await modelA.close();
  await modelB.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function seedState(panel, originA, originB) {
  const now = new Date().toISOString();
  await panel.evaluate(async ({ originA, originB, now, chatCanary }) => {
    const connections = [
      { id: "conn-a", schemaVersion: 1, name: "Local A", kind: "lmstudio", model: "model-a", baseUrl: `${originA}/v1`, status: "connected", lastTestedAt: now, createdAt: now, updatedAt: now },
      { id: "conn-b", schemaVersion: 1, name: "Local B", kind: "lmstudio", model: "model-b", baseUrl: `${originB}/v1`, status: "connected", lastTestedAt: now, createdAt: now, updatedAt: now }
    ];
    const conversation = {
      id: "chat-c5-fixture", schemaVersion: 1, title: "C5 fixture", createdAt: now, updatedAt: now, status: "idle",
      providerRef: { kind: "lmstudio", model: "model-a", baseUrl: `${originA}/v1` },
      messages: [
        { id: "u1", role: "user", text: `We are choosing a launch plan. ${chatCanary}`, createdAt: now, context: { pageIncluded: false } },
        { id: "a1", role: "assistant", text: "Prioritize the reversible launch option and verify the riskiest assumption first.", createdAt: now, model: "model-a", provider: "lmstudio" }
      ],
      activity: []
    };
    await chrome.storage.local.set({
      "browsercrew.connections.v1": connections,
      "browsercrew.activeConnection.v1": "conn-a",
      "browsercrew.settings.v1": { kind: "lmstudio", model: "model-a", baseUrl: `${originA}/v1` },
      "browsercrew.conversations.v1": [conversation],
      "browsercrew.c5Runs.v1": []
    });
    await chrome.storage.session.set({ "browsercrew.connectionSecrets.v1": {} });
  }, { originA, originB, now, chatCanary: CHAT_CANARY });
}

async function latestRun(panel) {
  return panel.evaluate(async () => {
    const stored = await chrome.storage.local.get("browsercrew.c5Runs.v1");
    return stored["browsercrew.c5Runs.v1"]?.[0] || null;
  });
}

async function c5Rpc(panel, type, payload = {}) {
  return panel.evaluate(({ type, payload }) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "browsercrew-chat-c5" });
    const requestId = `smoke-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error(`Timed out waiting for ${type}`)); }, 70000);
    port.onMessage.addListener((message) => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
      resolve(message);
    });
    port.postMessage({ type, requestId, ...payload });
  }), { type, payload });
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "artifacts", "node_modules"].includes(relative.split(/[/\\]/)[0]);
  }});
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startModelServer(label) {
  const state = { requests: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(await readBody(req));
    state.requests.push({ body, at: new Date().toISOString() });
    const combined = (body.messages || []).map((item) => String(item.content || "")).join("\n");
    if (label === "A" && combined.includes("STOP_AFTER_FIRST")) await new Promise((resolve) => setTimeout(resolve, 5000));
    const content = label === "A"
      ? "Answer from A: choose the reversible launch and measure the risky assumption."
      : "Answer from B: narrow the launch scope and predefine a rollback trigger.";
    json(res, { model: `model-${label.toLowerCase()}`, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
  });
  const bound = await listen(server);
  return { ...bound, get requests() { return state.requests; } };
}

function json(res, payload, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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

async function waitForText(locator, text, ms = timeoutMs) {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = await locator.innerText().catch(() => "");
    if (last.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}; last text: ${last}`);
}

async function waitUntil(predicate, ms, details) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for condition. ${details()}`);
}

async function waitUntilAsync(predicate, ms, details) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for condition. ${await details()}`);
}
