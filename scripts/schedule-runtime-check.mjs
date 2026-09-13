import assert from "node:assert/strict";

const storage = new Map();
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
const alarms = new Map();
const alarmCreates = [];
const alarmClears = [];

const clone = (value) => structuredClone(value);

globalThis.chrome = {
  runtime: {
    onConnect: { addListener(listener) { listeners.connect.push(listener); } },
    onStartup: { addListener(listener) { listeners.startup.push(listener); } },
    onInstalled: { addListener(listener) { listeners.installed.push(listener); } }
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
    onAlarm: { addListener(listener) { listeners.alarm.push(listener); } },
    async create(name, spec) {
      const alarm = { name, scheduledTime: spec.when || Date.now(), ...clone(spec) };
      alarms.set(name, alarm);
      alarmCreates.push(clone(alarm));
    },
    async clear(name) {
      alarmClears.push(name);
      return alarms.delete(name);
    },
    async get(name) { return clone(alarms.get(name) || null); },
    async getAll() { return clone([...alarms.values()]); }
  }
};

const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const origin = "https://example.test";
const skill = {
  schemaVersion: 1,
  id: "scheduler-lifecycle-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify scheduler lifecycle",
  description: "Test-only exact approved skill for the scheduler lifecycle.",
  inputs: {},
  allowedOrigins: [origin],
  actionClasses: ["read"],
  dataDestinations: [],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Verify ready state.", origin, expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "Ready state is visible.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-12T00:00:00.000Z" },
  approval: { approvedAt: "2026-09-12T00:01:00.000Z", approvedBy: "user" }
};

function schedule(id, overrides = {}) {
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
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides
  };
}

const now = Date.now();
const schedules = [
  schedule("success-daily"),
  schedule("revoked-grant"),
  schedule("stale-resource"),
  schedule("provider-down"),
  schedule("task-paused"),
  schedule("task-cancelled"),
  schedule("paused-job", { enabled: false, nextRunAt: null }),
  schedule("one-time-job", { recurrence: { kind: "once", when: now + 60 * 60_000 } })
];
storage.set(SKILL_LIBRARY_KEY, [skill]);
storage.set(SCHEDULES_KEY, schedules);
storage.set(SCHEDULE_RUNS_KEY, []);
alarms.set("browsercrew.schedule.orphan", { name: "browsercrew.schedule.orphan", scheduledTime: now + 10_000 });
alarms.set("browsercrew.schedule.paused-job", { name: "browsercrew.schedule.paused-job", scheduledTime: now + 20_000 });

const dispatchCalls = [];
const taskCalls = [];
const runtime = await import("../src/schedules-runtime.js");
await runtime.bootSchedulesRuntime({
  async dispatch(input) {
    dispatchCalls.push(clone(input));
    if (input.mode === "preflight") {
      if (input.schedule.id === "revoked-grant") return { grantsValid: false, providerAvailable: true, resourceFresh: true };
      if (input.schedule.id === "stale-resource") return { grantsValid: true, providerAvailable: true, resourceFresh: false };
      if (input.schedule.id === "provider-down") return { grantsValid: true, providerAvailable: false, resourceFresh: true };
      return { grantsValid: true, providerAvailable: true, resourceFresh: true };
    }
    taskCalls.push(clone(input));
    const taskId = `task-${input.schedule.id}-${taskCalls.length}`;
    if (input.schedule.id === "task-paused") {
      return { ok: false, task: { id: taskId, status: "paused", error: { code: "TASK_PAUSED" } }, error: { code: "TASK_PAUSED" } };
    }
    if (input.schedule.id === "task-cancelled") {
      return { ok: false, task: { id: taskId, status: "cancelled", error: { code: "TASK_CANCELLED" } }, error: { code: "TASK_CANCELLED" } };
    }
    return { ok: true, taskId };
  }
});

assert.equal(listeners.alarm.length, 1, "Scheduler boot must install exactly one alarm listener.");
assert.equal(listeners.startup.length, 1, "Scheduler boot must install one startup reconciliation listener.");
assert.equal(taskCalls.length, 0, "Boot/reconciliation must never dispatch a task.");
assert.equal(alarms.has("browsercrew.schedule.orphan"), false, "Restart reconciliation must clear stale BrowserCrew alarms.");
assert.equal(alarms.has("browsercrew.schedule.paused-job"), false, "Paused schedules must not retain an alarm.");
for (const item of schedules.filter((candidate) => candidate.enabled)) {
  assert.equal(alarms.has(`browsercrew.schedule.${item.id}`), true, `Boot must recreate the alarm for ${item.id}.`);
}
const enabledCount = schedules.filter((item) => item.enabled).length;
assert.equal(alarms.size, enabledCount, "Reconciliation must leave exactly one alarm per enabled schedule.");

