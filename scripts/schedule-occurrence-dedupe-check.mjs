import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const origin = "https://example.test";
const skill = {
  schemaVersion: 1,
  id: "occurrence-dedupe-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify occurrence dedupe",
  description: "Test-only approved skill for simultaneous schedule delivery dedupe.",
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
  id: "same-occurrence",
  name: "same occurrence",
  enabled: true,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 23, minute: 50 },
  missedRunPolicy: "run_once_when_available",
  concurrencyPolicy: "queue_one",
  providerRef: "local-a",
  grantRefs: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z"
};

const storage = new Map([
  [SCHEDULES_KEY, [schedule]],
  [SCHEDULE_RUNS_KEY, []],
  [SKILL_LIBRARY_KEY, [skill]],
  [SKILL_RUNS_KEY, []]
]);
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();
let holdFirstRunRead = false;
let runReadCount = 0;
let firstRunReadResolve;
let releaseFirstRunReadResolve;
const firstRunReadEntered = new Promise((resolve) => { firstRunReadResolve = resolve; });
const releaseFirstRunRead = new Promise((resolve) => { releaseFirstRunReadResolve = resolve; });
let distinctRunReadBarrierEnabled = false;
let distinctRunReadCount = 0;
let firstDistinctConcurrencyReadResolve;
let releaseDistinctConcurrencyReadsResolve;
const firstDistinctConcurrencyReadEntered = new Promise((resolve) => { firstDistinctConcurrencyReadResolve = resolve; });
const releaseDistinctConcurrencyReads = new Promise((resolve) => { releaseDistinctConcurrencyReadsResolve = resolve; });
const clone = (value) => structuredClone(value);

function eventBucket(name) {
  const bucket = listeners[name];
  return {
    addListener(listener) { bucket.push(listener); },
    removeListener(listener) {
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    }
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
        if (keys === SCHEDULE_RUNS_KEY && holdFirstRunRead) {
          runReadCount += 1;
          if (runReadCount === 1) {
            firstRunReadResolve();
            await releaseFirstRunRead;
          }
        }
        if (keys === SCHEDULE_RUNS_KEY && distinctRunReadBarrierEnabled) {
          distinctRunReadCount += 1;
          if (distinctRunReadCount === 3) {
            firstDistinctConcurrencyReadResolve();
            await releaseDistinctConcurrencyReads;
          } else if (distinctRunReadCount === 6) {
            distinctRunReadBarrierEnabled = false;
            releaseDistinctConcurrencyReadsResolve();
            await releaseDistinctConcurrencyReads;
          }
        }
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

const dispatchCalls = [];
const taskCalls = [];
const runtime = await import("../src/schedules-runtime.js");
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    dispatchCalls.push(clone(input));
    if (input.mode === "preflight") {
      return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    }
    taskCalls.push(clone(input));
    return { ok: true, taskId: `task-${taskCalls.length}` };
  }
});

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose exactly one alarm listener before occurrence-race testing.");
const alarmListener = listeners.alarm[0];
const scheduledTime = Date.now();
const alarm = { name: `browsercrew.schedule.${schedule.id}`, scheduledTime };

holdFirstRunRead = true;
const firstDelivery = alarmListener(clone(alarm));
await firstRunReadEntered;
const secondDelivery = alarmListener(clone(alarm));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  runReadCount,
  1,
  "A simultaneous duplicate occurrence must wait behind the first occurrence before it can read durable run history."
);

holdFirstRunRead = false;
releaseFirstRunReadResolve();
await Promise.all([firstDelivery, secondDelivery]);

const occurrenceRuns = (await runtime.listScheduleRuns(schedule.id)).filter(
  (run) => run.scheduledFor === new Date(scheduledTime).toISOString()
);
assert.equal(occurrenceRuns.length, 1, "Two simultaneous deliveries of one scheduled occurrence must leave exactly one durable receipt.");
assert.equal(occurrenceRuns[0].status, "completed");
assert.equal(taskCalls.length, 1, "Two simultaneous deliveries of one scheduled occurrence must dispatch exactly one task.");
assert.equal(dispatchCalls.filter((call) => call.mode === "preflight").length, 1, "Duplicate occurrence delivery must not run a second preflight.");

const distinctTaskBaseline = taskCalls.length;
const distinctDispatchBaseline = dispatchCalls.length;
const distinctBaseTime = Date.now();
const firstDistinctAlarm = { name: `browsercrew.schedule.${schedule.id}`, scheduledTime: distinctBaseTime };
const secondDistinctAlarm = { name: `browsercrew.schedule.${schedule.id}`, scheduledTime: distinctBaseTime + 1 };
distinctRunReadBarrierEnabled = true;
distinctRunReadCount = 0;
const firstDistinctDelivery = alarmListener(clone(firstDistinctAlarm));
await firstDistinctConcurrencyReadEntered;
const secondDistinctDelivery = alarmListener(clone(secondDistinctAlarm));
await Promise.all([firstDistinctDelivery, secondDistinctDelivery]);

const distinctScheduledFor = new Set([
  new Date(firstDistinctAlarm.scheduledTime).toISOString(),
  new Date(secondDistinctAlarm.scheduledTime).toISOString()
]);
const distinctRuns = (await runtime.listScheduleRuns(schedule.id)).filter((run) => distinctScheduledFor.has(run.scheduledFor));
assert.equal(distinctRuns.length, 2, "Two distinct simultaneous scheduled occurrences must each leave one durable receipt.");
assert.equal(
  taskCalls.length - distinctTaskBaseline,
  2,
  "Two simultaneous distinct queue_one occurrences must leave one active path that drains the queued occurrence instead of stranding both as queued."
);
assert.equal(
  dispatchCalls.filter((call) => call.mode === "preflight").length - distinctDispatchBaseline,
  2,
  "Two distinct queue_one occurrences must each receive exactly one preflight before their task dispatch."
);
assert.equal(distinctRuns.every((run) => run.status === "completed"), true, "Both distinct queue_one receipts must complete rather than remain stranded in queued state.");

const runtimeSource = await readFile(new URL("../src/schedules-runtime.js", import.meta.url), "utf8");
for (const phrase of [
  "const occurrenceLocks = new Map()",
  "return withOccurrenceLock(JSON.stringify([scheduleId, scheduledFor])",
  "const previous = occurrenceLocks.get(key) || Promise.resolve()",
  "if (occurrenceLocks.get(key) === current) occurrenceLocks.delete(key)"
]) assert.ok(runtimeSource.includes(phrase), `Scheduler same-occurrence serialization contract missing: ${phrase}`);

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Occurrence dedupe hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Occurrence dedupe hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew simultaneous scheduled-occurrence dedupe checks passed.");
