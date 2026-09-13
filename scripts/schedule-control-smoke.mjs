import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-control-smoke");
const timeoutMs = 30_000;
const report = { startedAt: new Date().toISOString(), checks: [] };
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const TASKS_KEY = "browsercrew.tasks.v1";

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const productionManifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8"));
const productionServiceWorker = await readFile(join(repoRoot, "src", "service-worker.js"), "utf8");
assert.equal((productionManifest.permissions || []).includes("alarms"), false, "The active v0.2 manifest must not gain alarms permission from this proof.");
assert.equal(productionServiceWorker.includes("bootSchedulesRuntime"), false, "Production service-worker boot must remain disabled while v0.2 is active.");
pass("Production remains alarm-free and does not boot scheduling");

const fixture = await startFixtureServer();
const provider = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-control-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;

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
  const target = await context.newPage();
  await target.goto(`${fixture.origin}/read.html`);
  await target.bringToFront();

  const active = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }));
  assert.equal(active?.ok, true, "The fixture tab must resolve through the normal BrowserCrew active-tab path.");
  assert.equal(active.tab.url, `${fixture.origin}/read.html`);

  const now = new Date().toISOString();
  const skill = {
    schemaVersion: 1,
    id: "schedule-control-skill",
    version: "1.0.0",
    status: "approved",
    title: "Scheduled task control proof",
    description: "Read-only exact approved Skill used only by the schedule control smoke test.",
    inputs: {},
    allowedOrigins: [fixture.origin],
    actionClasses: ["read"],
    dataDestinations: [],
    budgets: { maxSteps: 5, maxMinutes: 5 },
    steps: [{ id: "verify-control-widget", kind: "verify", purpose: "Verify the fixture is still the intended page.", origin: fixture.origin, expect: { visibleText: "Control Widget" } }],
    completionCriteria: [{ claim: "The fixture remains visible.", verification: "Visible text says Control Widget." }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "test", createdAt: now },
    approval: { approvedAt: now, approvedBy: "user" }
  };
  const scheduleBase = {
    schemaVersion: 1,
    enabled: false,
    skillRef: { id: skill.id, version: skill.version },
    timezone: "UTC",
    recurrence: { kind: "once", when: Date.now() + 60 * 60_000 },
    missedRunPolicy: "ask",
    concurrencyPolicy: "skip_if_running",
    providerRef: "schedule-control-provider",
    grantRefs: [],
    budgets: { maxSteps: 5, maxMinutes: 5 },
    createdAt: now,
    updatedAt: now,
    nextRunAt: null
  };
  const stopSchedule = { ...scheduleBase, id: "schedule-stop-control", name: "Scheduled stop control" };
  const pauseSchedule = { ...scheduleBase, id: "schedule-pause-control", name: "Scheduled pause control" };
  const stopRun = missedReceipt("schedule-run-stop-control", stopSchedule, now);
  const pauseRun = missedReceipt("schedule-run-pause-control", pauseSchedule, now);

  await panel.evaluate(async ({ skill, schedules, runs, keys }) => {
    await chrome.storage.local.set({
      [keys.skill]: [skill],
      [keys.schedules]: schedules,
      [keys.runs]: runs,
      [keys.tasks]: []
    });
  }, {
    skill,
    schedules: [stopSchedule, pauseSchedule],
    runs: [stopRun, pauseRun],
    keys: { skill: SKILL_LIBRARY_KEY, schedules: SCHEDULES_KEY, runs: SCHEDULE_RUNS_KEY, tasks: TASKS_KEY }
  });

  const stopGoal = "Scheduled stop proof: find the product name and price.";
  const pauseGoal = "Scheduled pause proof: find the product name and price.";
  const payloads = {
    [stopSchedule.id]: taskPayload(stopGoal, active.tab, provider.origin),
    [pauseSchedule.id]: taskPayload(pauseGoal, active.tab, provider.origin)
  };

  const boot = await worker.evaluate(async ({ payloads }) => {
    const schedules = await import(chrome.runtime.getURL("src/schedules-runtime.js"));
    const background = await import(chrome.runtime.getURL("src/background.js"));
    globalThis.__browsercrewScheduleControlRuntime = schedules;
    globalThis.__browsercrewScheduleControlRuns = {};
    await schedules.bootSchedulesRuntime({
      dispatch: async (input) => {
        if (input.mode === "preflight") return { grantsValid: true, providerAvailable: true, resourceFresh: true };
        const payload = payloads[input.schedule?.id];
        if (!payload) return { ok: false, error: { code: "TEST_PAYLOAD_MISSING" } };
        return background.runTask(payload);
      }
    });
    return { alarmsPermission: chrome.runtime.getManifest().permissions.includes("alarms"), booted: true };
  }, { payloads });
  assert.equal(boot.alarmsPermission, true, "Only the temporary smoke-test copy should receive alarms permission.");
  pass("Test-only extension booted the real scheduler while production stayed locked");

  await startReviewedRun(worker, stopRun.id);
  await waitUntil(() => provider.requests.some((item) => item.kind === "stop"), 8_000, () => JSON.stringify(provider.snapshot()));
  const runningStopTask = await waitForTask(panel, stopGoal, (task) => task.status === "running" && task.journal.some((entry) => entry.type === "provider.intent"));
  const stopControl = await panel.evaluate((taskId) => chrome.runtime.sendMessage({ type: "STOP_TASK", taskId }), runningStopTask.id);
  assert.equal(stopControl?.ok, true);
  assert.equal(stopControl.task.status, "cancelled");
  await waitUntil(() => provider.requests.find((item) => item.kind === "stop")?.aborted === true, 4_000, () => JSON.stringify(provider.snapshot()));
  const stopResult = await finishReviewedRun(worker, stopRun.id);
  const stoppedTask = await waitForTask(panel, stopGoal, (task) => task.status === "cancelled" && task.error?.code === "TASK_CANCELLED");
  const stoppedReceipt = await readScheduleRun(panel, stopRun.id);
  assert.equal(stopResult.ok, false);
  assert.equal(stopResult.run.status, "cancelled");
  assert.equal(stoppedReceipt.status, "cancelled");
  assert.equal(stoppedReceipt.reason, "TASK_CANCELLED");
  assert.equal(stoppedReceipt.taskId, stoppedTask.id, "Schedule history must link to the exact normal BrowserCrew task that was stopped.");
  assert.equal(stoppedTask.result, null);
  assert.equal(stoppedTask.journal.some((entry) => entry.type === "provider.complete"), false, "Stop must abort the active provider step before completion is journaled.");
  pass("Stop cancelled the scheduled normal task, aborted its provider request, and preserved exact receipt linkage", { scheduleRunId: stopRun.id, taskId: stoppedTask.id });

  await startReviewedRun(worker, pauseRun.id);
  await waitUntil(() => provider.requests.some((item) => item.kind === "pause"), 8_000, () => JSON.stringify(provider.snapshot()));
  const runningPauseTask = await waitForTask(panel, pauseGoal, (task) => task.status === "running" && task.journal.some((entry) => entry.type === "provider.intent"));
  const pauseControl = await panel.evaluate((taskId) => chrome.runtime.sendMessage({ type: "PAUSE_TASK", taskId }), runningPauseTask.id);
  assert.equal(pauseControl?.ok, true);
  assert.equal(pauseControl.task.status, "paused");
  await waitUntil(() => provider.requests.find((item) => item.kind === "pause")?.completed === true, 5_000, () => JSON.stringify(provider.snapshot()));
  const pauseResult = await finishReviewedRun(worker, pauseRun.id);
  const pausedTask = await waitForTask(panel, pauseGoal, (task) => task.status === "paused" && task.error?.code === "TASK_PAUSED" && task.journal.some((entry) => entry.type === "provider.complete"));
  const pausedReceipt = await readScheduleRun(panel, pauseRun.id);
  assert.equal(pauseResult.ok, false);
  assert.equal(pauseResult.run.status, "paused");
  assert.equal(pausedReceipt.status, "paused");
  assert.equal(pausedReceipt.reason, "TASK_PAUSED");
  assert.equal(pausedReceipt.taskId, pausedTask.id, "Schedule history must link to the exact normal BrowserCrew task that was paused.");
  assert.equal(pausedTask.result, null, "Pause must block final verification/completion after the current provider step reconciles.");
  assert.equal(provider.requests.find((item) => item.kind === "pause")?.aborted, false, "Pause must not abort the current provider request.");
  pass("Pause let the current scheduled provider step reconcile, then blocked the next task step and preserved exact receipt linkage", { scheduleRunId: pauseRun.id, taskId: pausedTask.id });

  const tasks = await panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key] || [], TASKS_KEY);
  assert.equal(tasks.filter((task) => task.goal === stopGoal).length, 1, "Scheduled Stop proof must create exactly one normal task.");
  assert.equal(tasks.filter((task) => task.goal === pauseGoal).length, 1, "Scheduled Pause proof must create exactly one normal task.");
  const runs = await panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key] || [], SCHEDULE_RUNS_KEY);
  assert.equal(runs.filter((run) => run.id === stopRun.id).length, 1);
  assert.equal(runs.filter((run) => run.id === pauseRun.id).length, 1);
  pass("Scheduled controls created no duplicate tasks or run receipts");

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), stopGoal);
  await waitForText(panel.locator("#historyList"), pauseGoal);
  const historyText = await panel.locator("#historyList").innerText();
  assert.match(historyText, /Cancelled/i);
  assert.match(historyText, /Paused/i);
  await panel.screenshot({ path: join(artifactDir, "schedule-control-history.png"), fullPage: true });
  pass("Normal task History exposes the stopped and paused scheduled tasks for review");

  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.provider = provider.snapshot();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew scheduled task Stop/Pause installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  report.provider = provider.snapshot();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "schedule-control-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await provider.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name, details = null) { report.checks.push({ name, details, at: new Date().toISOString() }); }

