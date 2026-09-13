import { getSkillVersion } from "./skills-runtime.js";
import {
  assertScheduleGrantMatches,
  createScheduleGrant,
  revokeScheduleGrant,
  validateScheduleGrant
} from "./schedule-grants-contract.js";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_GRANTS_KEY = "browsercrew.scheduleGrants.v1";
const SCHEDULE_GRANTS_PORT = "browsercrew-schedule-grants";
const MAX_SCHEDULE_GRANTS = 500;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SCHEDULE_GRANTS_PORT) return;
  port.onMessage.addListener((message) => {
    handleGrantMessage(message).then((result) => port.postMessage({ requestId: message?.requestId, ...result })).catch((error) => {
      port.postMessage({ requestId: message?.requestId, ok: false, error: safeError(error) });
    });
  });
});

async function handleGrantMessage(message) {
  switch (message?.type) {
    case "list": return { ok: true, grants: await listScheduleGrants(message.scheduleId || null) };
    case "approve": return approveScheduleGrant(message.scheduleId, message.expiresAt);
    case "revoke": return revokeScheduleGrantById(message.scheduleId, message.grantId);
    default: return { ok: false, error: { code: "UNKNOWN_SCHEDULE_GRANT_REQUEST", message: "BrowserCrew received an unknown schedule-permission request." } };
  }
}

export async function listScheduleGrants(scheduleId = null) {
  const data = await chrome.storage.local.get(SCHEDULE_GRANTS_KEY);
  const grants = Array.isArray(data[SCHEDULE_GRANTS_KEY]) ? data[SCHEDULE_GRANTS_KEY] : [];
  return scheduleId ? grants.filter((grant) => grant.scheduleId === scheduleId) : grants;
}

export async function approveScheduleGrant(scheduleId, expiresAt) {
  const now = new Date().toISOString();
  const data = await chrome.storage.local.get([SCHEDULES_KEY, SCHEDULE_GRANTS_KEY]);
  const schedules = Array.isArray(data[SCHEDULES_KEY]) ? data[SCHEDULES_KEY] : [];
  const grants = Array.isArray(data[SCHEDULE_GRANTS_KEY]) ? data[SCHEDULE_GRANTS_KEY] : [];
  const index = schedules.findIndex((item) => item.id === scheduleId);
  if (index < 0) throw coded("SCHEDULE_NOT_FOUND", "That prepared schedule could not be found.");
  const schedule = schedules[index];
  if (schedule.enabled) throw coded("SCHEDULE_GRANT_PREPARED_ONLY", "Pause the schedule before approving durable schedule permission.");
  if ((schedule.grantRefs || []).length) throw coded("SCHEDULE_GRANT_ALREADY_REFERENCED", "Revoke the current schedule permission before approving a replacement.");
  if (grants.some((grant) => grant.scheduleId === schedule.id && grant.status === "active" && grant.revoked !== true)) {
    throw coded("SCHEDULE_GRANT_ALREADY_ACTIVE", "This schedule already has active durable permission. Revoke it before creating another.");
  }
  if (grants.length >= MAX_SCHEDULE_GRANTS) throw coded("SCHEDULE_GRANT_LIMIT", `BrowserCrew can retain up to ${MAX_SCHEDULE_GRANTS} schedule permission receipts in this build.`);

  const skillResult = await getSkillVersion(schedule.skillRef.id, schedule.skillRef.version);
  if (!skillResult.ok) throw coded("SCHEDULE_SKILL_NOT_FOUND", "The exact approved Skill version for this prepared schedule is no longer available.");
  const grant = createScheduleGrant({
    id: `schedule-grant:${crypto.randomUUID()}`,
    schedule,
    skill: skillResult.skill,
    createdAt: now,
    expiresAt
  });
  const nextSchedule = { ...schedule, grantRefs: [grant.id], updatedAt: now };
  assertScheduleGrantMatches(nextSchedule, skillResult.skill, grant, { now: Date.parse(now) });
  const nextSchedules = schedules.map((item, itemIndex) => itemIndex === index ? nextSchedule : item);
  const nextGrants = [grant, ...grants].slice(0, MAX_SCHEDULE_GRANTS);
  await chrome.storage.local.set({ [SCHEDULES_KEY]: nextSchedules, [SCHEDULE_GRANTS_KEY]: nextGrants });
  return { ok: true, schedule: nextSchedule, grant: publicGrant(grant) };
}

