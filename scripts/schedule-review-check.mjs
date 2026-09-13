import assert from "node:assert/strict";

const storage = new Map();
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();
const alarmsApi = {
  onAlarm: {
    addListener(listener) { listeners.alarm.push(listener); },
    hasListeners() { return listeners.alarm.length > 0; }
  },
  async create(name, spec) { alarms.set(name, { name, scheduledTime: spec.when || Date.now(), ...spec }); },
  async clear(name) { return alarms.delete(name); },
  async get(name) { return alarms.get(name) || null; },
  async getAll() { return [...alarms.values()]; }
};

let concurrentReviewBarrier = null;
let concurrentReviewBarrierRelease = null;
let concurrentReviewReads = 0;
let concurrentReviewBarrierEnabled = false;
let manualQueueBarrier = null;

function armConcurrentReviewReadBarrier() {
  concurrentReviewReads = 0;
  concurrentReviewBarrierEnabled = true;
  concurrentReviewBarrier = new Promise((resolve) => { concurrentReviewBarrierRelease = resolve; });
}

function armManualQueueDispatchBarrier() {
  let startedResolve = null;
  let releaseResolve = null;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  manualQueueBarrier = { claimed: false, startedResolve, release, releaseResolve };
  return { started, release: () => releaseResolve() };
}

globalThis.chrome = {
  runtime: {
    onConnect: { addListener(listener) { listeners.connect.push(listener); } },
    onStartup: { addListener(listener) { listeners.startup.push(listener); } },
    onInstalled: { addListener(listener) { listeners.installed.push(listener); } }
  },
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return Object.fromEntries(storage);
        const wanted = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        const result = Object.fromEntries(wanted.filter((key) => storage.has(key)).map((key) => [key, structuredClone(storage.get(key))]));
        if (concurrentReviewBarrierEnabled && wanted.includes("browsercrew.scheduleRuns.v1") && wanted.includes("browsercrew.schedules.v1")) {
          concurrentReviewBarrierEnabled = false;
          concurrentReviewBarrierRelease();
        }
        if (concurrentReviewBarrierEnabled && wanted.length === 1 && wanted[0] === "browsercrew.scheduleRuns.v1") {
          const gate = concurrentReviewBarrier;
          concurrentReviewReads += 1;
          if (concurrentReviewReads === 2) {
            concurrentReviewBarrierEnabled = false;
            concurrentReviewBarrierRelease();
          }
          await gate;
        }
        return result;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
      }
    }
  }
};

const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const origin = "https://example.test";

const approvedSkill = {
  schemaVersion: 1,
  id: "scheduled-review-skill",
  version: "1.0.0",
  status: "approved",
  title: "Check scheduled review",
  description: "Verify a deterministic page state.",
  inputs: {},
  allowedOrigins: [origin],
  actionClasses: ["read"],
  dataDestinations: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Confirm the reviewed page is ready.", origin, expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "The page is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-12T00:00:00.000Z" },
  approval: { approvedAt: "2026-09-12T00:01:00.000Z", approvedBy: "user" }
};

const schedule = {
  schemaVersion: 1,
  id: "daily-review",
  name: "Daily review",
  enabled: true,
  skillRef: { id: approvedSkill.id, version: approvedSkill.version },
  timezone: "Asia/Kolkata",
  recurrence: { kind: "daily", hour: 9, minute: 30 },
  missedRunPolicy: "ask",
  concurrencyPolicy: "skip_if_running",
  providerRef: "local-a",
  grantRefs: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z"
};

const missed = (id) => ({
  id,
  schemaVersion: 1,
  scheduleId: schedule.id,
  skillRef: schedule.skillRef,
  scheduledFor: "2026-09-12T03:00:00.000Z",
  firedAt: "2026-09-12T03:10:00.000Z",
  latenessMs: 600_000,
  missed: true,
  missedAction: "ask",
  status: "needs_review",
  reason: "SCHEDULE_MISSED_REVIEW_REQUIRED",
  reviewRequestedAt: "2026-09-12T03:10:00.000Z",
  taskId: null
});

storage.set(SKILL_LIBRARY_KEY, [approvedSkill]);
storage.set(SCHEDULES_KEY, [schedule]);
storage.set(SCHEDULE_RUNS_KEY, [missed("skip-me"), missed("run-me"), missed("race-me")]);

const runtime = await import("../src/schedules-runtime.js");

