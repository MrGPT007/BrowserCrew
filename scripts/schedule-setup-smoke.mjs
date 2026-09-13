import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-setup-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-setup-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.schedule_setup_smoke", startedAt: new Date().toISOString(), checks: [] };

const skill = {
  schemaVersion: 1,
  id: "prepared-schedule-skill",
  version: "1.2.0",
  status: "approved",
  title: "Check supplier dashboard",
  description: "Read the approved supplier dashboard and verify its ready state.",
  inputs: {},
  allowedOrigins: ["https://example.test"],
  allowedResources: ["catalog:suppliers"],
  actionClasses: ["read"],
  dataDestinations: [],
  budgets: { maxSteps: 7, maxMinutes: 6 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Verify dashboard readiness.", origin: "https://example.test", expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "Dashboard is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-12T00:00:00.000Z" },
  approval: { approvedAt: "2026-09-12T00:01:00.000Z", approvedBy: "user" }
};
const connection = {
  id: "local-prepared-ai",
  schemaVersion: 1,
  name: "Local planning AI",
  kind: "openai-compatible",
  model: "browsercrew-local-test",
  baseUrl: "http://127.0.0.1:1234/v1",
  status: "connected",
  lastTestedAt: "2026-09-12T00:02:00.000Z",
  createdAt: "2026-09-12T00:02:00.000Z",
  updatedAt: "2026-09-12T00:02:00.000Z"
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);
  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false, "Prepared-schedule proof must keep the v0.2 manifest free of alarms permission.");
  pass("Prepared schedule setup keeps the v0.2 manifest free of alarms permission");

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1200 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  await worker.evaluate(async ({ skillSeed, connectionSeed }) => {
    await chrome.storage.local.set({
      "browsercrew.skillLibrary.v1": [skillSeed],
      "browsercrew.connections.v1": [connectionSeed],
      "browsercrew.activeConnection.v1": connectionSeed.id,
      "browsercrew.schedules.v1": [],
      "browsercrew.scheduleRuns.v1": []
    });
  }, { skillSeed: skill, connectionSeed: connection });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await waitUntil(async () => (await panel.locator("#scheduleSetupButton").innerText()) === "Prepare a schedule" && !(await panel.locator("#scheduleSetupButton").isDisabled()), "Prepared schedule setup should unlock for an approved skill and named AI connection.");

  assert.match(await panel.locator("#scheduleCapabilityStatus").innerText(), /Scheduling is not active in this build/i);
  assert.equal(await panel.locator("#scheduleSetupPanel").isHidden(), true);
  pass("Skills UI separates schedule preparation from inactive background scheduling");

  const future = new Date(Date.now() + 2 * 60 * 60_000);
  future.setSeconds(0, 0);
  const localFuture = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  await createSchedule(panel, {
    name: "One time supplier check",
    preset: "once",
    fill: async () => panel.locator("#scheduleOnceAt").fill(localFuture)
  });
  await createSchedule(panel, {
    name: "Daily supplier check",
    preset: "daily",
    fill: async () => panel.locator("#scheduleDailyTime").fill("08:15"),
    missed: "run_once_when_available"
  });
  await createSchedule(panel, {
    name: "Weekly supplier check",
    preset: "weekly",
    fill: async () => {
      await panel.locator("#scheduleWeekday").selectOption("5");
      await panel.locator("#scheduleWeeklyTime").fill("16:30");
    },
    concurrency: "queue_one"
  });
  await createSchedule(panel, {
    name: "Custom supplier check",
    preset: "interval",
    fill: async () => panel.locator("#scheduleIntervalMinutes").fill("90"),
    missed: "skip"
  });

  let schedules = await storedSchedules(worker);
  assert.equal(schedules.length, 4);
  assert.ok(schedules.every((item) => item.enabled === false), "Every UI-created schedule must remain disabled.");
  assert.ok(schedules.every((item) => item.nextRunAt === null), "Prepared schedules must not claim a next alarm-backed run.");
  assert.ok(schedules.every((item) => item.skillRef.id === skill.id && item.skillRef.version === skill.version));
  assert.ok(schedules.every((item) => item.providerRef === connection.id));
  assert.ok(schedules.every((item) => item.budgets.maxSteps === 7 && item.budgets.maxMinutes === 6));
  assert.deepEqual(new Set(schedules.map((item) => item.recurrence.kind)), new Set(["once", "daily", "weekly", "interval"]));
  assert.equal(schedules.find((item) => item.name === "Daily supplier check")?.missedRunPolicy, "run_once_when_available");
  assert.equal(schedules.find((item) => item.name === "Weekly supplier check")?.concurrencyPolicy, "queue_one");
  assert.equal(schedules.find((item) => item.name === "Custom supplier check")?.recurrence.everyMinutes, 90);
  await waitUntil(async () => await panel.locator("[data-prepared-schedule]").count() === 4, "All four prepared schedule cards should render before status review.");
  pass("Once, Daily, Weekly, and Custom presets persist as disabled exact-skill schedules with named AI and inherited budgets");

  const daily = schedules.find((item) => item.name === "Daily supplier check");
  const dailyCard = panel.locator(`[data-prepared-schedule="${daily.id}"]`);
  const dailyText = await dailyCard.innerText();
  for (const phrase of [
    "Status: Prepared — not active in this build.",
    "Next run: Not scheduled",
    "Last run: Never",
    "Exact job: Check supplier dashboard · v1.2.0",
    "AI / model: Local planning AI · browsercrew-local-test",
    "Timezone: America/New_York",
    "Sites: https://example.test",
    "Resources: catalog:suppliers",
    "Permission scope: Actions read · Data destinations None",
    "Budget: Up to 7 steps · 6 minutes.",
    "Missed run: Run it once when BrowserCrew is available again.",
    "Overlap: Skip the overlapping run.",
    "BrowserCrew cannot wake a sleeping or offline browser or device."
  ]) assert.ok(dailyText.includes(phrase), `Prepared schedule boundary card missing: ${phrase}`);
  assert.equal(await dailyCard.getByRole("button", { name: "Run now" }).isDisabled(), true);
  assert.equal(await dailyCard.getByRole("button", { name: "Pause" }).isDisabled(), true);
  assert.equal(await dailyCard.getByRole("button", { name: "Edit" }).isEnabled(), true);
  assert.equal(await dailyCard.getByRole("button", { name: "Delete" }).isEnabled(), true);

  const weekly = schedules.find((item) => item.name === "Weekly supplier check");
  assert.match(await panel.locator(`[data-prepared-schedule="${weekly.id}"]`).innerText(), /Overlap: Queue one run; reject additional overlap\./);
  const custom = schedules.find((item) => item.name === "Custom supplier check");
  assert.match(await panel.locator(`[data-prepared-schedule="${custom.id}"]`).innerText(), /Missed run: Skip the missed run\./);
  pass("Prepared cards expose status, exact provider and Skill scope, safety limits, missed/overlap rules, and honest device availability while Run now and Pause stay unavailable");

  const historyReceipt = {
    id: "schedule-run-history-1",
    schemaVersion: 1,
    scheduleId: daily.id,
    skillRef: daily.skillRef,
    scheduledFor: "2026-09-12T12:00:00.000Z",
    firedAt: "2026-09-12T12:01:00.000Z",
    status: "completed",
    reason: null,
    taskId: "task-history-1",
    completedAt: "2026-09-12T12:02:00.000Z"
  };
  await worker.evaluate(async (receipt) => chrome.storage.local.set({ "browsercrew.scheduleRuns.v1": [receipt] }), historyReceipt);

  const originalCreatedAt = daily.createdAt;
  await panel.locator(`[data-edit-schedule="${daily.id}"]`).click();
  await panel.locator("#scheduleName").fill("Daily supplier check updated");
  await panel.locator("#schedulePreset").selectOption("weekly");
  await panel.locator("#scheduleWeekday").selectOption("2");
  await panel.locator("#scheduleWeeklyTime").fill("11:45");
  await panel.locator("#scheduleMissedPolicy").selectOption("ask");
  await panel.locator("#scheduleSaveDraft").click();
  await waitUntil(async () => /Prepared schedule saved/i.test(await panel.locator("#toast").innerText()), "Edited prepared schedule should save.");

  schedules = await storedSchedules(worker);
  const updated = schedules.find((item) => item.id === daily.id);
  assert.equal(updated.name, "Daily supplier check updated");
  assert.equal(updated.createdAt, originalCreatedAt, "Editing must preserve prepared schedule identity and creation time.");
  assert.equal(updated.enabled, false);
  assert.equal(updated.recurrence.kind, "weekly");
  assert.equal(updated.recurrence.weekday, 2);
  assert.equal(updated.recurrence.hour, 11);
  assert.equal(updated.recurrence.minute, 45);
  await waitUntil(async () => /Completed · receipt schedule-run-history-1/.test(await panel.locator(`[data-prepared-schedule="${daily.id}"]`).innerText()), "Edited prepared schedule card should surface the exact durable history receipt.");
  const updatedCardText = await panel.locator(`[data-prepared-schedule="${daily.id}"]`).innerText();
  assert.match(updatedCardText, /Last run: .*Completed · receipt schedule-run-history-1/);
  assert.match(updatedCardText, /Missed run: Ask me what to do\./);
  pass("Editing preserves identity and the prepared card reads immutable schedule-run history without activating the schedule");

  assert.equal(await panel.locator('#schedulesPreviewCard [data-enable-schedule], #schedulesPreviewCard [data-set-enabled]').count(), 0, "Prepared schedule UI must expose no activation control.");
  assert.match(await panel.locator("#scheduleSetupPanel").innerText(), /does not turn the schedule on/i);
  pass("Prepared schedule UI exposes no activation control before the alarms permission release");

  for (const schedule of [...schedules]) {
    panel.once("dialog", (dialog) => dialog.accept());
    await panel.locator(`[data-delete-schedule="${schedule.id}"]`).click();
    await waitUntil(async () => (await storedSchedules(worker)).every((item) => item.id !== schedule.id), `Prepared schedule ${schedule.id} should be deleted.`);
  }
  assert.equal((await storedSchedules(worker)).length, 0);
  assert.equal((await storedScheduleRuns(worker)).some((run) => run.id === historyReceipt.id), true, "Deleting a prepared schedule must not erase its historical run receipt.");
  await waitUntil(async () => /No prepared schedules yet/i.test(await panel.locator("#preparedScheduleList").innerText()), "Prepared schedule list should return to empty state.");
  pass("Prepared schedules can be deleted without scheduler activation while historical run evidence remains durable");

  await panel.screenshot({ path: join(artifactDir, "schedule-setup.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew prepared schedule installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function createSchedule(panel, { name, preset, fill, missed = "ask", concurrency = "skip_if_running" }) {
  await panel.locator("#scheduleSetupButton").click();
  await panel.locator("#scheduleSetupPanel").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#scheduleName").fill(name);
  await panel.locator("#scheduleSkill").selectOption(`${skill.id}@@${skill.version}`);
  await panel.locator("#scheduleConnection").selectOption(connection.id);
  await panel.locator("#scheduleTimezone").fill("America/New_York");
  await panel.locator("#schedulePreset").selectOption(preset);
  await panel.locator("#scheduleMissedPolicy").selectOption(missed);
  await panel.locator("#scheduleConcurrency").selectOption(concurrency);
  await fill();
  await panel.locator("#scheduleSaveDraft").click();
  await waitUntil(async () => /Prepared schedule saved/i.test(await panel.locator("#toast").innerText()) && await panel.locator("#scheduleSetupPanel").isHidden(), `${name} should save and close the setup form.`);
}

async function storedSchedules(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.schedules.v1"))["browsercrew.schedules.v1"] || []);
}

async function storedScheduleRuns(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.scheduleRuns.v1"))["browsercrew.scheduleRuns.v1"] || []);
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareExtension(target) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
    }
  });
}

async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
