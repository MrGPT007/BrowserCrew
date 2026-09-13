import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-lifecycle-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-lifecycle-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const report = { kind: "browsercrew.schedule_lifecycle_evidence", startedAt: new Date().toISOString(), checks: [] };
let context;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  const productionManifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8"));
  const productionWorker = await readFile(join(repoRoot, "src", "service-worker.js"), "utf8");
  assert.equal((productionManifest.permissions || []).includes("alarms"), false, "Pre-activation production manifest must remain alarm-free.");
  assert.equal(productionWorker.includes("bootSchedulesRuntime"), false, "Pre-activation production worker must not boot scheduling.");
  pass("Production remains pre-activation: no alarms permission and no scheduler boot");

  await prepareTestExtension(extensionDir);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1000, height: 760 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const now = new Date().toISOString();
  const nextRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const skill = {
    schemaVersion: 1,
    id: "schedule-lifecycle-skill",
    version: "1.0.0",
    status: "approved",
    title: "Schedule lifecycle proof",
    description: "Read-only approved Skill for Run now and Pause lifecycle proof.",
    inputs: {},
    allowedOrigins: ["https://example.com"],
    actionClasses: ["read"],
    dataDestinations: [],
    budgets: { maxSteps: 3, maxMinutes: 3 },
    steps: [{ id: "verify", kind: "verify", purpose: "Verify the reviewed page.", origin: "https://example.com", expect: { visibleText: "Example Domain" } }],
    completionCriteria: [{ claim: "Reviewed page is visible.", verification: "Visible text says Example Domain." }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "test", createdAt: now },
    approval: { approvedAt: now, approvedBy: "user" }
  };
  const schedule = {
    schemaVersion: 1,
    id: "schedule-lifecycle-active",
    name: "Lifecycle active schedule",
    enabled: true,
    skillRef: { id: skill.id, version: skill.version },
    timezone: "UTC",
    recurrence: { kind: "interval", everyMinutes: 60 },
    nextRunAt,
    lastRunAt: null,
    missedRunPolicy: "skip",
    concurrencyPolicy: "skip_if_running",
    providerRef: "schedule-lifecycle-provider",
    grantRefs: [],
    budgets: { maxSteps: 3, maxMinutes: 3 },
    createdAt: now,
    updatedAt: now
  };

  await panel.evaluate(async ({ skill, schedule, keys }) => {
    await chrome.storage.local.set({ [keys.skill]: [skill], [keys.schedules]: [schedule], [keys.runs]: [] });
  }, { skill, schedule, keys: { skill: SKILL_LIBRARY_KEY, schedules: SCHEDULES_KEY, runs: SCHEDULE_RUNS_KEY } });

  const boot = await worker.evaluate((scheduleId) => {
    const bootScheduler = globalThis.__browsercrewScheduleControlBoot;
    if (typeof bootScheduler !== "function") throw new Error("Test-only scheduler bootstrap is unavailable.");
    return bootScheduler({ [scheduleId]: { __browsercrewDirectResult: true } });
  }, schedule.id);
  assert.equal(boot.booted, true);
  pass("Temporary test extension booted the real scheduler behind alarms permission");

  const capabilities = await portRequest(panel, "browsercrew-schedule-controls", { type: "capabilities" });
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.schedulerReady, true);
  pass("Schedule control runtime exposes activation only when the live scheduler listener exists");

  const runNow = await portRequest(panel, "browsercrew-schedule-controls", { type: "runNow", scheduleId: schedule.id });
  assert.equal(runNow.ok, true, JSON.stringify(runNow));
  assert.equal(runNow.manual, true);
  assert.equal(runNow.run.status, "completed");
  assert.equal(runNow.run.trigger, "manual");
  assert.match(runNow.run.taskId || "", /^schedule-control-direct:/);

  const afterRun = await panel.evaluate(async ({ schedulesKey, runsKey, scheduleId }) => {
    const data = await chrome.storage.local.get([schedulesKey, runsKey]);
    return {
      schedule: (data[schedulesKey] || []).find((item) => item.id === scheduleId),
      runs: (data[runsKey] || []).filter((item) => item.scheduleId === scheduleId)
    };
  }, { schedulesKey: SCHEDULES_KEY, runsKey: SCHEDULE_RUNS_KEY, scheduleId: schedule.id });
  assert.equal(afterRun.runs.length, 1, "Run now must create exactly one schedule receipt.");
  assert.equal(afterRun.schedule.nextRunAt, nextRunAt, "Manual Run now must not shift the next recurring alarm.");
  assert.equal(afterRun.schedule.lastRunAt, null, "Manual Run now must not impersonate the last scheduled fire.");
  pass("Run now completed through schedule dispatch without moving the recurring schedule", { runId: runNow.run.id, taskId: runNow.run.taskId });

  const pause = await portRequest(panel, "browsercrew-schedule-controls", { type: "pause", scheduleId: schedule.id });
  assert.equal(pause.ok, true);
  assert.equal(pause.schedule.enabled, false);
  assert.equal(pause.schedule.nextRunAt, null);
  const alarmAfterPause = await worker.evaluate((scheduleId) => chrome.alarms.get(`browsercrew.schedule.${scheduleId}`), schedule.id);
  assert.equal(alarmAfterPause, undefined, "Pause must clear the exact Chrome alarm.");
  pass("Pause disabled the schedule and cleared its exact Chrome alarm while preserving setup/history");

  const pausedRun = await portRequest(panel, "browsercrew-schedule-controls", { type: "runNow", scheduleId: schedule.id });
  assert.equal(pausedRun.ok, false);
  assert.equal(pausedRun.error?.code, "SCHEDULE_PAUSED");
  const finalRuns = await panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key] || [], SCHEDULE_RUNS_KEY);
  assert.equal(finalRuns.filter((item) => item.scheduleId === schedule.id).length, 1, "Blocked Run now must not create a second receipt.");
  pass("Run now fails closed for a paused schedule without manufacturing history");

  report.ok = true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew schedule lifecycle smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.ok = false;
  report.completedAt = new Date().toISOString();
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name, details = null) { report.checks.push({ name, details, at: new Date().toISOString() }); }

async function prepareTestExtension(target) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", "dist"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions || []), "alarms"])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const workerPath = join(target, "src", "service-worker.js");
  const worker = await readFile(workerPath, "utf8");
  await writeFile(workerPath, `${worker}\nimport "../scripts/schedule-control-worker-bootstrap.js";\n`);
}

function portRequest(page, portName, payload) {
  return page.evaluate(({ portName, payload }) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: portName });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("Control port timed out.")); }, 10_000);
    const onMessage = (message) => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch {}
      resolve(message);
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({ ...payload, requestId });
  }), { portName, payload });
}
