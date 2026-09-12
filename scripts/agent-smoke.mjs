import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "agent-smoke");
const timeoutMs = 45_000;
const PRIVATE_CHAT_CANARY = "PRIVATE_CHAT_CANARY_C5_77a19";
const SECRET_A = "C5_SECRET_A_92ca";
const SECRET_B = "C5_SECRET_B_31bd";
const PRIMARY_OUTPUT_CANARY = "PRIMARY_OUTPUT_CANARY_C5";

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const modelServer = await startModelServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-agent-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, modelServer.origin);
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
  await seedConnections(panel, modelServer.origin);

  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#agentCompareCard").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntilAsync(async () => (await panel.locator("#agentPrimaryConnection option").count()) >= 2, 6000, "two connected AI profiles did not appear");
  pass("C5 loaded two connected AI profiles from the existing named-connection registry");

  await panel.keyboard.press("Control+K");
  await panel.locator("#commandPalette").waitFor({ state: "visible", timeout: 3000 });
  await panel.locator("#commandSearch").fill("compare");
  await panel.keyboard.press("Enter");
  await panel.locator("#agentPrompt").waitFor({ state: "visible", timeout: 3000 });
  assert.equal(await panel.locator("#agentPrompt").evaluate((el) => el === document.activeElement), true);
  pass("Ctrl+K exposes the multi-model compare command for power users");

  await panel.locator("#agentMode").selectOption("specialist");
  await selectConnection(panel, "#agentPrimaryConnection", "conn-a");
  await selectConnection(panel, "#agentSecondaryConnection", "conn-b");
  const approvedPrompt = "APPROVED_SPECIALIST_TEST: choose the safer deployment plan.";
  await panel.locator("#agentPrompt").fill(approvedPrompt);
  await panel.locator("#agentReviewButton").click();
  await panel.locator("#agentReviewDialog").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(modelServer.totalCalls, 0, "No model request may leave before explicit review approval.");
  await waitForText(panel.locator("#agentReviewDialog"), "2 model calls maximum");
  await waitForText(panel.locator("#agentReviewDialog"), "0 tool calls");
  await waitForText(panel.locator("#agentReviewDialog"), "1 cross-model handoff maximum");
  await waitForText(panel.locator("#agentReviewDialog"), "Primary Local");
  await waitForText(panel.locator("#agentReviewDialog"), "Reviewer Local");
  pass("Cross-provider context stayed blocked without approval and the review disclosed destinations plus hard budgets");

  await panel.locator("#agentApproveRunButton").click();
  await waitUntil(() => modelServer.callsA === 1 && modelServer.callsB === 1, 8000, () => `callsA=${modelServer.callsA}, callsB=${modelServer.callsB}`);
  await waitForText(panel.locator("#agentStatus"), "Completed inside limits", 8000);
  await waitForText(panel.locator("#agentPrimaryResult"), PRIMARY_OUTPUT_CANARY, 8000);
  await waitForText(panel.locator("#agentSecondaryResult"), "SPECIALIST_REVIEW_COMPLETE", 8000);

  const firstB = modelServer.requests.find((item) => item.route === "b" && item.text.includes(approvedPrompt));
  assert.ok(firstB, "The reviewed second destination should receive the approved specialist handoff.");
  assert.match(firstB.text, new RegExp(PRIMARY_OUTPUT_CANARY));
  for (const request of modelServer.requests) {
    assert.equal(request.text.includes(PRIVATE_CHAT_CANARY), false, "Current-chat private context must not cross into C5 requests.");
  }
  assert.equal(modelServer.requests.find((item) => item.route === "a")?.authorization, `Bearer ${SECRET_A}`);
  assert.equal(firstB.authorization, `Bearer ${SECRET_B}`);
  pass("Specialist handoff sent only the approved question plus bounded first answer and stayed within 2 model calls / 0 tools / 1 handoff");

  const durableAfterApproved = await panel.evaluate(async () => chrome.storage.local.get("browsercrew.agentRuns.v1"));
  assert.equal(JSON.stringify(durableAfterApproved).includes(SECRET_A), false);
  assert.equal(JSON.stringify(durableAfterApproved).includes(SECRET_B), false);
  assert.equal(JSON.stringify(durableAfterApproved).includes(PRIVATE_CHAT_CANARY), false);
  pass("Durable multi-model activity stayed redacted and excluded credentials and unrelated Chat context");

  const beforeNoApproval = modelServer.totalCalls;
  await agentRpc(panel, "PREVIEW_AGENT_RUN", {
    payload: {
      mode: "compare",
      prompt: "NO_APPROVAL_TEST",
      primaryId: "conn-a",
      secondaryId: "conn-b",
      budgets: { modelCalls: 2, toolCalls: 0, handoffs: 1 }
    }
  });
  await panel.waitForTimeout(300);
  assert.equal(modelServer.totalCalls, beforeNoApproval);
  pass("Preview alone never dispatched a provider request");

  const budgetPreview = await agentRpc(panel, "PREVIEW_AGENT_RUN", {
    payload: {
      mode: "specialist",
      prompt: "BUDGET_EXHAUSTION_TEST",
      primaryId: "conn-a",
      secondaryId: "conn-b",
      budgets: { modelCalls: 1, toolCalls: 0, handoffs: 1 }
    }
  });
  const budgetStart = await agentRpc(panel, "START_AGENT_RUN", {
    approvalId: budgetPreview.preview.approvalId,
    planDigest: budgetPreview.preview.planDigest
  });
  const callsBBeforeBudget = modelServer.callsB;
  const budgetRun = await waitForRun(panel, budgetStart.run.id, "budget_exhausted", 8000);
  assert.equal(budgetRun.usage.modelCalls, 1);
  assert.equal(budgetRun.usage.toolCalls, 0);
  assert.equal(budgetRun.usage.handoffs, 0);
  assert.equal(modelServer.callsB, callsBBeforeBudget, "Budget exhaustion must stop the second provider dispatch.");
  pass("Model-call budget exhaustion stopped further dispatch before the second AI");

  const stopPreview = await agentRpc(panel, "PREVIEW_AGENT_RUN", {
    payload: {
      mode: "specialist",
      prompt: "STOP_TEST",
      primaryId: "conn-a",
      secondaryId: "conn-b",
      budgets: { modelCalls: 2, toolCalls: 0, handoffs: 1 }
    }
  });
  const stopStart = await agentRpc(panel, "START_AGENT_RUN", {
    approvalId: stopPreview.preview.approvalId,
    planDigest: stopPreview.preview.planDigest
  });
  await waitUntil(() => modelServer.requests.some((item) => item.route === "a" && item.text.includes("STOP_TEST")), 5000, () => "primary STOP_TEST request never arrived");
  const bBeforeStop = modelServer.callsB;
  await agentRpc(panel, "STOP_AGENT_RUN", { runId: stopStart.run.id });
  const stoppedRun = await waitForRun(panel, stopStart.run.id, "stopped", 8000);
  assert.equal(stoppedRun.status, "stopped");
  await panel.waitForTimeout(2300);
  assert.equal(modelServer.callsB, bBeforeStop, "Stop prevented a second-model dispatch after cancellation was recorded.");
  pass("Stop prevented every new model/handoff dispatch after cancellation was recorded");

  const recoveryPreview = await agentRpc(panel, "PREVIEW_AGENT_RUN", {
    payload: {
      mode: "specialist",
      prompt: "RECOVERY_TEST",
      primaryId: "conn-a",
      secondaryId: "conn-b",
      budgets: { modelCalls: 2, toolCalls: 0, handoffs: 1 }
    }
  });
  const recoveryStart = await agentRpc(panel, "START_AGENT_RUN", {
    approvalId: recoveryPreview.preview.approvalId,
    planDigest: recoveryPreview.preview.planDigest
  });
  await waitUntil(() => modelServer.requests.some((item) => item.route === "a" && item.text.includes("RECOVERY_TEST")), 5000, () => "primary RECOVERY_TEST request never arrived");
  const bBeforeRecovery = modelServer.callsB;

  const cdp = await panel.context().newCDPSession(panel);
  const targets = await cdp.send("Target.getTargets");
  const swTarget = targets.targetInfos.find((info) => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
  assert.ok(swTarget?.targetId);
  await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
  await cdp.detach();
  await panel.waitForTimeout(350);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
  const recovered = await waitForRun(panel, recoveryStart.run.id, "interrupted", 8000);
  assert.equal(recovered.checkpoint, "interrupted_no_replay");
  await panel.waitForTimeout(1200);
  assert.equal(modelServer.callsB, bBeforeRecovery, "Interrupted C5 work must never replay or continue into a second provider automatically.");
  pass("Interrupted multi-model work reconciled to a safe no-replay checkpoint");

  await panel.screenshot({ path: join(artifactDir, "agent-c5.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.server = { callsA: modelServer.callsA, callsB: modelServer.callsB, totalCalls: modelServer.totalCalls };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew AGT-01 / C5 installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  report.server = {
    callsA: modelServer.callsA,
    callsB: modelServer.callsB,
    requests: modelServer.requests.map((item) => ({ route: item.route, text: item.text.slice(0, 500) }))
  };
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "agent-c5-failure.png"), fullPage: true }).catch(() => {});
  }
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await modelServer.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) {
  report.checks.push({ name, at: new Date().toISOString() });
}

