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
import { assertPreparedScheduleMetadataForSkill, createPreparedScheduleMetadata } from "./schedule-prepared-metadata.js";
import {
  assertScheduleEditAllowedWithGrant,
  resolveActiveScheduleGrant,
  revokeScheduleGrantsForDeletedSchedule
} from "./schedule-grants-runtime.js";
import { withScheduleStateMutation } from "./schedule-state-mutation.js";
import { withScheduleRunHistoryMutation } from "./schedule-run-history-mutation.js";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SCHEDULES_PORT = "browsercrew-schedules";
const MAX_SCHEDULES = 100;
const MAX_RUN_RECEIPTS = 500;
const ALARM_PREFIX = "browsercrew.schedule.";
const occurrenceLocks = new Map();
let booted = false;
let bootPromise = null;
let dispatchScheduledRun = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SCHEDULES_PORT) return;
  port.onMessage.addListener((message) => {
    handleScheduleMessage(message).then((result) => port.postMessage({ requestId: message?.requestId, ...result })).catch((error) => {
      port.postMessage({ requestId: message?.requestId, ok: false, error: safeError(error), run: error?.run || null });
    });
  });
});

async function handleScheduleMessage(message) {
  switch (message?.type) {
    case "capabilities": return { ok: true, alarmsAvailable: Boolean(chrome.alarms?.create), schedulerBooted: booted };
    case "list": return { ok: true, schedules: await listSchedules() };
    case "saveDraft": return saveSchedule({ ...(message.schedule || {}), enabled: false });
    case "setPreparedBinding": return setPreparedScheduleBinding(message.scheduleId, message.pageUrl);
    case "setEnabled": return setScheduleEnabled(message.scheduleId, message.enabled);
    case "delete": return deleteSchedule(message.scheduleId);
    case "listRuns": return { ok: true, runs: await listScheduleRuns(message.scheduleId || null) };
    case "reviewMissed": return reviewMissedScheduleRun(message.runId, message.decision);
    default: return { ok: false, error: { code: "UNKNOWN_SCHEDULE_REQUEST", message: "BrowserCrew received an unknown schedule request." } };
  }
}

export async function bootSchedulesRuntime({ dispatch } = {}) {
  if (booted) return;
  if (bootPromise) return bootPromise;
  if (!chrome.alarms?.onAlarm) throw coded("ALARMS_PERMISSION_REQUIRED", "Scheduling needs Chrome's alarms permission. Enable it only in the BrowserCrew release that ships schedules.");
  if (typeof dispatch !== "function") throw coded("SCHEDULE_DISPATCH_REQUIRED", "The schedule runtime needs BrowserCrew's normal task dispatcher.");

  dispatchScheduledRun = dispatch;
  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.runtime.onStartup.addListener(onStartupReconcile);
  chrome.runtime.onInstalled.addListener(onInstalledReconcile);

  bootPromise = (async () => {
    try {
      await reconcileScheduleAlarms();
      booted = true;
    } catch (error) {
      removeBootListeners();
      dispatchScheduledRun = null;
      throw error;
    } finally {
      bootPromise = null;
    }
  })();
  return bootPromise;
}

function onStartupReconcile() {
  if (!booted) return;
  reconcileScheduleAlarms().catch(() => {});
}

function onInstalledReconcile() {
  if (!booted) return;
  reconcileScheduleAlarms().catch(() => {});
}

function removeBootListeners() {
  chrome.alarms.onAlarm.removeListener?.(onAlarm);
  chrome.runtime.onStartup.removeListener?.(onStartupReconcile);
  chrome.runtime.onInstalled.removeListener?.(onInstalledReconcile);
}

export async function listSchedules() {
  const data = await chrome.storage.local.get(SCHEDULES_KEY);
  return Array.isArray(data[SCHEDULES_KEY]) ? data[SCHEDULES_KEY] : [];
}