await listeners.startup[0]();
assert.equal(taskCalls.length, 0, "Service-worker restart reconciliation must not dispatch work by itself.");
assert.equal(alarms.size, enabledCount, "Repeated restart reconciliation must not create duplicate alarm state.");
assert.equal(new Set([...alarms.keys()]).size, enabledCount);

const alarmListener = listeners.alarm[0];
const countTasksFor = (id) => taskCalls.filter((call) => call.schedule?.id === id).length;
const runsFor = async (id) => (await runtime.listScheduleRuns(id));

const forgedLastRunAt = "2040-01-01T00:00:00.000Z";
const trustedLastRunAt = "2026-09-12T12:34:56.000Z";
const metadataCreate = await runtime.saveSchedule(schedule("metadata-history", {
  enabled: false,
  nextRunAt: null,
  lastRunAt: forgedLastRunAt
}));
assert.equal(metadataCreate.schedule.lastRunAt, null, "New schedule saves must ignore caller-supplied lastRunAt history.");
let metadataSchedules = await runtime.listSchedules();
const metadataIndex = metadataSchedules.findIndex((item) => item.id === "metadata-history");
assert.ok(metadataIndex >= 0, "Metadata-history fixture must be persisted before edit testing.");
metadataSchedules[metadataIndex] = { ...metadataSchedules[metadataIndex], lastRunAt: trustedLastRunAt };
await chrome.storage.local.set({ [SCHEDULES_KEY]: metadataSchedules });
const metadataEdit = await runtime.saveSchedule({
  ...metadataCreate.schedule,
  name: "metadata history edited",
  lastRunAt: forgedLastRunAt
});
assert.equal(metadataEdit.schedule.lastRunAt, trustedLastRunAt, "Schedule edits must preserve runtime-owned stored lastRunAt history.");

const pausedBefore = (await runtime.listScheduleRuns()).length;
await alarmListener({ name: "browsercrew.schedule.paused-job", scheduledTime: Date.now() });
assert.equal((await runtime.listScheduleRuns()).length, pausedBefore, "A disabled schedule alarm callback must create no receipt.");
assert.equal(countTasksFor("paused-job"), 0, "A disabled schedule must dispatch zero tasks.");

const successScheduledTime = Date.now();
await consumeAndFire("success-daily", successScheduledTime);
let successRuns = await runsFor("success-daily");
assert.equal(successRuns.length, 1);
assert.equal(successRuns[0].status, "completed");
assert.match(successRuns[0].taskId, /^task-success-daily-/);
assert.equal(successRuns[0].scheduleId, "success-daily");
assert.deepEqual(successRuns[0].skillRef, { id: skill.id, version: skill.version });
assert.equal(successRuns[0].scheduledFor, new Date(successScheduledTime).toISOString());
assert.ok(successRuns[0].firedAt);
assert.ok(Number.isFinite(successRuns[0].latenessMs));
assert.equal(countTasksFor("success-daily"), 1, "One scheduled occurrence must dispatch exactly one task.");
assert.equal(alarms.has("browsercrew.schedule.success-daily"), true, "Recurring calendar run must recreate exactly one future alarm.");

await listeners.startup[0]();
assert.equal(countTasksFor("success-daily"), 1, "Restart reconciliation after a run must not replay it.");
await alarmListener({ name: "browsercrew.schedule.success-daily", scheduledTime: successScheduledTime });
successRuns = await runsFor("success-daily");
assert.equal(successRuns.length, 1, "Duplicate delivery of the same scheduled occurrence must reuse durable history rather than creating another receipt.");
assert.equal(countTasksFor("success-daily"), 1, "Duplicate delivery after restart must dispatch zero additional tasks.");

await consumeAndFire("revoked-grant", Date.now());
const revokedRuns = await runsFor("revoked-grant");
assert.equal(revokedRuns.length, 1);
assert.equal(revokedRuns[0].status, "blocked");
assert.equal(revokedRuns[0].reason, "SCHEDULE_GRANT_INVALID");
assert.equal(countTasksFor("revoked-grant"), 0, "Revoked/expired grant preflight must block before task dispatch.");

await consumeAndFire("stale-resource", Date.now());
const staleRuns = await runsFor("stale-resource");
assert.equal(staleRuns.length, 1);
assert.equal(staleRuns[0].status, "blocked");
assert.equal(staleRuns[0].reason, "SCHEDULE_RESOURCE_STALE");
assert.equal(countTasksFor("stale-resource"), 0, "Stale selected resource must block before task dispatch.");