async function seedConnections(panel, origin) {
  const now = new Date().toISOString();
  const connections = [
    {
      id: "conn-a", schemaVersion: 1, name: "Primary Local", kind: "lmstudio",
      model: "model-a", baseUrl: `${origin}/a/v1`, status: "connected",
      lastTestedAt: now, createdAt: now, updatedAt: now
    },
    {
      id: "conn-b", schemaVersion: 1, name: "Reviewer Local", kind: "lmstudio",
      model: "model-b", baseUrl: `${origin}/b/v1`, status: "connected",
      lastTestedAt: now, createdAt: now, updatedAt: now
    }
  ];
  await panel.evaluate(async ({ connections, secretA, secretB, privateCanary, origin }) => {
    await chrome.storage.local.set({
      "browsercrew.connections.v1": connections,
      "browsercrew.activeConnection.v1": "conn-a",
      "browsercrew.settings.v1": { kind: "lmstudio", model: "model-a", baseUrl: `${origin}/a/v1` },
      "browsercrew.conversations.v1": [{
        id: "private-chat", schemaVersion: 1, title: "Private chat", status: "idle",
        providerRef: { kind: "lmstudio", model: "model-a", baseUrl: `${origin}/a/v1` },
        messages: [{ id: "private-message", role: "user", text: privateCanary, createdAt: new Date().toISOString() }],
        activity: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }]
    });
    await chrome.storage.session.set({
      "browsercrew.connectionSecrets.v1": { "conn-a": secretA, "conn-b": secretB },
      "browsercrew.providerSecret.v1": secretA
    });
  }, { connections, secretA: SECRET_A, secretB: SECRET_B, privateCanary: PRIVATE_CHAT_CANARY, origin });
}

