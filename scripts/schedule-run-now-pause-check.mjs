import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const origin = "https://example.test";

const skill = {
  schemaVersion: 1,
  id: "run-now-pause-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify Run now Pause race",
  description: "Test-only approved Skill for Run now versus Pause serialization.",
  inputs: {},
  allowedOrigins: [origin],
  actionClasses: ["read"],
  dataDestinations: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Verify ready state.", origin, expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "Ready state is visible.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-13T00:00:00.000Z" },
  approval: { approvedAt: "2026-09-13T00:01:00.000Z", approvedBy: "user" }
};

const schedule = {
  schemaVersion: 1,
  id: "run-now-pause-race",
  name: "Run now Pause race",
  enabled: true,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 23, minute: 55 },
  missedRunPolicy: "run_once_when_available",
  concurrencyPolicy: "skip_if_running",
  providerRef: "local-a",
  grantRefs: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  lastRunAt: null,
  nextRunAt: new Date(Date.now() + 60_000).toISOString()
};

const clone = (value) => structuredClone(value);
const storage = new Map([
  [SCHEDULES_KEY, [clone(schedule)]],
  [SCHEDULE_RUNS_KEY, []],
  [SKILL_LIBRARY_KEY, [clone(skill)]],
  [SKILL_RUNS_KEY, []]
]);
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();
let manualReceiptBarrierArmed = false;
let manualReceiptWriteEnteredResolve;
let releaseManualReceiptWriteResolve;
let releaseManualReceiptWrite = Promise.resolve();

function armManualReceiptWriteBarrier() {
  manualReceiptBarrierArmed = true;
  const entered = new Promise((resolve) => { manualReceiptWriteEnteredResolve = resolve; });
  releaseManualReceiptWrite = new Promise((resolve) => { releaseManualReceiptWriteResolve = resolve; });
  return { entered, release: () => releaseManualReceiptWriteResolve() };
}

function eventBucket(name) {
  const bucket = listeners[name];
  return {
    addListener(listener) { bucket.push(listener); },
    removeListener(listener) {
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
    hasListeners() { return bucket.length > 0; }
  };
}

globalThis.chrome = {
  runtime: {
    onConnect: eventBucket("connect"),
    onStartup: eventBucket("startup"),
    onInstalled: eventBucket("installed")
  },
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return Object.fromEntries([...storage.entries()].map(([key, value]) => [key, clone(value)]));
        const wanted = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        return Object.fromEntries(wanted.filter((key) => storage.has(key)).map((key) => [key, clone(storage.get(key))]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, clone(value));
        const runs = values[SCHEDULE_RUNS_KEY];
        const newest = Array.isArray(runs) ? runs[0] : null;
        if (manualReceiptBarrierArmed && newest?.scheduleId === schedule.id && newest?.trigger === "manual" && newest?.status === "needs_review") {
          manualReceiptBarrierArmed = false;
          manualReceiptWriteEnteredResolve();
          await releaseManualReceiptWrite;
        }
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
      }
    }
  },
  alarms: {
    onAlarm: eventBucket("alarm"),
    async create(name, spec) { alarms.set(name, { name, ...clone(spec), scheduledTime: spec.when || Date.now() }); },
    async clear(name) { return alarms.delete(name); },
    async get(name) { return clone(alarms.get(name) || null); },
    async getAll() { return clone([...alarms.values()]); }
  }
};

let preflightCount = 0;
let taskDispatchCount = 0;
const runtime = await import("../src/schedules-runtime.js");
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    if (input.mode === "preflight") {
      preflightCount += 1;
      return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    }
    taskDispatchCount += 1;
    return { ok: true, taskId: "task-run-now-pause-race" };
  }
});
const controls = await import("../src/schedule-controls-runtime.js");

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose one alarm listener before Run now race testing.");
assert.ok(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), "Enabled test schedule must have its exact live alarm before Run now starts.");

const barrier = armManualReceiptWriteBarrier();
const runNowPromise = controls.runScheduleNow(schedule.id);
await barrier.entered;

const pendingRuns = await runtime.listScheduleRuns(schedule.id);
assert.equal(pendingRuns.length, 1, "Run now must durably create exactly one manual receipt before its review claim.");
assert.equal(pendingRuns[0].trigger, "manual");
assert.equal(pendingRuns[0].status, "needs_review", "The held manual receipt must still be waiting for its atomic review claim.");

const pauseResult = await runtime.setScheduleEnabled(schedule.id, false);
assert.equal(pauseResult.schedule.enabled, false, "Pause must durably disable the schedule before the held Run now review claim resumes.");
assert.equal(pauseResult.schedule.nextRunAt, null, "Pause must clear nextRunAt before the held Run now review claim resumes.");
assert.equal(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), null, "Pause must clear the exact Chrome alarm before the held Run now review claim resumes.");

barrier.release();
const runNowResult = await runNowPromise;

assert.equal(preflightCount, 0, "Run now must not preflight after same-schedule Pause commits before its review claim.");
assert.equal(taskDispatchCount, 0, "Run now must not dispatch a task after same-schedule Pause commits before its review claim.");
assert.equal(runNowResult.ok, false, "The stale Run now request must fail closed after Pause wins the race.");
assert.equal(runNowResult.run?.status, "blocked", "The stale manual receipt must become terminally blocked rather than execute.");
assert.equal(runNowResult.run?.reason, "SCHEDULE_PAUSED", "The stale manual receipt must record that same-schedule Pause won the race.");
assert.ok(runNowResult.run?.completedAt, "The blocked manual receipt must retain a durable completion timestamp.");

const runsAfterPause = await runtime.listScheduleRuns(schedule.id);
assert.equal(runsAfterPause.length, 1, "The Run now/Pause race must retain exactly one durable manual receipt.");
assert.equal(runsAfterPause[0].status, "blocked");
assert.equal(runsAfterPause[0].reason, "SCHEDULE_PAUSED");
const pausedSchedule = (await runtime.listSchedules()).find((item) => item.id === schedule.id);
assert.equal(pausedSchedule?.enabled, false, "Failing the stale Run now request must not re-enable the paused schedule.");
assert.equal(pausedSchedule?.nextRunAt, null, "Failing the stale Run now request must not recreate future schedule timing.");
assert.equal(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), null, "Failing the stale Run now request must not recreate the Chrome alarm.");

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Run now/Pause hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Run now/Pause hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew Run now versus Pause race regression checks passed.");
