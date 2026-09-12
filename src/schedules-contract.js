import { assertSkillExecutable } from "./skills-contract.js";

export const SCHEDULE_SCHEMA_VERSION = 1;
export const MISSED_RUN_POLICIES = Object.freeze(["skip", "run_once_when_available", "ask"]);
export const CONCURRENCY_POLICIES = Object.freeze(["skip_if_running", "queue_one"]);
export const RECURRENCE_KINDS = Object.freeze(["once", "daily", "weekly", "interval"]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;

export function validateSchedule(schedule) {
  const errors = [];
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return { ok: false, errors: ["Schedule must be an object."] };
  if (schedule.schemaVersion !== SCHEDULE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEDULE_SCHEMA_VERSION}.`);
  if (!ID_PATTERN.test(String(schedule.id || ""))) errors.push("id must be a stable lowercase identifier.");
  if (typeof schedule.name !== "string" || !schedule.name.trim() || schedule.name.length > 120) errors.push("name is required and must be 120 characters or fewer.");
  if (typeof schedule.enabled !== "boolean") errors.push("enabled must be true or false.");
  if (!schedule.skillRef || !ID_PATTERN.test(String(schedule.skillRef.id || "")) || !/^\d+\.\d+\.\d+$/.test(String(schedule.skillRef.version || ""))) {
    errors.push("skillRef must pin an exact skill id and semantic version.");
  }
  if (!isTimeZone(schedule.timezone)) errors.push("timezone must be a valid IANA time zone.");
  if (!MISSED_RUN_POLICIES.includes(schedule.missedRunPolicy)) errors.push(`missedRunPolicy must be one of: ${MISSED_RUN_POLICIES.join(", ")}.`);
  if (!CONCURRENCY_POLICIES.includes(schedule.concurrencyPolicy)) errors.push(`concurrencyPolicy must be one of: ${CONCURRENCY_POLICIES.join(", ")}.`);
  if (!schedule.recurrence || !RECURRENCE_KINDS.includes(schedule.recurrence.kind)) errors.push(`recurrence.kind must be one of: ${RECURRENCE_KINDS.join(", ")}.`);
  else validateRecurrence(schedule.recurrence, errors);
  if (!schedule.providerRef || typeof schedule.providerRef !== "string") errors.push("providerRef is required.");
  if (!Array.isArray(schedule.grantRefs)) errors.push("grantRefs must be an array; an empty array is allowed only for read-only tasks that need no persisted grants.");
  if (!schedule.budgets || !Number.isInteger(schedule.budgets.maxSteps) || schedule.budgets.maxSteps < 1) errors.push("budgets.maxSteps must be a positive integer.");
  if (!schedule.budgets || !Number.isInteger(schedule.budgets.maxMinutes) || schedule.budgets.maxMinutes < 1) errors.push("budgets.maxMinutes must be a positive integer.");
  return { ok: errors.length === 0, errors };
}

export function assertScheduleDispatchable(schedule, skill, context = {}) {
  const result = validateSchedule(schedule);
  if (!result.ok) throw new Error(`Schedule is invalid: ${result.errors.join(" ")}`);
  if (!schedule.enabled) throw new Error("Schedule is paused.");
  assertSkillExecutable(skill);
  if (skill.id !== schedule.skillRef.id || skill.version !== schedule.skillRef.version) throw new Error("Schedule must run the exact approved skill version it references.");
  if (context.activeRun && schedule.concurrencyPolicy === "skip_if_running") throw new Error("Schedule skipped because its previous run is still active.");
  if (context.grantsValid === false) throw new Error("Scheduled run blocked because a required grant expired or was revoked.");
  if (context.providerAvailable === false) throw new Error("Scheduled run blocked because its configured provider is unavailable.");
  if (context.resourceFresh === false) throw new Error("Scheduled run blocked because its selected resource is stale or changed.");
  return true;
}

export function toChromeAlarmSpec(schedule, now = Date.now()) {
  const check = validateSchedule(schedule);
  if (!check.ok) throw new Error(`Schedule is invalid: ${check.errors.join(" ")}`);
  const recurrence = schedule.recurrence;
  if (recurrence.kind === "once") return { when: recurrence.when, persistAcrossSessions: true };
  if (recurrence.kind === "interval") return {
    when: recurrence.startAt || now + recurrence.everyMinutes * 60_000,
    periodInMinutes: recurrence.everyMinutes,
    persistAcrossSessions: true
  };
  const next = nextCalendarRun(schedule, now);
  const spec = { when: next, persistAcrossSessions: true };
  if (recurrence.kind === "daily") spec.periodInMinutes = 24 * 60;
  if (recurrence.kind === "weekly") spec.periodInMinutes = 7 * 24 * 60;
  return spec;
}

export function nextCalendarRun(schedule, now = Date.now()) {
  const recurrence = schedule.recurrence;
  if (recurrence.kind === "once") return recurrence.when;
  if (recurrence.kind === "interval") return recurrence.startAt && recurrence.startAt > now ? recurrence.startAt : now + recurrence.everyMinutes * 60_000;

  const parts = zonedParts(now, schedule.timezone);
  const desiredHour = recurrence.hour;
  const desiredMinute = recurrence.minute;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = addUtcDays(parts.year, parts.month, parts.day, dayOffset);
    if (recurrence.kind === "weekly" && date.weekday !== recurrence.weekday) continue;
    const candidate = epochForZonedWallTime({
      year: date.year,
      month: date.month,
      day: date.day,
      hour: desiredHour,
      minute: desiredMinute
    }, schedule.timezone);
    if (candidate > now) return candidate;
  }
  throw new Error("Unable to calculate next scheduled run.");
}

export function reconcileAlarmNames(schedules, alarms) {
  const desired = new Set((schedules || []).filter((item) => item.enabled).map((item) => alarmName(item.id)));
  const existing = new Set((alarms || []).map((item) => item.name));
  return {
    create: [...desired].filter((name) => !existing.has(name)),
    clear: [...existing].filter((name) => name.startsWith("browsercrew.schedule.") && !desired.has(name))
  };
}

export function alarmName(scheduleId) {
  if (!ID_PATTERN.test(String(scheduleId || ""))) throw new Error("Invalid schedule id.");
  return `browsercrew.schedule.${scheduleId}`;
}

function validateRecurrence(recurrence, errors) {
  if (recurrence.kind === "once") {
    if (!Number.isFinite(recurrence.when) || recurrence.when <= 0) errors.push("once recurrence requires when as epoch milliseconds.");
    return;
  }
  if (recurrence.kind === "interval") {
    if (!Number.isInteger(recurrence.everyMinutes) || recurrence.everyMinutes < 1 || recurrence.everyMinutes > 43_200) errors.push("interval everyMinutes must be 1 to 43200.");
    if (recurrence.startAt !== undefined && (!Number.isFinite(recurrence.startAt) || recurrence.startAt <= 0)) errors.push("interval startAt must be epoch milliseconds when present.");
    return;
  }
  if (!Number.isInteger(recurrence.hour) || recurrence.hour < 0 || recurrence.hour > 23) errors.push("calendar recurrence hour must be 0 to 23.");
  if (!Number.isInteger(recurrence.minute) || recurrence.minute < 0 || recurrence.minute > 59) errors.push("calendar recurrence minute must be 0 to 59.");
  if (recurrence.kind === "weekly" && (!Number.isInteger(recurrence.weekday) || recurrence.weekday < 0 || recurrence.weekday > 6)) errors.push("weekly recurrence weekday must be 0 (Sunday) to 6 (Saturday).");
}

function zonedParts(epoch, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  });
  const map = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second) };
}

function epochForZonedWallTime(parts, timeZone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const observed = zonedParts(guess, timeZone);
    const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second || 0, 0);
    const delta = desiredUtc - observedUtc;
    if (Math.abs(delta) < 1000) break;
    guess += delta;
  }
  return guess;
}

function addUtcDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function isTimeZone(value) {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}