export async function revokeScheduleGrantById(scheduleId, grantId) {
  const now = new Date().toISOString();
  const data = await chrome.storage.local.get([SCHEDULES_KEY, SCHEDULE_GRANTS_KEY]);
  const schedules = Array.isArray(data[SCHEDULES_KEY]) ? data[SCHEDULES_KEY] : [];
  const grants = Array.isArray(data[SCHEDULE_GRANTS_KEY]) ? data[SCHEDULE_GRANTS_KEY] : [];
  const scheduleIndex = schedules.findIndex((item) => item.id === scheduleId);
  if (scheduleIndex < 0) throw coded("SCHEDULE_NOT_FOUND", "That schedule could not be found.");
  const schedule = schedules[scheduleIndex];
  if (schedule.enabled) throw coded("SCHEDULE_GRANT_PAUSE_REQUIRED", "Pause the schedule before revoking future permission.");
  const grantIndex = grants.findIndex((item) => item.id === grantId);
  if (grantIndex < 0) throw coded("SCHEDULE_GRANT_NOT_FOUND", "That schedule permission receipt could not be found.");
  if (grants[grantIndex].scheduleId !== scheduleId) throw coded("SCHEDULE_GRANT_SCHEDULE_MISMATCH", "That permission receipt belongs to a different schedule.");

  const revoked = revokeScheduleGrant(grants[grantIndex], { revokedAt: now, reason: "user_revoked" });
  const nextGrants = grants.map((item, itemIndex) => itemIndex === grantIndex ? revoked : item);
  const nextSchedule = { ...schedule, grantRefs: (schedule.grantRefs || []).filter((id) => id !== grantId), updatedAt: now };
  const nextSchedules = schedules.map((item, itemIndex) => itemIndex === scheduleIndex ? nextSchedule : item);
  await chrome.storage.local.set({ [SCHEDULES_KEY]: nextSchedules, [SCHEDULE_GRANTS_KEY]: nextGrants });
  return { ok: true, schedule: nextSchedule, grant: publicGrant(revoked) };
}

export async function assertScheduleEditAllowedWithGrant(existing, next) {
  const refs = Array.isArray(existing?.grantRefs) ? [...new Set(existing.grantRefs)] : [];
  if (!refs.length) return true;
  if (refs.length !== 1) throw coded("SCHEDULE_GRANT_REFERENCE_INVALID", "Revoke or repair this schedule's saved permission before editing it.");
  const grants = await listScheduleGrants(existing.id);
  const grant = grants.find((item) => item.id === refs[0]);
  if (!grant || grant.status !== "active" || grant.revoked === true) {
    throw coded("SCHEDULE_GRANT_REVIEW_REQUIRED", "Revoke or repair the saved schedule permission before editing this schedule.");
  }
  const skillChanged = existing.skillRef?.id !== next?.skillRef?.id || existing.skillRef?.version !== next?.skillRef?.version;
  const providerChanged = existing.providerRef !== next?.providerRef;
  const grantMismatch = grant.scheduleId !== existing.id || grant.providerRef !== existing.providerRef || grant.skillRef?.id !== existing.skillRef?.id || grant.skillRef?.version !== existing.skillRef?.version;
  if (grantMismatch) throw coded("SCHEDULE_GRANT_REVIEW_REQUIRED", "Revoke or repair the saved schedule permission before editing this schedule.");
  if (skillChanged || providerChanged) {
    throw coded("SCHEDULE_GRANT_CHANGE_REQUIRES_REVIEW", "Revoke the current schedule permission before changing its AI connection or Skill version.");
  }
  return true;
}

export async function resolveActiveScheduleGrant(grantRefs, { schedule, skill } = {}) {
  const refs = Array.isArray(grantRefs) ? [...new Set(grantRefs)] : [];
  if (refs.length !== 1) throw coded("SCHEDULE_GRANT_REFERENCE_INVALID", "A scheduled run requires exactly one reviewed active schedule grant.");
  const grants = await listScheduleGrants();
  const grant = grants.find((item) => item.id === refs[0]);
  if (!grant) throw coded("SCHEDULE_GRANT_NOT_FOUND", "The reviewed schedule permission could not be found.");
  assertScheduleGrantMatches(schedule, skill, grant, { now: Date.now() });
  return structuredClone(grant);
}

export async function revokeScheduleGrantsForDeletedSchedule(scheduleId) {
  const data = await chrome.storage.local.get(SCHEDULE_GRANTS_KEY);
  const grants = Array.isArray(data[SCHEDULE_GRANTS_KEY]) ? data[SCHEDULE_GRANTS_KEY] : [];
  let changed = false;
  const now = new Date().toISOString();
  const next = grants.map((grant) => {
    if (grant.scheduleId !== scheduleId || grant.status !== "active" || grant.revoked === true) return grant;
    changed = true;
    return revokeScheduleGrant(grant, { revokedAt: now, reason: "schedule_deleted" });
  });
  if (changed) await chrome.storage.local.set({ [SCHEDULE_GRANTS_KEY]: next });
  return { ok: true, revoked: next.filter((grant) => grant.scheduleId === scheduleId && grant.status === "revoked").length };
}

export function assertScheduleGrantRecord(grant) {
  const result = validateScheduleGrant(grant);
  if (!result.ok) throw coded("SCHEDULE_GRANT_INVALID", result.errors.join(" "));
  return true;
}

function publicGrant(grant) {
  return {
    id: grant.id,
    schemaVersion: grant.schemaVersion,
    scope: grant.scope,
    status: grant.status,
    revoked: grant.revoked,
    scheduleId: grant.scheduleId,
    providerRef: grant.providerRef,
    skillRef: structuredClone(grant.skillRef),
    origins: [...grant.origins],
    resources: [...grant.resources],
    actionClasses: [...grant.actionClasses],
    providerCapabilities: [...grant.providerCapabilities],
    dataDestinations: [...grant.dataDestinations],
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    expiresAt: grant.expiresAt,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt, revokedReason: grant.revokedReason || "revoked" } : {})
  };
}

function safeError(error) { return { code: error?.code || "SCHEDULE_GRANT_ERROR", message: error?.message || "BrowserCrew could not update this schedule permission." }; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