export async function saveSchedule(input) {
  const schedule = structuredClone(input || {});
  // Prepared execution metadata can only be created through the dedicated review path below.
  // Ignore caller-supplied binding fields so saveDraft can never manufacture authority-like state.
  delete schedule.startResource;
  delete schedule.authorityPlan;
  const validation = validateSchedule(schedule);
  if (!validation.ok) throw coded("SCHEDULE_INVALID", validation.errors.join(" "));
  if (schedule.enabled) requireAlarmsApi();

  const skillResult = await getSkillVersion(schedule.skillRef.id, schedule.skillRef.version);
  if (!skillResult.ok) throw coded("SCHEDULE_SKILL_NOT_FOUND", "Choose an existing approved skill version before saving this schedule.");
  assertScheduleDispatchable({ ...schedule, enabled: true }, skillResult.skill, {
    activeRun: false,
    grantsValid: true,
    providerAvailable: true,
    resourceFresh: true
  });

  const validationSchedules = await listSchedules();
  const validationIndex = validationSchedules.findIndex((item) => item.id === schedule.id);
  if (validationIndex < 0 && validationSchedules.length >= MAX_SCHEDULES) throw coded("SCHEDULE_LIMIT", `BrowserCrew can keep up to ${MAX_SCHEDULES} schedules in this build.`);
  const existingSnapshot = validationIndex >= 0 ? structuredClone(validationSchedules[validationIndex]) : null;
  if (existingSnapshot) await assertScheduleEditAllowedWithGrant(existingSnapshot, schedule);
  // saveDraft can neither add nor replace authority references. The dedicated
  // grant lifecycle owns these refs; ordinary edits preserve only trusted stored refs.
  schedule.grantRefs = existingSnapshot && Array.isArray(existingSnapshot.grantRefs) ? structuredClone(existingSnapshot.grantRefs) : [];
  if (existingSnapshot) preservePreparedMetadata(schedule, existingSnapshot, skillResult.skill);
  if (schedule.enabled) {
    assertPreparedScheduleMetadataForSkill(schedule, skillResult.skill);
    await resolveActiveScheduleGrant(schedule.grantRefs, { schedule, skill: skillResult.skill });
  }

  const saved = await withScheduleStateMutation(async () => {
    const schedules = await listSchedules();
    const index = schedules.findIndex((item) => item.id === schedule.id);
    const current = index >= 0 ? schedules[index] : null;
    assertScheduleTargetUnchanged(current, existingSnapshot);
    if (index < 0 && schedules.length >= MAX_SCHEDULES) throw coded("SCHEDULE_LIMIT", `BrowserCrew can keep up to ${MAX_SCHEDULES} schedules in this build.`);

    const next = structuredClone(schedule);
    const now = new Date().toISOString();
    next.createdAt = current ? current.createdAt : next.createdAt || now;
    next.lastRunAt = current ? current.lastRunAt ?? null : null;
    next.updatedAt = now;
    next.nextRunAt = next.enabled ? new Date(nextRun(next)).toISOString() : null;
    if (index >= 0) schedules[index] = next;
    else schedules.push(next);
    await persistSchedules(schedules);
    await syncOneAlarm(next);
    return structuredClone(next);
  });
  return { ok: true, schedule: saved };
}

export async function setPreparedScheduleBinding(scheduleId, pageUrl) {
  if (!scheduleId) throw coded("SCHEDULE_NOT_FOUND", "Choose the prepared schedule whose starting page you want to review.");
  const schedules = await listSchedules();
  const index = schedules.findIndex((item) => item.id === scheduleId);
  if (index < 0) throw coded("SCHEDULE_NOT_FOUND", "That prepared schedule could not be found.");
  const existing = structuredClone(schedules[index]);
  if (existing.enabled) throw coded("SCHEDULE_BINDING_PREPARED_ONLY", "Pause this schedule before changing its reviewed starting page.");
  if (Array.isArray(existing.grantRefs) && existing.grantRefs.length) {
    throw coded("SCHEDULE_BINDING_ACTIVE_GRANT_PRESENT", "This schedule already references durable authority. Revoke that permission before changing its starting page.");
  }

  const skillResult = await getSkillVersion(existing.skillRef.id, existing.skillRef.version);
  if (!skillResult.ok) throw coded("SCHEDULE_SKILL_NOT_FOUND", "The exact approved Skill version for this schedule is no longer available.");
  const metadata = createPreparedScheduleMetadata({ skill: skillResult.skill, pageUrl });
  const reviewed = {
    ...existing,
    startResource: metadata.startResource,
    authorityPlan: metadata.authorityPlan,
    grantRefs: [],
    updatedAt: new Date().toISOString()
  };
  assertPreparedScheduleMetadataForSkill(reviewed, skillResult.skill);

  const schedule = await withScheduleStateMutation(async () => {
    const latest = await listSchedules();
    const latestIndex = latest.findIndex((item) => item.id === scheduleId);
    const current = latestIndex >= 0 ? latest[latestIndex] : null;
    assertScheduleTargetUnchanged(current, existing);
    latest[latestIndex] = structuredClone(reviewed);
    await persistSchedules(latest);
    return structuredClone(reviewed);
  });
  return { ok: true, schedule };
}