function taskPayload(goal, tab, providerOrigin) {
  return {
    goal,
    tab,
    settings: { kind: "lmstudio", model: "schedule-control-smoke", baseUrl: `${providerOrigin}/v1` },
    secret: ""
  };
}

function missedReceipt(id, schedule, now) {
  return {
    id,
    schemaVersion: 1,
    scheduleId: schedule.id,
    skillRef: schedule.skillRef,
    scheduledFor: now,
    firedAt: now,
    latenessMs: 10 * 60_000,
    missed: true,
    missedAction: "ask",
    status: "needs_review",
    reason: "SCHEDULE_MISSED_REVIEW_REQUIRED",
    taskId: null,
    reviewRequestedAt: now,
    completedAt: now
  };
}

async function startReviewedRun(worker, runId) {
  const started = await worker.evaluate((runId) => {
    const runtime = globalThis.__browsercrewScheduleControlRuntime;
    if (!runtime) throw new Error("Schedule control runtime was not retained after test boot.");
    globalThis.__browsercrewScheduleControlRuns[runId] = runtime.reviewMissedScheduleRun(runId, "run_once");
    return true;
  }, runId);
  assert.equal(started, true);
}

async function finishReviewedRun(worker, runId) {
  return worker.evaluate(async (runId) => {
    const promise = globalThis.__browsercrewScheduleControlRuns?.[runId];
    if (!promise) throw new Error(`No scheduled test run promise exists for ${runId}.`);
    return promise;
  }, runId);
}

