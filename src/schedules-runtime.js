import {
  alarmName,
  assertScheduleDispatchable,
  decideMissedRun,
  decideScheduleConcurrency,
  nextCalendarRun,
  reconcileAlarmNames,
  toChromeAlarmSpec,
  validateSchedule
} from "./schedules-contract.js";
import { getSkillVersion } from "./skills-runtime.js";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const MAX_SCHEDULES = 100;
const MAX_RUN_RECEIPTS = 500;
const ALARM_PREFIX = "browsercrew.schedule.";
let booted = false;
let dispatchScheduledRun = null;

export async function bootSchedulesRuntime({ dispatch } = {}) {
  if (booted) return;
  if (!chrome.alarms?.onAlarm) throw coded("ALARMS_PERMISSION_REQUIRED", "Scheduling needs Chrome's alarms permission. Enable it only in the BrowserCrew release that ships schedules.");
  if (typeof dispatch !== "function") throw coded("SCHEDULE_DISPATCH_REQUIRED", "The schedule runtime needs BrowserCrew's normal task dispatcher.");
  dispatchScheduledRun = dispatch;
  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.runtime.onStartup.addListener(() => reconcileScheduleAlarms().catch(() => {}));
  chrome.runtime.onInstalled.addListener(() => reconcileScheduleAlarms().catch(() => {}));
  await reconcileScheduleAlarms();
  booted = true;
}

export async function listSchedules() {
  const data = await chrome.storage.local.get(SCHEDULES_KEY);
  return Array.isArray(data[SCHEDULES_KEY]) ? data[SCHEDULES_KEY] : [];
}

export async function saveSchedule(input) {
  requireAlarmsApi();
  const schedule = structuredClone(input || {});
  const validation = validateSchedule(schedule);
  if (!validation.ok) throw coded("SCHEDULE_INVALID", validation.errors.join(" "));
  const skillResult = await getSkillVersion(schedule.skillRef.id, schedule.skillRef.version);
  if (!skillResult.ok) throw coded("SCHEDULE_SKILL_NOT_FOUND", "Choose an existing approved skill version before saving this schedule.");
  assertScheduleDispatchable({ ...schedule, enabled: true }, skillResult.skill, {
    activeRun: false,
    grantsValid: true,
    providerAvailable: true,
    resourceFresh: true
  });

  const schedules = await listSchedules();
  const index = schedules.findIndex((item) => item.id === schedule.id);
  if (index < 0 && schedules.length >= MAX_SCHEDULES) throw coded("SCHEDULE_LIMIT", `BrowserCrew can keep up to ${MAX_SCHEDULES} schedules in this build.`);
  const now = new Date().toISOString();
  schedule.createdAt = index >= 0 ? schedules[index].createdAt : schedule.createdAt || now;
  schedule.updatedAt = now;
  schedule.nextRunAt = schedule.enabled ? new Date(nextRun(schedule)).toISOString() : null;
  if (index >= 0) schedules[index] = schedule;
  else schedules.push(schedule);
  await persistSchedules(schedules);
  await syncOneAlarm(schedule);
  return { ok: true, schedule };
}