export async function setScheduleEnabled(scheduleId, enabled) {
  const desired = Boolean(enabled);
  if (desired) requireAlarmsApi();

  if (!desired) {
    const schedule = await withScheduleStateMutation(async () => {
      const schedules = await listSchedules();
      const index = schedules.findIndex((item) => item.id === scheduleId);
      if (index < 0) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
      const next = { ...schedules[index], enabled: false, updatedAt: new Date().toISOString(), nextRunAt: null };
      schedules[index] = next;
      await persistSchedules(schedules);
      await syncOneAlarm(next);
      return structuredClone(next);
    });
    return { ok: true, schedule };
  }

  const validationSchedules = await listSchedules();
  const validationIndex = validationSchedules.findIndex((item) => item.id === scheduleId);
  if (validationIndex < 0) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
  const existing = structuredClone(validationSchedules[validationIndex]);
  const skillResult = await getSkillVersion(existing.skillRef.id, existing.skillRef.version);
  if (!skillResult.ok) throw coded("SCHEDULE_SKILL_NOT_FOUND", "The exact approved Skill version for this schedule is no longer available.");
  assertPreparedScheduleMetadataForSkill(existing, skillResult.skill);
  await resolveActiveScheduleGrant(existing.grantRefs, { schedule: existing, skill: skillResult.skill });

  const schedule = await withScheduleStateMutation(async () => {
    const schedules = await listSchedules();
    const index = schedules.findIndex((item) => item.id === scheduleId);
    const current = index >= 0 ? schedules[index] : null;
    assertScheduleTargetUnchanged(current, existing);
    const next = { ...current, enabled: true, updatedAt: new Date().toISOString() };
    next.nextRunAt = new Date(nextRun(next)).toISOString();
    schedules[index] = next;
    await persistSchedules(schedules);
    await syncOneAlarm(next);
    return structuredClone(next);
  });
  return { ok: true, schedule };
}

export async function deleteSchedule(scheduleId) {
  await withScheduleStateMutation(async () => {
    const schedules = await listSchedules();
    const next = schedules.filter((item) => item.id !== scheduleId);
    if (next.length === schedules.length) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
    await revokeScheduleGrantsForDeletedSchedule(scheduleId, { scheduleStateLockHeld: true });
    await persistSchedules(next);
    if (chrome.alarms?.clear) await chrome.alarms.clear(alarmName(scheduleId));
  });
  return { ok: true };
}

export async function listScheduleRuns(scheduleId = null) {
  const data = await chrome.storage.local.get(SCHEDULE_RUNS_KEY);
  const runs = Array.isArray(data[SCHEDULE_RUNS_KEY]) ? data[SCHEDULE_RUNS_KEY] : [];
  return scheduleId ? runs.filter((run) => run.scheduleId === scheduleId) : runs;
}

