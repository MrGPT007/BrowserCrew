import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPreparedScheduleMetadata } from "../src/schedule-prepared-metadata.js";
import { createScheduleGrant } from "../src/schedule-grants-contract.js";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SCHEDULE_GRANTS_KEY = "browsercrew.scheduleGrants.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const origin = "https://example.test";
const createdAt = "2026-09-13T18:00:00.000Z";

const skill = {
  schemaVersion: 1,
  id: "run-now-edit-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify Run now edit race",
  description: "Test-only approved Skill for Run now versus schedule edit serialization.",
  inputs: {},
  allowedOrigins: [origin],
  allowedResources: [],
  actionClasses: ["read"],
  dataDestinations: [],
  providerRequirements: { capabilities: [] },
  budgets: { maxSteps: 5, maxMinutes: 5 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Verify ready state.", origin, expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "Ready state is visible.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt },
  approval: { approvedAt: createdAt, approvedBy: "user" },
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  createdAt,
  updatedAt: createdAt,
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
};

const prepared = createPreparedScheduleMetadata({ skill, pageUrl: `${origin}/ready`, reviewedAt: createdAt });
const grantReadySchedule = {
  schemaVersion: 1,
  id: "run-now-edit-race",
  name: "Run now edit race",
  enabled: false,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 23, minute: 55 },
  missedRunPolicy: "run_once_when_available",
  concurrencyPolicy: "skip_if_running",
  providerRef: "local-a",
  grantRefs: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  ...structuredClone(prepared),
  createdAt,
  updatedAt: createdAt,
  lastRunAt: null,
  nextRunAt: null
};
const grant = createScheduleGrant({
  id: "schedule-grant:run-now-edit-race",
  schedule: grantReadySchedule,
  skill,
  createdAt,
  expiresAt: "2027-09-13T18:00:00.000Z"
});
const schedule = {
  ...structuredClone(grantReadySchedule),
  enabled: true,
  grantRefs: [grant.id],
  nextRunAt: new Date(Date.now() + 60_000).toISOString()
};

const clone = (value) => structuredClone(value);
const storage = new Map([
  [SCHEDULES_KEY, [clone(schedule)]],
  [SCHEDULE_RUNS_KEY, []],
  [SCHEDULE_GRANTS_KEY, [clone(grant)]],
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
const preflightSchedules = [];
const dispatchedSchedules = [];
const runtime = await import("../src/schedules-runtime.js");
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    if (input.mode === "preflight") {
      preflightCount += 1;
      preflightSchedules.push(clone(input.schedule));
      return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    }
    taskDispatchCount += 1;
    dispatchedSchedules.push(clone(input.schedule));
    return { ok: true, taskId: "task-run-now-edit-race" };
  }
});
const controls = await import("../src/schedule-controls-runtime.js");

assert.equal(listeners.alarm.length, 1, "Scheduler boot must expose one alarm listener before Run now edit-race testing.");
assert.ok(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), "Enabled test schedule must have its exact live alarm before Run now starts.");

const barrier = armManualReceiptWriteBarrier();
const runNowPromise = controls.runScheduleNow(schedule.id);
await barrier.entered;

const pendingRuns = await runtime.listScheduleRuns(schedule.id);
assert.equal(pendingRuns.length, 1, "Run now must durably create exactly one manual receipt before its review claim.");
assert.equal(pendingRuns[0].trigger, "manual");
assert.equal(pendingRuns[0].status, "needs_review", "The held manual receipt must still be waiting for its atomic review claim.");

const beforeEdit = (await runtime.listSchedules()).find((item) => item.id === schedule.id);
const editResult = await runtime.saveSchedule({ ...beforeEdit, concurrencyPolicy: "queue_one" });
assert.equal(editResult.schedule.enabled, true, "A supported edit must leave the schedule enabled.");
assert.equal(editResult.schedule.concurrencyPolicy, "queue_one", "The edit must durably change the schedule execution policy before Run now resumes.");
assert.ok(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), "A supported edit must preserve the live schedule alarm.");

barrier.release();
const runNowResult = await runNowPromise;

assert.equal(preflightCount, 0, "Run now must not preflight after a meaningful same-schedule edit commits before its review claim.");
assert.equal(taskDispatchCount, 0, "Run now must not dispatch after a meaningful same-schedule edit commits before its review claim.");
assert.equal(runNowResult.ok, false, "The stale Run now request must fail closed after a meaningful schedule edit wins the race.");
assert.equal(runNowResult.run?.status, "blocked", "The stale manual receipt must become terminally blocked rather than silently adopt the edited schedule.");
assert.equal(runNowResult.run?.reason, "SCHEDULE_CHANGED_RETRY", "The stale manual receipt must require review of the latest schedule before retrying.");
assert.ok(runNowResult.run?.completedAt, "The blocked manual receipt must retain a durable completion timestamp.");

const runsAfterEdit = await runtime.listScheduleRuns(schedule.id);
assert.equal(runsAfterEdit.length, 1, "The Run now/edit race must retain exactly one durable manual receipt.");
assert.equal(runsAfterEdit[0].status, "blocked");
assert.equal(runsAfterEdit[0].reason, "SCHEDULE_CHANGED_RETRY");
const editedSchedule = (await runtime.listSchedules()).find((item) => item.id === schedule.id);
assert.equal(editedSchedule?.enabled, true, "Failing the stale Run now request must not disable the edited schedule.");
assert.equal(editedSchedule?.concurrencyPolicy, "queue_one", "Failing the stale Run now request must preserve the user's committed edit.");
assert.ok(await chrome.alarms.get(`browsercrew.schedule.${schedule.id}`), "Failing the stale Run now request must not clear the edited schedule's alarm.");
assert.equal(preflightSchedules.length, 0, "No edited schedule snapshot may reach preflight from the stale manual request.");
assert.equal(dispatchedSchedules.length, 0, "No edited schedule snapshot may reach task dispatch from the stale manual request.");

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Run now/edit hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Run now/edit hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew Run now versus schedule edit race regression checks passed.");