// Prepared schedules are durable drafts and must not require chrome.alarms.
// This keeps post-v0.2 setup work separate from the v0.2 manifest boundary.
const preparedDraft = {
  schemaVersion: 1,
  id: "prepared-weekly-review",
  name: "Prepared weekly review",
  enabled: false,
  skillRef: { id: approvedSkill.id, version: approvedSkill.version },
  timezone: "Asia/Kolkata",
  recurrence: { kind: "weekly", weekday: 1, hour: 10, minute: 15 },
  missedRunPolicy: "ask",
  concurrencyPolicy: "queue_one",
  providerRef: "local-a",
  grantRefs: [],
  budgets: { maxSteps: 5, maxMinutes: 5 }
};
assert.equal(chrome.alarms, undefined, "Prepared-schedule CRUD test must begin without the alarms API.");
const createdDraft = await runtime.saveSchedule(preparedDraft);
assert.equal(createdDraft.ok, true);
assert.equal(createdDraft.schedule.enabled, false);
assert.equal(createdDraft.schedule.nextRunAt, null);
assert.ok(createdDraft.schedule.createdAt);
assert.ok(createdDraft.schedule.updatedAt);
const preparedCreatedAt = createdDraft.schedule.createdAt;

const updatedDraft = await runtime.saveSchedule({
  ...createdDraft.schedule,
  name: "Prepared daily review",
  recurrence: { kind: "daily", hour: 8, minute: 45 }
});
assert.equal(updatedDraft.ok, true);
assert.equal(updatedDraft.schedule.enabled, false);
assert.equal(updatedDraft.schedule.nextRunAt, null);
assert.equal(updatedDraft.schedule.createdAt, preparedCreatedAt, "Updating a prepared schedule must preserve its creation timestamp.");
assert.equal(updatedDraft.schedule.name, "Prepared daily review");

await assert.rejects(
  runtime.setScheduleEnabled(preparedDraft.id, true),
  (error) => error?.code === "ALARMS_PERMISSION_REQUIRED"
);
await assert.rejects(
  runtime.saveSchedule({ ...updatedDraft.schedule, enabled: true }),
  (error) => error?.code === "ALARMS_PERMISSION_REQUIRED"
);
let schedules = await runtime.listSchedules();
let persistedDraft = schedules.find((item) => item.id === preparedDraft.id);
assert.equal(persistedDraft?.enabled, false, "Failed activation must not mutate the prepared schedule.");
assert.equal(persistedDraft?.name, "Prepared daily review");

const pausedDraft = await runtime.setScheduleEnabled(preparedDraft.id, false);
assert.equal(pausedDraft.ok, true);
assert.equal(pausedDraft.schedule.enabled, false);
assert.equal(pausedDraft.schedule.nextRunAt, null);
const deletedDraft = await runtime.deleteSchedule(preparedDraft.id);
assert.equal(deletedDraft.ok, true);
schedules = await runtime.listSchedules();
assert.equal(schedules.some((item) => item.id === preparedDraft.id), false, "Prepared schedule must be deletable without alarms permission.");

const manualQueueSchedule = {
  ...schedule,
  id: "manual-queue",
  name: "Manual queue",
  concurrencyPolicy: "queue_one",
  createdAt: "2026-09-12T00:02:00.000Z",
  updatedAt: "2026-09-12T00:02:00.000Z"
};
await chrome.storage.local.set({ [SCHEDULES_KEY]: [...schedules, manualQueueSchedule] });

const skipped = await runtime.reviewMissedScheduleRun("skip-me", "skip");
assert.equal(skipped.ok, true);
assert.equal(skipped.run.status, "skipped");
assert.equal(skipped.run.reason, "SCHEDULE_MISSED_USER_SKIPPED");
assert.equal(skipped.run.reviewDecision, "skip");
assert.ok(skipped.run.reviewedAt);

await assert.rejects(
  runtime.reviewMissedScheduleRun("run-me", "run_once"),
  (error) => error?.code === "SCHEDULE_DISPATCH_REQUIRED" && error?.run?.status === "needs_review"
);
let runs = (await chrome.storage.local.get(SCHEDULE_RUNS_KEY))[SCHEDULE_RUNS_KEY];
let pending = runs.find((run) => run.id === "run-me");
assert.equal(pending.status, "needs_review");
assert.equal(pending.reason, "SCHEDULE_DISPATCH_REQUIRED");
assert.equal(pending.reviewDecision, "run_once");

// Only the future scheduler-enabled release supplies chrome.alarms and boots dispatch.
chrome.alarms = alarmsApi;
const dispatchCalls = [];
let manualQueueActiveDispatches = 0;
let manualQueueMaxActiveDispatches = 0;
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    dispatchCalls.push(structuredClone(input));
    if (input.mode === "preflight") return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    if (input.schedule?.id === manualQueueSchedule.id) {
      manualQueueActiveDispatches += 1;
      manualQueueMaxActiveDispatches = Math.max(manualQueueMaxActiveDispatches, manualQueueActiveDispatches);
      try {
        if (manualQueueBarrier && !manualQueueBarrier.claimed) {
          manualQueueBarrier.claimed = true;
          manualQueueBarrier.startedResolve();
          await manualQueueBarrier.release;
        }
        return { ok: true, taskId: `task-manual-queue-${dispatchCalls.length}` };
      } finally {
        manualQueueActiveDispatches -= 1;
      }
    }
    return { ok: true, taskId: "task-scheduled-review-001" };
  }
});

