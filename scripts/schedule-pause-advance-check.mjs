import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const origin = "https://example.test";

const skill = {
  schemaVersion: 1,
  id: "pause-advance-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify paused advancement",
  description: "Test-only approved Skill for pause-during-run schedule advancement.",
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
  id: "pause-during-run",
  name: "pause during run",
  enabled: true,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 23, minute: 50 },
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

let taskDispatchEnteredResolve;
let releaseTaskDispatchResolve;
const taskDispatchEntered = new Promise((resolve) => { taskDispatchEnteredResolve = resolve; });
const releaseTaskDispatch = new Promise((resolve) => { releaseTaskDispatchResolve = resolve; });
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
    taskDispatchEnteredResolve();
    await releaseTaskDispatch;
    return { ok: true, taskId: "task-pause-during-run" };
  }
});

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose one alarm listener before pause-during-run testing.");
const alarmListener = listeners.alarm[0];
const firedAt = Date.now();
const delivery = alarmListener({ name: `browsercrew.schedule.${schedule.id}`, scheduledTime: firedAt });
await taskDispatchEntered;

assert.equal(preflightCount, 1, "The active occurrence must pass preflight before the pause race is exercised.");
assert.equal(taskDispatchCount, 1, "The active occurrence must reach actual task dispatch before Pause commits.");

const pauseResult = await runtime.setScheduleEnabled(schedule.id, false);
assert.equal(pauseResult.schedule.enabled, false, "Pause must durably disable the schedule while its already-claimed task is still running.");
assert.equal(pauseResult.schedule.nextRunAt, null, "Pause must clear nextRunAt immediately while the active task is still running.");
assert.equal(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), null, "Pause must clear the exact Chrome alarm while the active task is still running.");

const pausedBeforeCompletion = (await runtime.listSchedules()).find((item) => item.id === schedule.id);
assert.equal(pausedBeforeCompletion?.enabled, false, "Paused state must be durable before the active task completes.");
assert.equal(pausedBeforeCompletion?.nextRunAt, null, "Durable paused state must have no next run before active-task completion.");

releaseTaskDispatchResolve();
await delivery;

const pausedAfterCompletion = (await runtime.listSchedules()).find((item) => item.id === schedule.id);
assert.equal(pausedAfterCompletion?.enabled, false, "Completing an already-claimed run must not re-enable a schedule paused during execution.");
assert.equal(
  pausedAfterCompletion?.nextRunAt,
  null,
  "Completing an already-claimed recurring run must not repopulate nextRunAt after same-schedule Pause committed."
);
assert.equal(pausedAfterCompletion?.lastRunAt, new Date(firedAt).toISOString(), "The completed occurrence may still record its actual lastRunAt while preserving paused scheduling metadata.");
assert.equal(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), null, "Completion after Pause must not recreate the Chrome alarm.");

const runs = await runtime.listScheduleRuns(schedule.id);
assert.equal(runs.length, 1, "The pause-during-run race must leave exactly one durable occurrence receipt.");
assert.equal(runs[0].status, "completed", "The already-claimed task may finish normally after Pause without scheduling a future occurrence.");

const runtimeSource = await readFile(new URL("../src/schedules-runtime.js", import.meta.url), "utf8");
assert.ok(runtimeSource.includes("async function advanceSchedule(scheduleId, firedAt)"), "Pause advancement regression must exercise the real schedule advancement path.");

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Pause advancement hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Pause advancement hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew pause-during-run schedule advancement regression checks passed.");
