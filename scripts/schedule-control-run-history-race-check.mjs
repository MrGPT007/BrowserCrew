import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const origin = "https://example.test";

const skill = {
  schemaVersion: 1,
  id: "control-history-race-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify control run history",
  description: "Test-only approved Skill for cross-module schedule run-history persistence.",
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

function schedule(id) {
  return {
    schemaVersion: 1,
    id,
    name: id.replaceAll("-", " "),
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
    nextRunAt: null
  };
}

const storage = new Map([
  [SCHEDULES_KEY, [schedule("scheduled-a"), schedule("manual-b")]],
  [SCHEDULE_RUNS_KEY, []],
  [SKILL_LIBRARY_KEY, [skill]],
  [SKILL_RUNS_KEY, []]
]);
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();
const clone = (value) => structuredClone(value);
let runSetCount = 0;
let holdFirstRunWrite = false;
let firstRunSetEnteredResolve;
let releaseFirstRunSetResolve;
const firstRunSetEntered = new Promise((resolve) => { firstRunSetEnteredResolve = resolve; });
const releaseFirstRunSet = new Promise((resolve) => { releaseFirstRunSetResolve = resolve; });

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

async function settleTurn() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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
        if (Object.prototype.hasOwnProperty.call(values, SCHEDULE_RUNS_KEY)) {
          runSetCount += 1;
          if (holdFirstRunWrite && runSetCount === 1) {
            firstRunSetEnteredResolve();
            await releaseFirstRunSet;
          }
        }
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

const dispatchCalls = [];
const scheduleRuntime = await import("../src/schedules-runtime.js");
const controlRuntime = await import("../src/schedule-controls-runtime.js");
await scheduleRuntime.bootSchedulesRuntime({
  async dispatch(input) {
    dispatchCalls.push(clone(input));
    if (input.mode === "preflight") return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    return { ok: true, taskId: `task-${input.schedule.id}` };
  }
});

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose exactly one alarm listener for the control/history race proof.");
assert.ok(alarms.has("browsercrew.schedule.scheduled-a"), "Scheduler boot must create the scheduled occurrence alarm.");
assert.ok(alarms.has("browsercrew.schedule.manual-b"), "Scheduler boot must create the exact alarm required by Run now.");

const alarmListener = listeners.alarm[0];
const firedAt = Date.now();
holdFirstRunWrite = true;
const scheduledDelivery = alarmListener({ name: "browsercrew.schedule.scheduled-a", scheduledTime: firedAt });
await firstRunSetEntered;
assert.equal(runSetCount, 1, "The scheduled occurrence must own the first held shared-history write.");

const manualRun = controlRuntime.runScheduleNow("manual-b");
await settleTurn();
const writesBeforeRelease = runSetCount;
holdFirstRunWrite = false;
releaseFirstRunSetResolve();
const results = await Promise.allSettled([scheduledDelivery, manualRun]);
for (const result of results) {
  if (result.status === "rejected") throw result.reason;
}

assert.equal(
  writesBeforeRelease,
  1,
  "Run now must wait while a scheduled occurrence owns the shared run-history mutation instead of persisting a competing stale receipt array."
);

const runs = await scheduleRuntime.listScheduleRuns();
assert.equal(runs.some((run) => run.scheduleId === "scheduled-a"), true, "The scheduled occurrence receipt must remain durable.");
assert.equal(runs.some((run) => run.scheduleId === "manual-b" && run.trigger === "manual"), true, "The Run-now receipt must remain durable.");
assert.ok(dispatchCalls.some((call) => call.schedule?.id === "scheduled-a"), "The scheduled occurrence must still reach normal dispatch.");
assert.ok(dispatchCalls.some((call) => call.schedule?.id === "manual-b"), "Run now must still reach normal reviewed dispatch after persistence serialization.");

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Run-history hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Run-history hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew schedule-control cross-module run-history race checks passed.");