async function readScheduleRun(panel, runId) {
  return panel.evaluate(async ({ key, runId }) => {
    const stored = await chrome.storage.local.get(key);
    return (stored[key] || []).find((run) => run.id === runId) || null;
  }, { key: SCHEDULE_RUNS_KEY, runId });
}

async function waitForTask(panel, goal, predicate) {
  let latest = null;
  for (let attempt = 0; attempt < 220; attempt += 1) {
    latest = await panel.evaluate(async ({ key, goal }) => {
      const stored = await chrome.storage.local.get(key);
      return (stored[key] || []).find((task) => task.goal === goal) || null;
    }, { key: TASKS_KEY, goal });
    if (latest && predicate(latest)) return latest;
    await panel.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for scheduled normal task state: ${goal} :: ${JSON.stringify(latest)}`);
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function waitUntil(predicate, timeout, describe) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for condition. State: ${describe()}`);
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "node_modules", "artifacts"].includes(relative.split(/[/\\]/)[0]);
  }});
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions || []), "alarms"])];
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/read.html") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Schedule Control fixture</title></head><body><main><h1>Control Widget</h1><p>Product: Control Widget</p><p>Price: $29</p></main></body></html>`);
  });
  return listen(server);
}

async function startProviderServer() {
  const state = { requests: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(await readBody(req));
    const combined = (body.messages || []).map((item) => String(item.content || "")).join("\n");
    const kind = /Scheduled pause proof/i.test(combined) ? "pause" : "stop";
    const entry = { kind, aborted: false, completed: false, startedAt: new Date().toISOString() };
    state.requests.push(entry);
    res.on("close", () => {
      if (!res.writableEnded && !entry.completed) {
        entry.aborted = true;
        entry.abortedAt = new Date().toISOString();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, kind === "pause" ? 1100 : 5000));
    if (res.destroyed || entry.aborted) return;
    entry.completed = true;
    entry.completedAt = new Date().toISOString();
    const content = JSON.stringify({ items: [{ label: "Product", value: "Control Widget" }, { label: "Price", value: "$29" }], notes: "Fixture response" });
    json(res, { model: "schedule-control-smoke", choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 20 } });
  });
  const bound = await listen(server);
  return {
    ...bound,
    get requests() { return state.requests; },
    snapshot() { return { requests: state.requests.map((item) => ({ ...item })) }; }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, payload, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(payload));
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