export async function reviewMissedScheduleRun(runId, decision) {
  if (!runId) throw coded("SCHEDULE_RUN_ID_REQUIRED", "Choose the missed scheduled job you want to review.");
  if (!["run_once", "skip"].includes(decision)) throw coded("SCHEDULE_REVIEW_DECISION_INVALID", "Choose whether to run this missed job once or skip it.");

  const claim = await withScheduleRunHistoryMutation(async () => {
    const data = await chrome.storage.local.get([SCHEDULE_RUNS_KEY, SCHEDULES_KEY]);
    const runs = Array.isArray(data[SCHEDULE_RUNS_KEY]) ? data[SCHEDULE_RUNS_KEY] : [];
    const schedules = Array.isArray(data[SCHEDULES_KEY]) ? data[SCHEDULES_KEY] : [];
    const index = runs.findIndex((run) => run.id === runId);
    if (index < 0) throw coded("SCHEDULE_RUN_NOT_FOUND", "That scheduled job receipt could not be found.");

    const receipt = structuredClone(runs[index]);
    if (receipt.status !== "needs_review") throw coded("SCHEDULE_REVIEW_NOT_PENDING", "That scheduled job is no longer waiting for review.");

    receipt.reviewDecision = decision;
    receipt.reviewedAt = new Date().toISOString();
    const persistClaim = async () => {
      runs[index] = structuredClone(receipt);
      await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: runs.slice(0, MAX_RUN_RECEIPTS) });
    };

    if (decision === "skip") {
      receipt.status = "skipped";
      receipt.reason = "SCHEDULE_MISSED_USER_SKIPPED";
      receipt.completedAt = new Date().toISOString();
      await persistClaim();
      return { action: "done", ok: true, receipt };
    }

    if (typeof dispatchScheduledRun !== "function") {
      receipt.status = "needs_review";
      receipt.reason = "SCHEDULE_DISPATCH_REQUIRED";
      await persistClaim();
      return { action: "dispatch_required", receipt };
    }

    const schedule = schedules.find((item) => item.id === receipt.scheduleId);
    if (!schedule) {
      receipt.status = "blocked";
      receipt.reason = "SCHEDULE_NOT_FOUND";
      receipt.completedAt = new Date().toISOString();
      await persistClaim();
      return { action: "done", ok: false, receipt, message: "The schedule for this missed job no longer exists." };
    }

    const activeRun = runs.some((run) => run.id !== receipt.id && run.scheduleId === receipt.scheduleId && ["checking", "running"].includes(run.status));
    const queuedRun = runs.some((run) => run.id !== receipt.id && run.scheduleId === receipt.scheduleId && run.status === "queued");
    const concurrency = decideScheduleConcurrency(schedule, { activeRun, queuedRun });
    if (concurrency.action === "skip") {
      receipt.status = "skipped";
      receipt.reason = concurrency.reason;
      receipt.completedAt = new Date().toISOString();
      await persistClaim();
      return { action: "done", ok: false, receipt, message: "This missed job could not start because another run is already using its schedule slot." };
    }
    if (concurrency.action === "queue") {
      receipt.status = "queued";
      receipt.reason = concurrency.reason;
      receipt.queuedAt = new Date().toISOString();
      await persistClaim();
      return { action: "queued", receipt };
    }

    receipt.status = "checking";
    receipt.reason = null;
    await persistClaim();
    return { action: "dispatch", receipt, schedule: structuredClone(schedule) };
  });

  if (claim.action === "dispatch_required") {
    throw withRun(coded("SCHEDULE_DISPATCH_REQUIRED", "Scheduled jobs are not enabled in this BrowserCrew build yet."), claim.receipt);
  }
  if (claim.action === "queued") return { ok: true, run: claim.receipt, queued: true };
  if (claim.action === "done") {
    return claim.ok
      ? { ok: true, run: claim.receipt }
      : { ok: false, run: claim.receipt, error: { code: claim.receipt.reason, message: claim.message } };
  }

  const receipt = claim.receipt;
  const schedule = claim.schedule;
  const acceptedSchedule = schedule.recurrence.kind === "once" ? { ...schedule, enabled: true } : schedule;
  await dispatchReceipt(acceptedSchedule, receipt);
  return { ok: receipt.status === "completed", run: receipt, error: receipt.status === "completed" ? undefined : { code: receipt.reason || "TASK_FAILED", message: "The missed scheduled job did not complete." } };
}

export async function reconcileScheduleAlarms() {
  requireAlarmsApi();
  return withScheduleStateMutation(async () => {
    const schedules = await listSchedules();
    const alarms = await chrome.alarms.getAll();
    const changes = reconcileAlarmNames(schedules, alarms);
    for (const name of changes.clear) await chrome.alarms.clear(name);
    for (const schedule of schedules.filter((item) => item.enabled)) await syncOneAlarm(schedule);
    return { ok: true, createdOrUpdated: schedules.filter((item) => item.enabled).length, cleared: changes.clear.length };
  });
}

async function syncOneAlarm(schedule) {
  const name = alarmName(schedule.id);
  if (!schedule.enabled) {
    if (chrome.alarms?.clear) await chrome.alarms.clear(name);
    return;
  }
  requireAlarmsApi();
  await chrome.alarms.clear(name);
  await chrome.alarms.create(name, toChromeAlarmSpec(schedule));
}

