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
  title: "Verify shared schedule state",
  description: "Test-only approved Skill for concurrent schedule persistence.",
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

function schedule(id, { enabled = true, name = null } = {}) {
  return {
    schemaVersion: 1,
    id,
    name: name || id.replaceAll("-", " "),
    enabled,
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
  [SCHEDULES_KEY, [schedule("history-a"), schedule("history-b")]],
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
let trackScheduleState = false;
let holdFirstScheduleWrite = false;
let scheduleGetCount = 0;
let scheduleSetCount = 0;
let firstScheduleSetEnteredResolve = null;
let releaseFirstScheduleSetResolve = null;
let firstScheduleSetEntered = null;
let releaseFirstScheduleSet = null;

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

function armScheduleWriteBarrier() {
  trackScheduleState = true;
  holdFirstScheduleWrite = true;
  scheduleGetCount = 0;
  scheduleSetCount = 0;
  firstScheduleSetEntered = new Promise((resolve) => { firstScheduleSetEnteredResolve = resolve; });
  releaseFirstScheduleSet = new Promise((resolve) => { releaseFirstScheduleSetResolve = resolve; });
  return {
    entered: firstScheduleSetEntered,
    release() {
      holdFirstScheduleWrite = false;
      releaseFirstScheduleSetResolve();
    }
  };
}

async function settleTurn() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function isScheduleRunHistoryRead(keys) {
  return keys === SCHEDULE_RUNS_KEY || (Array.isArray(keys) && (
    (keys.length === 1 && keys[0] === SCHEDULE_RUNS_KEY) ||
    (keys.length === 2 && keys[0] === SCHEDULE_RUNS_KEY && keys[1] === SCHEDULES_KEY)
  ));
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
        if (isScheduleRunHistoryRead(keys) && holdFirstRunWrite) scheduleRunGetCount += 1;
        if (keys === SCHEDULES_KEY && trackScheduleState) scheduleGetCount += 1;
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
        if (Object.prototype.hasOwnProperty.call(values, SCHEDULES_KEY) && trackScheduleState) {
          scheduleSetCount += 1;
          if (holdFirstScheduleWrite && scheduleSetCount === 1) {
            firstScheduleSetEnteredResolve();
            await releaseFirstScheduleSet;
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

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose one alarm listener before persistence race testing.");
const alarmListener = listeners.alarm[0];
const firedAt = Date.now();
holdFirstRunWrite = true;
const firstDelivery = alarmListener({ name: "browsercrew.schedule.history-a", scheduledTime: firedAt });
await firstRunSetEntered;
assert.equal(scheduleRunGetCount, 1, "The first run must perform one atomic occurrence claim read before the held history write.");

const secondDelivery = alarmListener({ name: "browsercrew.schedule.history-b", scheduledTime: firedAt + 1 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  scheduleRunGetCount,
  1,
  "A distinct concurrent schedule must wait behind the first shared-history occurrence claim before reading durable run history."
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

async function resetScheduleState(items) {
  trackScheduleState = false;
  holdFirstScheduleWrite = false;
  storage.set(SCHEDULES_KEY, clone(items));
  storage.set(SCHEDULE_RUNS_KEY, []);
  alarms.clear();
  dispatchCalls.length = 0;
  taskCalls.length = 0;
  await runtime.reconcileScheduleAlarms();
}

async function persistedSchedules() {
  trackScheduleState = false;
  return runtime.listSchedules();
}

async function proveConcurrentAdvancement() {
  await resetScheduleState([schedule("state-a"), schedule("state-b")]);
  const barrier = armScheduleWriteBarrier();
  const first = alarmListener({ name: "browsercrew.schedule.state-a", scheduledTime: firedAt + 10_000 });
  await barrier.entered;
  assert.equal(scheduleGetCount, 2, "The first delivery must read schedule state once for dispatch and once for advancement before its held write.");

  const second = alarmListener({ name: "browsercrew.schedule.state-b", scheduledTime: firedAt + 10_001 });
  await settleTurn();
  assert.equal(scheduleGetCount, 3, "The second schedule may read itself for dispatch but must not enter its advancement mutation read while the first advancement owns schedule state.");
  assert.equal(scheduleSetCount, 1, "A second schedule advancement must not write from a stale shared schedule snapshot.");

  barrier.release();
  await Promise.all([first, second]);
  const saved = await persistedSchedules();
  assert.ok(saved.find((item) => item.id === "state-a")?.lastRunAt, "Schedule A advancement must remain durable.");
  assert.ok(saved.find((item) => item.id === "state-b")?.lastRunAt, "Schedule B advancement must remain durable.");
  assert.equal(taskCalls.length, 2, "Schedule-state serialization must not serialize away distinct task execution.");
}

async function proveAdvanceVsPause() {
  await resetScheduleState([schedule("pause-a"), schedule("pause-b")]);
  const barrier = armScheduleWriteBarrier();
  const delivery = alarmListener({ name: "browsercrew.schedule.pause-a", scheduledTime: firedAt + 20_000 });
  await barrier.entered;

  const pause = runtime.setScheduleEnabled("pause-b", false);
  await settleTurn();
  assert.equal(scheduleSetCount, 1, "Pause must wait for the in-flight advancement mutation instead of persisting a competing stale array.");

  barrier.release();
  await Promise.all([delivery, pause]);
  const saved = await persistedSchedules();
  assert.ok(saved.find((item) => item.id === "pause-a")?.lastRunAt, "Advancement must survive a concurrent pause on another schedule.");
  assert.equal(saved.find((item) => item.id === "pause-b")?.enabled, false, "A concurrent pause must not be resurrected by a stale advancement write.");
}

async function proveAdvanceVsDelete() {
  await resetScheduleState([schedule("delete-a"), schedule("delete-b")]);
  const barrier = armScheduleWriteBarrier();
  const delivery = alarmListener({ name: "browsercrew.schedule.delete-a", scheduledTime: firedAt + 30_000 });
  await barrier.entered;

  const deletion = runtime.deleteSchedule("delete-b");
  await settleTurn();
  assert.equal(scheduleSetCount, 1, "Delete must wait for the in-flight advancement mutation instead of persisting a competing stale array.");

  barrier.release();
  await Promise.all([delivery, deletion]);
  const saved = await persistedSchedules();
  assert.ok(saved.find((item) => item.id === "delete-a")?.lastRunAt, "Advancement must survive a concurrent delete on another schedule.");
  assert.equal(saved.some((item) => item.id === "delete-b"), false, "A deleted schedule must never be resurrected by a stale advancement write.");
}

async function proveAdvanceVsEdit() {
  const editable = schedule("edit-b", { enabled: false, name: "Before edit" });
  await resetScheduleState([schedule("edit-a"), editable]);
  const barrier = armScheduleWriteBarrier();
  const delivery = alarmListener({ name: "browsercrew.schedule.edit-a", scheduledTime: firedAt + 40_000 });
  await barrier.entered;

  const edit = runtime.saveSchedule({ ...editable, name: "After edit" });
  await settleTurn();
  assert.equal(scheduleSetCount, 1, "Save/edit may validate outside the lock but must not persist until the in-flight advancement mutation commits.");

  barrier.release();
  await Promise.all([delivery, edit]);
  const saved = await persistedSchedules();
  assert.ok(saved.find((item) => item.id === "edit-a")?.lastRunAt, "Advancement must survive a concurrent edit on another schedule.");
  assert.equal(saved.find((item) => item.id === "edit-b")?.name, "After edit", "A concurrent edit must not be lost to a stale advancement write.");
}

await proveConcurrentAdvancement();
await proveAdvanceVsPause();
await proveAdvanceVsDelete();
await proveAdvanceVsEdit();

const runtimeSource = await readFile(new URL("../src/schedules-runtime.js", import.meta.url), "utf8");
const controlsSource = await readFile(new URL("../src/schedule-controls-runtime.js", import.meta.url), "utf8");
const sharedHistorySource = await readFile(new URL("../src/schedule-run-history-mutation.js", import.meta.url), "utf8");
for (const phrase of [
  "let scheduleRunHistoryMutation = null",
  "export async function withScheduleRunHistoryMutation(work)",
  "const previous = scheduleRunHistoryMutation || Promise.resolve()",
  "if (scheduleRunHistoryMutation === current) scheduleRunHistoryMutation = null"
]) assert.ok(sharedHistorySource.includes(phrase), `Shared cross-module schedule-run history serialization contract missing: ${phrase}`);
assert.ok(runtimeSource.includes('from "./schedule-run-history-mutation.js"'), "Schedule runtime must use the shared cross-module run-history mutex.");
assert.ok(controlsSource.includes('from "./schedule-run-history-mutation.js"'), "Schedule control runtime must use the same shared cross-module run-history mutex.");
assert.ok(runtimeSource.includes("return withScheduleRunHistoryMutation(async () =>"), "Scheduled run receipt mutations must execute under the shared run-history mutex.");
assert.ok(controlsSource.includes("await withScheduleRunHistoryMutation(async () =>"), "Run-now receipt creation must execute under the shared run-history mutex.");
assert.ok(controlsSource.includes("return withScheduleRunHistoryMutation(async () =>"), "Run-now receipt cleanup must execute under the shared run-history mutex.");
assert.equal(runtimeSource.includes("let runHistoryMutation = null"), false, "Schedule runtime must not retain an isolated module-local run-history queue.");
const sharedStateSource = await readFile(new URL("../src/schedule-state-mutation.js", import.meta.url), "utf8");
for (const phrase of [
  "let scheduleStateMutation = null",
  "export async function withScheduleStateMutation(work)",
  "const previous = scheduleStateMutation || Promise.resolve()",
  "if (scheduleStateMutation === current) scheduleStateMutation = null"
]) assert.ok(sharedStateSource.includes(phrase), `Shared schedule-state serialization contract missing: ${phrase}`);
assert.ok(runtimeSource.includes('from "./schedule-state-mutation.js"'), "Schedule runtime must use the shared cross-module schedule-state mutex.");
assert.ok(runtimeSource.includes("SCHEDULE_CHANGED_RETRY"), "Schedule runtime must still fail closed if a validated schedule snapshot changes before persistence.");

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Schedule-state hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Schedule-state hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew concurrent schedule run-history persistence checks passed.");
console.log("BrowserCrew shared schedule-state mutation checks passed.");