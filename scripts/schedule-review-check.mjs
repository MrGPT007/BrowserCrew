import assert from "node:assert/strict";

const storage = new Map();
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();

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
        return Object.fromEntries(wanted.filter((key) => storage.has(key)).map((key) => [key, structuredClone(storage.get(key))]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
      }
    }
  },
  alarms: {
    onAlarm: { addListener(listener) { listeners.alarm.push(listener); } },
    async create(name, spec) { alarms.set(name, { name, scheduledTime: spec.when || Date.now(), ...spec }); },
    async clear(name) { return alarms.delete(name); },
    async get(name) { return alarms.get(name) || null; },
    async getAll() { return [...alarms.values()]; }
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
storage.set(SCHEDULE_RUNS_KEY, [missed("skip-me"), missed("run-me")]);

const runtime = await import("../src/schedules-runtime.js");

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

const dispatchCalls = [];
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    dispatchCalls.push(structuredClone(input));
    if (input.mode === "preflight") return { grantsValid: true, providerAvailable: true, resourceFresh: true };
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
await assert.rejects(
  runtime.reviewMissedScheduleRun("skip-me", "anything"),
  (error) => error?.code === "SCHEDULE_REVIEW_DECISION_INVALID"
);

console.log("BrowserCrew missed schedule review lifecycle checks passed.");