const completed = await runtime.reviewMissedScheduleRun("run-me", "run_once");
assert.equal(completed.ok, true);
assert.equal(completed.run.status, "completed");
assert.equal(completed.run.taskId, "task-scheduled-review-001");
assert.equal(completed.run.reviewDecision, "run_once");
assert.ok(completed.run.reviewedAt);
assert.equal(dispatchCalls.length, 2, "Reviewed run-once must perform exactly one fresh preflight and one task dispatch.");
assert.equal(dispatchCalls[0].mode, "preflight");
assert.equal(dispatchCalls[1].scheduleRunId, "run-me");
assert.equal(dispatchCalls[1].skill.id, approvedSkill.id);

runs = (await chrome.storage.local.get(SCHEDULE_RUNS_KEY))[SCHEDULE_RUNS_KEY];
assert.equal(runs.find((run) => run.id === "run-me")?.status, "completed");

await assert.rejects(
  runtime.reviewMissedScheduleRun("run-me", "run_once"),
  (error) => error?.code === "SCHEDULE_REVIEW_NOT_PENDING"
);

const dispatchBaseline = dispatchCalls.length;
armConcurrentReviewReadBarrier();
const concurrentReviews = await Promise.allSettled([
  runtime.reviewMissedScheduleRun("race-me", "run_once"),
  runtime.reviewMissedScheduleRun("race-me", "run_once")
]);
const fulfilledReviews = concurrentReviews.filter((result) => result.status === "fulfilled");
const rejectedReviews = concurrentReviews.filter((result) => result.status === "rejected");
assert.equal(fulfilledReviews.length, 1, "Concurrent reviewers must claim one missed receipt exactly once.");
assert.equal(rejectedReviews.length, 1, "The second concurrent reviewer must fail closed after the receipt is claimed.");
assert.equal(rejectedReviews[0].reason?.code, "SCHEDULE_REVIEW_NOT_PENDING", "The losing concurrent reviewer must observe that review is no longer pending.");
assert.equal(dispatchCalls.length, dispatchBaseline + 2, "One claimed missed receipt may perform only one preflight and one task dispatch.");
runs = (await chrome.storage.local.get(SCHEDULE_RUNS_KEY))[SCHEDULE_RUNS_KEY];
assert.equal(runs.find((run) => run.id === "race-me")?.status, "completed", "The single claimed concurrent review must leave one completed durable receipt.");

const controls = await import("../src/schedule-controls-runtime.js");
const manualDispatchBaseline = dispatchCalls.filter((call) => call.schedule?.id === manualQueueSchedule.id && call.mode !== "preflight").length;
const manualBarrier = armManualQueueDispatchBarrier();
const firstManualRunPromise = controls.runScheduleNow(manualQueueSchedule.id);
await manualBarrier.started;
const secondManualRun = await controls.runScheduleNow(manualQueueSchedule.id);
assert.equal(secondManualRun.ok, true, "The second Run now request may be accepted into the one-item queue.");
assert.equal(secondManualRun.queued, true, "The second Run now request must be durably queued while the first dispatch is active.");
assert.equal(secondManualRun.run.status, "queued");
manualBarrier.release();
const firstManualRun = await firstManualRunPromise;
assert.equal(firstManualRun.ok, true);
assert.equal(firstManualRun.run.status, "completed");

runs = (await chrome.storage.local.get(SCHEDULE_RUNS_KEY))[SCHEDULE_RUNS_KEY];
const manualRuns = runs.filter((run) => run.scheduleId === manualQueueSchedule.id && run.trigger === "manual");
assert.equal(manualRuns.length, 2, "Both manual Run now requests must retain durable receipts.");
assert.equal(manualRuns.filter((run) => run.status === "completed").length, 2, "A queued manual Run now receipt must drain automatically after the active manual dispatch completes.");
assert.equal(manualRuns.filter((run) => run.status === "queued").length, 0, "No manual queue receipt may remain stranded after the schedule slot becomes free.");
const manualTaskCalls = dispatchCalls.filter((call) => call.schedule?.id === manualQueueSchedule.id && call.mode !== "preflight");
assert.equal(manualTaskCalls.length, manualDispatchBaseline + 2, "Two accepted manual Run now requests must produce exactly two sequential task dispatches.");
assert.equal(manualQueueMaxActiveDispatches, 1, "queue_one manual runs must never overlap task dispatch.");

await assert.rejects(
  runtime.reviewMissedScheduleRun("skip-me", "anything"),
  (error) => error?.code === "SCHEDULE_REVIEW_DECISION_INVALID"
);

console.log("BrowserCrew prepared schedule CRUD and missed schedule review lifecycle checks passed.");