async function onAlarm(alarm) {
  if (!alarm?.name?.startsWith(ALARM_PREFIX)) return;
  if (!booted) {
    const pendingBoot = bootPromise;
    if (!pendingBoot) return;
    try { await pendingBoot; }
    catch { return; }
    if (!booted) return;
  }

  const scheduleId = alarm.name.slice(ALARM_PREFIX.length);
  const firedAt = Date.now();
  const scheduledTime = Number.isFinite(alarm.scheduledTime) ? alarm.scheduledTime : firedAt;
  const scheduledFor = new Date(scheduledTime).toISOString();
  return withOccurrenceLock(JSON.stringify([scheduleId, scheduledFor]), async () => {
    const schedules = await listSchedules();
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule?.enabled) return;

    const duplicate = (await listScheduleRuns(scheduleId)).find((run) => run.scheduledFor === scheduledFor);
    if (duplicate) return;

    const missed = decideMissedRun(schedule, { scheduledTime, firedAt });
    const receipt = {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      scheduleId,
      skillRef: schedule.skillRef,
      scheduledFor,
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
  });
}

async function withOccurrenceLock(key, work) {
  const previous = occurrenceLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  occurrenceLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (occurrenceLocks.get(key) === current) occurrenceLocks.delete(key);
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
    const outcome = scheduledTaskOutcome(result);
    receipt.status = outcome.status;
    receipt.taskId = result?.taskId || result?.task?.id || null;
    receipt.reason = outcome.reason;
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

  const acceptedSchedule = schedule.recurrence.kind === "once" ? { ...schedule, enabled: true } : schedule;
  await dispatchReceipt(acceptedSchedule, receipt);
  await drainQueuedRun(scheduleId);
}

async function resolveDispatchContext(schedule, skill, activeRun) {
  const result = await dispatchScheduledRun({ mode: "preflight", schedule, skill, activeRun });
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
  return withScheduleStateMutation(async () => {
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
  });
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

function scheduledTaskOutcome(result) {
  const taskStatus = result?.task?.status || null;
  const code = result?.error?.code || result?.task?.error?.code || null;
  if (result?.ok === true) return { status: "completed", reason: null };
  if (taskStatus === "paused" || code === "TASK_PAUSED") return { status: "paused", reason: "TASK_PAUSED" };
  if (taskStatus === "cancelled" || code === "TASK_CANCELLED") return { status: "cancelled", reason: "TASK_CANCELLED" };
  return { status: "failed", reason: code || "TASK_FAILED" };
}

async function appendRunReceipt(receipt) {
  return withScheduleRunHistoryMutation(async () => {
    const runs = await listScheduleRuns();
    runs.unshift(structuredClone(receipt));
    await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: runs.slice(0, MAX_RUN_RECEIPTS) });
  });
}

async function updateRunReceipt(receipt) {
  return withScheduleRunHistoryMutation(async () => {
    const runs = await listScheduleRuns();
    const index = runs.findIndex((item) => item.id === receipt.id);
    if (index >= 0) runs[index] = structuredClone(receipt);
    else runs.unshift(structuredClone(receipt));
    await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: runs.slice(0, MAX_RUN_RECEIPTS) });
  });
}

function assertScheduleTargetUnchanged(current, snapshot) {
  if (current == null && snapshot == null) return;
  if (current != null && snapshot != null && JSON.stringify(current) === JSON.stringify(snapshot)) return;
  throw coded("SCHEDULE_CHANGED_RETRY", "This schedule changed while BrowserCrew was checking it. Review the latest schedule and try again.");
}

async function persistSchedules(schedules) {
  await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules.slice(0, MAX_SCHEDULES) });
}

function preservePreparedMetadata(schedule, existing, skill) {
  try { assertPreparedScheduleMetadataForSkill(existing, skill); }
  catch { return; }
  schedule.startResource = structuredClone(existing.startResource);
  schedule.authorityPlan = structuredClone(existing.authorityPlan);
}

function shouldSkip(error) {
  return ["SCHEDULE_ALREADY_RUNNING", "SCHEDULE_MISSED_SKIP", "SCHEDULE_QUEUE_FULL"].includes(error?.code);
}

function requireAlarmsApi() {
  if (!chrome.alarms?.create) throw coded("ALARMS_PERMISSION_REQUIRED", "Scheduling needs Chrome's alarms permission. This post-v0.2 feature is not enabled in the v0.2 store candidate.");
}

function safeError(error) { return { code: error?.code || "SCHEDULE_ERROR", message: error?.message || "BrowserCrew could not update this scheduled job." }; }
function withRun(error, run) { error.run = structuredClone(run); return error; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