async function selectConnection(panel, selector, value) {
  const select = panel.locator(selector);
  await select.waitFor({ state: "visible", timeout: timeoutMs });
  await select.selectOption(value);
}

async function agentRpc(panel, type, extra = {}) {
  return panel.evaluate(({ type, extra }) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "browsercrew-agent" });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      try { port.disconnect(); } catch {}
      reject(new Error(`Timed out waiting for ${type}`));
    }, 12000);
    port.onMessage.addListener((message) => {
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
      if (message.ok === false) reject(new Error(message.error?.message || `${type} failed`));
      else resolve(message);
    });
    port.postMessage({ type, requestId, ...extra });
  }), { type, extra });
}

async function waitForRun(panel, runId, status, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await panel.evaluate(async (id) => {
      const stored = await chrome.storage.local.get("browsercrew.agentRuns.v1");
      return (stored["browsercrew.agentRuns.v1"] || []).find((run) => run.id === id) || null;
    }, runId);
    if (last?.status === status) return last;
    await panel.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${status}; last=${JSON.stringify(last)}`);
}

async function prepareTestExtension(target, origin) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      return ![".git", "artifacts", "node_modules"].includes(relative.split(/[/\\]/)[0]);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startModelServer() {
  const state = { callsA: 0, callsB: 0, requests: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = url.pathname.startsWith("/a/v1/") ? "a" : url.pathname.startsWith("/b/v1/") ? "b" : null;
    if (req.method !== "POST" || !route || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404); res.end(); return;
    }
    const body = JSON.parse(await readBody(req));
    const text = (body.messages || []).map((message) => String(message.content || "")).join("\n");
    if (route === "a") state.callsA += 1;
    else state.callsB += 1;
    state.requests.push({ route, text, authorization: req.headers.authorization || null, body });

    if (text.includes("STOP_TEST")) await new Promise((resolve) => setTimeout(resolve, 2000));
    if (text.includes("RECOVERY_TEST")) await new Promise((resolve) => setTimeout(resolve, 5000));

    const content = route === "a"
      ? `${PRIMARY_OUTPUT_CANARY}: primary recommendation for ${text.includes("BUDGET_EXHAUSTION_TEST") ? "budget test" : "approved question"}.`
      : text.includes(PRIMARY_OUTPUT_CANARY)
        ? "SPECIALIST_REVIEW_COMPLETE: reviewed the first answer and recommend the safer option."
        : "SECOND_COMPARISON_COMPLETE: independent second answer.";
    json(res, {
      model: route === "a" ? "model-a" : "model-b",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
  });
  const bound = await listen(server);
  return {
    ...bound,
    get callsA() { return state.callsA; },
    get callsB() { return state.callsB; },
    get totalCalls() { return state.callsA + state.callsB; },
    get requests() { return state.requests; }
  };
}

function json(res, payload, status = 200) {
  if (res.destroyed) return;
  try {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(payload));
  } catch {}
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
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

async function waitForText(locator, text, ms = timeoutMs) {
  const deadline = Date.now() + ms;
  let value = "";
  while (Date.now() < deadline) {
    value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text "${text}"; last="${value}"`);
}

async function waitUntil(predicate, ms, details) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for condition: ${await details()}`);
}

async function waitUntilAsync(predicate, ms, details) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for condition: ${details}`);
}