export async function setScheduleEnabled(scheduleId, enabled) {
  requireAlarmsApi();
  const schedules = await listSchedules();
  const index = schedules.findIndex((item) => item.id === scheduleId);
  if (index < 0) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
  const schedule = { ...schedules[index], enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  schedule.nextRunAt = schedule.enabled ? new Date(nextRun(schedule)).toISOString() : null;
  schedules[index] = schedule;
  await persistSchedules(schedules);
  await syncOneAlarm(schedule);
  return { ok: true, schedule };
}

export async function deleteSchedule(scheduleId) {
  requireAlarmsApi();
  const schedules = await listSchedules();
  const next = schedules.filter((item) => item.id !== scheduleId);
  if (next.length === schedules.length) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
  await persistSchedules(next);
  await chrome.alarms.clear(alarmName(scheduleId));
  return { ok: true };
}

export async function listScheduleRuns(scheduleId = null) {
  const data = await chrome.storage.local.get(SCHEDULE_RUNS_KEY);
  const runs = Array.isArray(data[SCHEDULE_RUNS_KEY]) ? data[SCHEDULE_RUNS_KEY] : [];
  return scheduleId ? runs.filter((run) => run.scheduleId === scheduleId) : runs;
}

export async function reconcileScheduleAlarms() {
  requireAlarmsApi();
  const schedules = await listSchedules();
  const alarms = await chrome.alarms.getAll();
  const changes = reconcileAlarmNames(schedules, alarms);
  for (const name of changes.clear) await chrome.alarms.clear(name);
  for (const schedule of schedules.filter((item) => item.enabled)) await syncOneAlarm(schedule);
  return { ok: true, createdOrUpdated: schedules.filter((item) => item.enabled).length, cleared: changes.clear.length };
}

async function syncOneAlarm(schedule) {
  const name = alarmName(schedule.id);
  await chrome.alarms.clear(name);
  if (!schedule.enabled) return;
  await chrome.alarms.create(name, toChromeAlarmSpec(schedule));
}

async function onAlarm(alarm) {
  if (!alarm?.name?.startsWith(ALARM_PREFIX)) return;
  const scheduleId = alarm.name.slice(ALARM_PREFIX.length);
  const schedules = await listSchedules();
  const schedule = schedules.find((item) => item.id === scheduleId);
  if (!schedule?.enabled) return;

  const firedAt = Date.now();
  const scheduledTime = Number.isFinite(alarm.scheduledTime) ? alarm.scheduledTime : firedAt;
  const missed = decideMissedRun(schedule, { scheduledTime, firedAt });
  const receipt = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    scheduleId,
    skillRef: schedule.skillRef,
    scheduledFor: new Date(scheduledTime).toISOString(),
    firedAt: new Date(firedAt).toISOString(),
    latenessMs: missed.latenessMs,
    missed: missed.missed,
    missedAction: missed.missed ? missedActionName(schedule, missed.action) : null,
    status: "checking",
    reason: null,
    taskId: null
  };
  await appendRunReceipt(receipt);

  if (missed.action === "skip") {
    await settleWithoutDispatch(receipt, "skipped", missed.reason);
    await advanceSchedule(scheduleId, firedAt);
    return;
  }
  if (missed.action === "review") {
    receipt.reviewRequestedAt = new Date().toISOString();
    await settleWithoutDispatch(receipt, "needs_review", missed.reason);
    await advanceSchedule(scheduleId, firedAt);
    return;
  }

  const priorRuns = await listScheduleRuns(scheduleId);
  const activeRun = priorRuns.some((run) => run.id !== receipt.id && ["checking", "running"].includes(run.status));
  const queuedRun = priorRuns.some((run) => run.id !== receipt.id && run.status === "queued");
  const concurrency = decideScheduleConcurrency(schedule, { activeRun, queuedRun });
  if (concurrency.action === "skip") {
    await settleWithoutDispatch(receipt, "skipped", concurrency.reason);
    await advanceSchedule(scheduleId, firedAt);
    return;
  }
  if (concurrency.action === "queue") {
    receipt.status = "queued";
    receipt.reason = concurrency.reason;
    receipt.queuedAt = new Date().toISOString();
    await updateRunReceipt(receipt);
    await advanceSchedule(scheduleId, firedAt);
    return;
  }

  try {
    await dispatchReceipt(schedule, receipt);
  } finally {
    await advanceSchedule(scheduleId, firedAt);
    await drainQueuedRun(scheduleId);
  }
}

async function dispatchReceipt(schedule, receipt) {
  try {
    const skillResult = await getSkillVersion(schedule.skillRef.id, schedule.skillRef.version);
    if (!skillResult.ok) throw coded("SCHEDULE_SKILL_NOT_FOUND", "The exact skill version for this schedule is no longer available.");

    const context = await resolveDispatchContext(schedule, skillResult.skill, false);
    assertScheduleDispatchable(schedule, skillResult.skill, context);

    receipt.status = "running";
    receipt.reason = null;
    receipt.startedAt = new Date().toISOString();
    await updateRunReceipt(receipt);

    const result = await dispatchScheduledRun({
      schedule,
      skill: skillResult.skill,
      firedAt: receipt.firedAt,
      scheduledFor: receipt.scheduledFor,
      scheduleRunId: receipt.id
    });
    receipt.status = result?.ok ? "completed" : "failed";
    receipt.taskId = result?.taskId || result?.task?.id || null;
    receipt.reason = result?.ok ? null : result?.error?.code || "TASK_FAILED";
    receipt.completedAt = new Date().toISOString();
    await updateRunReceipt(receipt);
  } catch (error) {
    receipt.status = shouldSkip(error) ? "skipped" : "blocked";
    receipt.reason = error?.code || "SCHEDULE_BLOCKED";
    receipt.completedAt = new Date().toISOString();
    await updateRunReceipt(receipt);
  }
}

