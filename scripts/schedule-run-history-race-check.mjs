import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const origin = "https://example.test";

const skill = {
  schemaVersion: 1,
  id: "run-history-race-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify shared run history",
  description: "Test-only approved Skill for concurrent schedule receipt persistence.",
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
    updatedAt: "2026-09-13T00:00:00.000Z"
  };
}

const schedules = [schedule("history-a"), schedule("history-b")];
const storage = new Map([
  [SCHEDULES_KEY, schedules],
  [SCHEDULE_RUNS_KEY, []],
  [SKILL_LIBRARY_KEY, [skill]],
  [SKILL_RUNS_KEY, []]
]);
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();
const clone = (value) => structuredClone(value);
let holdFirstRunWrite = false;
let scheduleRunGetCount = 0;
let scheduleRunSetCount = 0;
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
        if (keys === SCHEDULE_RUNS_KEY && holdFirstRunWrite) scheduleRunGetCount += 1;
        if (keys == null) return Object.fromEntries([...storage.entries()].map(([key, value]) => [key, clone(value)]));
        const wanted = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        return Object.fromEntries(wanted.filter((key) => storage.has(key)).map((key) => [key, clone(storage.get(key))]));
      },
      async set(values) {
        if (Object.prototype.hasOwnProperty.call(values, SCHEDULE_RUNS_KEY)) {
          scheduleRunSetCount += 1;
          if (holdFirstRunWrite && scheduleRunSetCount === 1) {
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
const taskCalls = [];
const runtime = await import("../src/schedules-runtime.js");
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    dispatchCalls.push(clone(input));
    if (input.mode === "preflight") return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    taskCalls.push(clone(input));
    return { ok: true, taskId: `task-${input.schedule.id}` };
  }
});

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose one alarm listener before shared-history race testing.");
const alarmListener = listeners.alarm[0];
const firedAt = Date.now();
holdFirstRunWrite = true;
const firstDelivery = alarmListener({ name: "browsercrew.schedule.history-a", scheduledTime: firedAt });
await firstRunSetEntered;
assert.equal(scheduleRunGetCount, 2, "The first run must perform duplicate lookup and then its receipt mutation read before the held write.");

const secondDelivery = alarmListener({ name: "browsercrew.schedule.history-b", scheduledTime: firedAt + 1 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  scheduleRunGetCount,
  3,
  "A distinct concurrent schedule may perform its duplicate lookup, but its receipt mutation read must wait for the first shared-history mutation to commit."
);

holdFirstRunWrite = false;
releaseFirstRunSetResolve();
await Promise.all([firstDelivery, secondDelivery]);

const runs = await runtime.listScheduleRuns();
assert.equal(runs.length, 2, "Two concurrent distinct schedules must leave two durable run receipts.");
assert.deepEqual(new Set(runs.map((run) => run.scheduleId)), new Set(["history-a", "history-b"]));
for (const run of runs) assert.equal(run.status, "completed", `Concurrent receipt for ${run.scheduleId} must reach completed without being overwritten.`);
assert.equal(taskCalls.length, 2, "Shared receipt serialization must not serialize away or skip distinct schedule task execution.");
assert.equal(dispatchCalls.filter((call) => call.mode === "preflight").length, 2, "Both distinct schedules must retain independent preflight execution.");

const runtimeSource = await readFile(new URL("../src/schedules-runtime.js", import.meta.url), "utf8");
for (const phrase of [
  "let runHistoryMutation = null",
  "async function withRunHistoryMutation(work)",
  "const previous = runHistoryMutation || Promise.resolve()",
  "if (runHistoryMutation === current) runHistoryMutation = null"
]) assert.ok(runtimeSource.includes(phrase), `Shared schedule-run history serialization contract missing: ${phrase}`);

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Run-history hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Run-history hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew concurrent schedule run-history persistence checks passed.");
