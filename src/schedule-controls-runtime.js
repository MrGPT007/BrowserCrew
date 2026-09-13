import { alarmName } from "./schedules-contract.js";
import {
  listScheduleRuns,
  listSchedules,
  reviewMissedScheduleRun,
  scheduleExecutionSnapshot,
  setScheduleEnabled
} from "./schedules-runtime.js";
import { withScheduleRunHistoryMutation } from "./schedule-run-history-mutation.js";

const SCHEDULE_RUNS_KEY = "browsercrew.scheduleRuns.v1";
const SCHEDULE_CONTROLS_PORT = "browsercrew-schedule-controls";
const MAX_RUN_RECEIPTS = 500;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SCHEDULE_CONTROLS_PORT) return;
  port.onMessage.addListener((message) => {
    handleControlMessage(message).then((result) => port.postMessage({ requestId: message?.requestId, ...result })).catch((error) => {
      port.postMessage({ requestId: message?.requestId, ok: false, error: safeError(error), run: error?.run || null });
    });
  });
});

async function handleControlMessage(message) {
  switch (message?.type) {
    case "capabilities": return { ok: true, runtimeLoaded: true, schedulerReady: await hasLiveScheduler() };
    case "enable": return setScheduleEnabled(message.scheduleId, true);
    case "pause": return setScheduleEnabled(message.scheduleId, false);
    case "runNow": return runScheduleNow(message.scheduleId);
    default: return { ok: false, error: { code: "UNKNOWN_SCHEDULE_CONTROL_REQUEST", message: "BrowserCrew received an unknown schedule control request." } };
  }
}

export async function runScheduleNow(scheduleId) {
  if (!scheduleId) throw coded("SCHEDULE_NOT_FOUND", "Choose the active schedule you want to run now.");
  const schedules = await listSchedules();
  const schedule = schedules.find((item) => item.id === scheduleId);
  if (!schedule) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
  if (!schedule.enabled) throw coded("SCHEDULE_PAUSED", "Turn on this schedule before using Run now.");
  await assertLiveSchedulerFor(schedule.id);

  const now = new Date().toISOString();
  const receipt = {
    id: `schedule-run:${crypto.randomUUID()}`,
    schemaVersion: 1,
    scheduleId: schedule.id,
    skillRef: structuredClone(schedule.skillRef),
    scheduleSnapshot: scheduleExecutionSnapshot(schedule),
    scheduledFor: now,
    firedAt: now,
    latenessMs: 0,
    missed: false,
    missedAction: "run_now",
    trigger: "manual",
    status: "needs_review",
    reason: "SCHEDULE_MANUAL_RUN_REQUESTED",
    taskId: null,
    reviewRequestedAt: now,
    completedAt: null
  };

  await withScheduleRunHistoryMutation(async () => {
    const existingRuns = await listScheduleRuns();
    await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: [receipt, ...existingRuns].slice(0, MAX_RUN_RECEIPTS) });
  });

  try {
    const result = await reviewMissedScheduleRun(receipt.id, "run_once");
    return { ...result, manual: true };
  } catch (error) {
    if (error?.code === "SCHEDULE_DISPATCH_REQUIRED") await removeManualReceipt(receipt.id);
    throw error;
  }
}

async function hasLiveScheduler() {
  if (!chrome.alarms?.get || !chrome.alarms?.onAlarm?.hasListeners) return false;
  return chrome.alarms.onAlarm.hasListeners();
}

async function assertLiveSchedulerFor(scheduleId) {
  if (!(await hasLiveScheduler())) {
    throw coded("SCHEDULE_RUNTIME_LOCKED", "Background scheduling is not active in this BrowserCrew build.");
  }
  const alarm = await chrome.alarms.get(alarmName(scheduleId));
  if (!alarm) throw coded("SCHEDULE_ALARM_MISSING", "BrowserCrew could not find the live alarm for this schedule. Pause it and review the setup before trying again.");
  return alarm;
}

async function removeManualReceipt(runId) {
  return withScheduleRunHistoryMutation(async () => {
    const runs = await listScheduleRuns();
    await chrome.storage.local.set({ [SCHEDULE_RUNS_KEY]: runs.filter((run) => run.id !== runId) });
  });
}

function safeError(error) { return { code: error?.code || "SCHEDULE_CONTROL_ERROR", message: error?.message || "BrowserCrew could not update this schedule." }; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