async function drainQueuedRun(scheduleId) {
  const runs = await listScheduleRuns(scheduleId);
  const queued = runs
    .filter((run) => run.status === "queued")
    .sort((a, b) => Date.parse(a.queuedAt || a.firedAt) - Date.parse(b.queuedAt || b.firedAt));
  if (!queued.length) return;

  const stillActive = runs.some((run) => ["checking", "running"].includes(run.status));
  if (stillActive) return;

  const schedules = await listSchedules();
  const schedule = schedules.find((item) => item.id === scheduleId);
  const receipt = queued[0];
  if (!schedule) {
    await settleWithoutDispatch(receipt, "blocked", "SCHEDULE_NOT_FOUND");
    return;
  }
  if (!schedule.enabled && schedule.recurrence.kind !== "once") {
    await settleWithoutDispatch(receipt, "blocked", "SCHEDULE_PAUSED");
    return;
  }

  receipt.status = "checking";
  receipt.reason = null;
  receipt.dequeuedAt = new Date().toISOString();
  await updateRunReceipt(receipt);

  // A queued occurrence was already accepted while the schedule was enabled.
  // One-time schedules auto-disable after their alarm is consumed, so permit
  // only that already-accepted occurrence to finish. Recurring schedules must
  // still be enabled when the queue drains.
  const acceptedSchedule = schedule.recurrence.kind === "once" ? { ...schedule, enabled: true } : schedule;
  await dispatchReceipt(acceptedSchedule, receipt);

  // At most one receipt can be queued at a time, but run another drain check in
  // case a new alarm arrived while this queued occurrence was executing.
  await drainQueuedRun(scheduleId);
}

async function resolveDispatchContext(schedule, skill, activeRun) {
  // The actual dispatcher supplies live grant/provider/resource checks. These
  // defaults deliberately fail closed for any context that cannot be proven.
  const result = await dispatchScheduledRun({
    mode: "preflight",
    schedule,
    skill,
    activeRun
  });
  return {
    activeRun,
    grantsValid: result?.grantsValid === true,
    providerAvailable: result?.providerAvailable === true,
    resourceFresh: result?.resourceFresh === true
  };
}

async function settleWithoutDispatch(receipt, status, reason) {
  receipt.status = status;
  receipt.reason = reason;
  receipt.completedAt = new Date().toISOString();
  await updateRunReceipt(receipt);
}

async function advanceSchedule(scheduleId, firedAt) {
  const schedules = await listSchedules();
  const index = schedules.findIndex((item) => item.id === scheduleId);
  if (index < 0) return;
  const schedule = { ...schedules[index], lastRunAt: new Date(firedAt).toISOString(), updatedAt: new Date().toISOString() };
  if (schedule.recurrence.kind === "once") {
    schedule.enabled = false;
    schedule.nextRunAt = null;
  } else if (["daily", "weekly"].includes(schedule.recurrence.kind)) {
    schedule.nextRunAt = new Date(nextCalendarRun(schedule, firedAt + 1000)).toISOString();
  } else {
    const alarm = await chrome.alarms.get(alarmName(schedule.id));
    schedule.nextRunAt = alarm?.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : new Date(nextRun(schedule, firedAt + 1000)).toISOString();
  }
  schedules[index] = schedule;
  await persistSchedules(schedules);
  if (schedule.enabled && ["daily", "weekly"].includes(schedule.recurrence.kind)) await syncOneAlarm(schedule);
}

function nextRun(schedule, now = Date.now()) {
  if (schedule.recurrence.kind === "once") return schedule.recurrence.when;
  if (schedule.recurrence.kind === "interval") return schedule.recurrence.startAt && schedule.recurrence.startAt > now ? schedule.recurrence.startAt : now + schedule.recurrence.everyMinutes * 60_000;
  return nextCalendarRun(schedule, now);
}

function missedActionName(schedule, action) {
  if (action === "review") return "ask";
  if (action === "skip") return "skip";
  return schedule.missedRunPolicy === "run_once_when_available" ? "run_once_when_available" : "run";
}

async function appendRunReceipt(receipt) {
  const runs = await listScheduleRuns();
  runs.unshift(receipt);
  await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: runs.slice(0, MAX_RUN_RECEIPTS) });
}

async function updateRunReceipt(receipt) {
  const runs = await listScheduleRuns();
  const index = runs.findIndex((item) => item.id === receipt.id);
  if (index >= 0) runs[index] = structuredClone(receipt);
  else runs.unshift(structuredClone(receipt));
  await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: runs.slice(0, MAX_RUN_RECEIPTS) });
}

async function persistSchedules(schedules) {
  await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules.slice(0, MAX_SCHEDULES) });
}

function shouldSkip(error) {
  return ["SCHEDULE_ALREADY_RUNNING", "SCHEDULE_MISSED_SKIP", "SCHEDULE_QUEUE_FULL"].includes(error?.code);
}

function requireAlarmsApi() {
  if (!chrome.alarms?.create) throw coded("ALARMS_PERMISSION_REQUIRED", "Scheduling needs Chrome's alarms permission. This post-v0.2 feature is not enabled in the v0.2 store candidate.");
}

function coded(code, message) { const error = new Error(message); error.code = code; return error; }