await consumeAndFire("provider-down", Date.now());
const providerRuns = await runsFor("provider-down");
assert.equal(providerRuns.length, 1);
assert.equal(providerRuns[0].status, "blocked");
assert.equal(providerRuns[0].reason, "SCHEDULE_PROVIDER_UNAVAILABLE");
assert.equal(countTasksFor("provider-down"), 0, "Unavailable configured provider must block before task dispatch.");

await consumeAndFire("task-paused", Date.now());
const pausedTaskRuns = await runsFor("task-paused");
assert.equal(pausedTaskRuns.length, 1);
assert.equal(pausedTaskRuns[0].status, "paused", "A normal BrowserCrew task paused by the user must stay paused in schedule history.");
assert.equal(pausedTaskRuns[0].reason, "TASK_PAUSED");
assert.match(pausedTaskRuns[0].taskId, /^task-task-paused-/);

await consumeAndFire("task-cancelled", Date.now());
const cancelledTaskRuns = await runsFor("task-cancelled");
assert.equal(cancelledTaskRuns.length, 1);
assert.equal(cancelledTaskRuns[0].status, "cancelled", "A normal BrowserCrew task stopped by the user must stay cancelled in schedule history.");
assert.equal(cancelledTaskRuns[0].reason, "TASK_CANCELLED");
assert.match(cancelledTaskRuns[0].taskId, /^task-task-cancelled-/);

const oneTimeScheduledTime = Date.now();
await consumeAndFire("one-time-job", oneTimeScheduledTime);
const oneRuns = await runsFor("one-time-job");
assert.equal(oneRuns.length, 1);
assert.equal(oneRuns[0].status, "completed");
assert.match(oneRuns[0].taskId, /^task-one-time-job-/);
const persisted = await runtime.listSchedules();
const oneTime = persisted.find((item) => item.id === "one-time-job");
assert.equal(oneTime.enabled, false, "Consumed one-time schedule must auto-disable.");
assert.equal(oneTime.nextRunAt, null, "Consumed one-time schedule must not advertise another run.");
assert.equal(alarms.has("browsercrew.schedule.one-time-job"), false, "Consumed one-time schedule must have no future alarm.");

const actualTasks = taskCalls.map((call) => call.schedule.id);
assert.deepEqual(actualTasks.sort(), ["one-time-job", "success-daily", "task-paused", "task-cancelled"].sort(), "Only fully preflighted schedules may reach task dispatch.");
assert.ok(dispatchCalls.some((call) => call.mode === "preflight" && call.schedule.id === "revoked-grant"));
assert.ok(dispatchCalls.some((call) => call.mode === "preflight" && call.schedule.id === "stale-resource"));
assert.ok(dispatchCalls.some((call) => call.mode === "preflight" && call.schedule.id === "provider-down"));
assert.ok(alarmClears.includes("browsercrew.schedule.orphan"));
assert.ok(alarmCreates.length >= enabledCount, "Scheduler reconciliation must recreate persisted enabled alarms.");

const fs = await import("node:fs/promises");
const runtimeSource = await fs.readFile(new URL("../src/schedules-runtime.js", import.meta.url), "utf8");
for (const phrase of [
  "const scheduledFor = new Date(scheduledTime).toISOString()",
  "run.scheduledFor === receipt.scheduledFor",
  "if (duplicate) return",
  "next.lastRunAt = current ? current.lastRunAt ?? null : null",
  "assertScheduleTargetUnchanged(current, existingSnapshot)",
  'status: "paused", reason: "TASK_PAUSED"',
  'status: "cancelled", reason: "TASK_CANCELLED"'
]) assert.ok(runtimeSource.includes(phrase), `Persistent scheduler contract missing: ${phrase}`);

const manifest = JSON.parse(await fs.readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "The active v0.2 manifest must remain free of alarms permission.");
const serviceWorkerSource = await fs.readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(serviceWorkerSource.includes("bootSchedulesRuntime"), false, "Production service-worker boot must remain disabled until the post-v0.2 scheduling release.");
const backgroundSource = await fs.readFile(new URL("../src/background.js", import.meta.url), "utf8");
assert.ok(backgroundSource.includes("export async function runTask(payload)"), "The normal BrowserCrew task engine must expose an explicit dispatcher entry for bounded scheduler handoff testing and future activation.");

console.log("BrowserCrew schedule runtime restart, dedupe, preflight, task-control outcome, and receipt lifecycle checks passed.");

async function consumeAndFire(scheduleId, scheduledTime) {
  const name = `browsercrew.schedule.${scheduleId}`;
  const current = alarms.get(name) || { name, scheduledTime };
  if (!current.periodInMinutes) alarms.delete(name); // Chrome consumes one-shot alarms before delivery.
  await alarmListener({ ...clone(current), name, scheduledTime });
}
