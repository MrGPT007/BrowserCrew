import { assertPreparedScheduleMetadataForSkill } from "./schedule-prepared-metadata.js";

export const SCHEDULE_GRANT_SCHEMA_VERSION = 1;
const MAX_GRANT_ID_LENGTH = 160;
const MAX_SCOPE_ITEMS = 64;

export function createScheduleGrant({ id, schedule, skill, createdAt = new Date().toISOString(), expiresAt } = {}) {
  if (!schedule || schedule.enabled !== false) throw coded("SCHEDULE_GRANT_PREPARED_ONLY", "Pause the schedule before reviewing durable schedule permission.");
  if (!skill || skill.status !== "approved" || schedule.skillRef?.id !== skill.id || schedule.skillRef?.version !== skill.version) {
    throw coded("SCHEDULE_GRANT_SKILL_MISMATCH", "Schedule permission must be reviewed against the exact approved Skill version.");
  }
  assertPreparedScheduleMetadataForSkill(schedule, skill);
  if ((schedule.grantRefs || []).length) throw coded("SCHEDULE_GRANT_ALREADY_REFERENCED", "Revoke the existing schedule permission before creating a replacement.");
  if (!validGrantId(id)) throw coded("SCHEDULE_GRANT_ID_INVALID", "Schedule grant id must be a stable non-empty identifier.");
  if (!schedule.providerRef || typeof schedule.providerRef !== "string") throw coded("SCHEDULE_GRANT_PROVIDER_REQUIRED", "Choose the exact AI connection before approving schedule permission.");
  if (!validTimestamp(createdAt)) throw coded("SCHEDULE_GRANT_CREATED_AT_INVALID", "Schedule grant creation time is invalid.");
  if (!validTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw coded("SCHEDULE_GRANT_EXPIRY_INVALID", "Choose a future expiration time for this schedule permission.");
  }

  const plan = schedule.authorityPlan;
  const grant = {
    schemaVersion: SCHEDULE_GRANT_SCHEMA_VERSION,
    id,
    scope: "schedule",
    status: "active",
    revoked: false,
    scheduleId: schedule.id,
    providerRef: schedule.providerRef,
    skillRef: { id: skill.id, version: skill.version },
    origins: [...plan.origins],
    resources: [...plan.resources],
    actionClasses: [...plan.actionClasses],
    providerCapabilities: [...plan.providerCapabilities],
    dataDestinations: [...plan.dataDestinations],
    createdAt,
    updatedAt: createdAt,
    expiresAt
  };
  const validation = validateScheduleGrant(grant);
  if (!validation.ok) throw coded("SCHEDULE_GRANT_INVALID", validation.errors.join(" "));
  assertScheduleGrantMatches({ ...schedule, grantRefs: [grant.id] }, skill, grant, { now: Date.parse(createdAt), allowFutureCreation: true });
  return grant;
}

export function validateScheduleGrant(grant) {
  const errors = [];
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return { ok: false, errors: ["Schedule grant must be an object."] };
  if (grant.schemaVersion !== SCHEDULE_GRANT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEDULE_GRANT_SCHEMA_VERSION}.`);
  if (!validGrantId(grant.id)) errors.push("id must be a stable non-empty identifier.");
  if (grant.scope !== "schedule") errors.push("scope must be schedule.");
  if (!["active", "revoked"].includes(grant.status)) errors.push("status must be active or revoked.");
  if (typeof grant.revoked !== "boolean") errors.push("revoked must be true or false.");
  if (grant.status === "active" && grant.revoked) errors.push("active grants cannot be marked revoked.");
  if (grant.status === "revoked" && !grant.revoked) errors.push("revoked grants must set revoked true.");
  if (typeof grant.scheduleId !== "string" || !grant.scheduleId) errors.push("scheduleId is required.");
  if (typeof grant.providerRef !== "string" || !grant.providerRef) errors.push("providerRef is required.");
  if (!grant.skillRef || typeof grant.skillRef.id !== "string" || !/^\d+\.\d+\.\d+$/.test(String(grant.skillRef.version || ""))) errors.push("skillRef must pin an exact Skill version.");
  for (const [key, label] of [["origins", "origins"], ["resources", "resources"], ["actionClasses", "actionClasses"], ["providerCapabilities", "providerCapabilities"], ["dataDestinations", "dataDestinations"]]) {
    validateStringArray(grant[key], label, errors);
  }
  if (!validTimestamp(grant.createdAt)) errors.push("createdAt must be an ISO timestamp.");
  if (!validTimestamp(grant.updatedAt)) errors.push("updatedAt must be an ISO timestamp.");
  if (!validTimestamp(grant.expiresAt)) errors.push("expiresAt must be an ISO timestamp.");
  if (validTimestamp(grant.createdAt) && validTimestamp(grant.updatedAt) && Date.parse(grant.updatedAt) < Date.parse(grant.createdAt)) errors.push("updatedAt cannot precede createdAt.");
  if (validTimestamp(grant.createdAt) && validTimestamp(grant.expiresAt) && Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt)) errors.push("expiresAt must be after createdAt.");
  if (grant.status === "revoked" && !validTimestamp(grant.revokedAt)) errors.push("revokedAt is required for revoked grants.");
  rejectPrivateFields(grant, errors);
  return { ok: errors.length === 0, errors };
}

export function assertScheduleGrantMatches(schedule, skill, grant, { now = Date.now(), allowFutureCreation = false } = {}) {
  const validation = validateScheduleGrant(grant);
  if (!validation.ok) throw coded("SCHEDULE_GRANT_INVALID", validation.errors.join(" "));
  assertPreparedScheduleMetadataForSkill(schedule, skill);
  if (grant.status !== "active" || grant.revoked) throw coded("SCHEDULE_GRANT_REVOKED", "This schedule permission has been revoked.");
  if (!Number.isFinite(now)) throw coded("SCHEDULE_GRANT_TIME_INVALID", "BrowserCrew could not verify the current time for this schedule permission.");
  if (!allowFutureCreation && Date.parse(grant.createdAt) > now) throw coded("SCHEDULE_GRANT_NOT_YET_VALID", "This schedule permission is not valid yet.");
  if (Date.parse(grant.expiresAt) <= now) throw coded("SCHEDULE_GRANT_EXPIRED", "This schedule permission has expired.");
  if (grant.scheduleId !== schedule.id) throw coded("SCHEDULE_GRANT_SCHEDULE_MISMATCH", "Schedule permission belongs to a different schedule.");
  if (grant.providerRef !== schedule.providerRef) throw coded("SCHEDULE_GRANT_PROVIDER_MISMATCH", "The schedule's AI connection changed after permission review.");
  if (grant.skillRef.id !== skill.id || grant.skillRef.version !== skill.version || schedule.skillRef?.id !== skill.id || schedule.skillRef?.version !== skill.version) {
    throw coded("SCHEDULE_GRANT_SKILL_MISMATCH", "Schedule permission belongs to a different Skill version.");
  }
  if (!(schedule.grantRefs || []).includes(grant.id)) throw coded("SCHEDULE_GRANT_REFERENCE_MISMATCH", "This schedule does not reference the reviewed permission grant.");
  const plan = schedule.authorityPlan;
  for (const [key, expected] of Object.entries({
    origins: plan.origins,
    resources: plan.resources,
    actionClasses: plan.actionClasses,
    providerCapabilities: plan.providerCapabilities,
    dataDestinations: plan.dataDestinations
  })) {
    if (!sameStrings(grant[key], expected)) throw coded("SCHEDULE_GRANT_SCOPE_CHANGED", "The prepared permission requirements changed after this grant was approved.");
  }
  return true;
}

export function revokeScheduleGrant(grant, { revokedAt = new Date().toISOString(), reason = "user_revoked" } = {}) {
  const validation = validateScheduleGrant(grant);
  if (!validation.ok) throw coded("SCHEDULE_GRANT_INVALID", validation.errors.join(" "));
  if (grant.status === "revoked") return structuredClone(grant);
  if (!validTimestamp(revokedAt) || Date.parse(revokedAt) < Date.parse(grant.createdAt)) throw coded("SCHEDULE_GRANT_REVOKED_AT_INVALID", "Schedule grant revocation time is invalid.");
  const next = {
    ...structuredClone(grant),
    status: "revoked",
    revoked: true,
    revokedAt,
    revokedReason: String(reason || "user_revoked").slice(0, 80),
    updatedAt: revokedAt
  };
  const result = validateScheduleGrant(next);
  if (!result.ok) throw coded("SCHEDULE_GRANT_INVALID", result.errors.join(" "));
  return next;
}

function validGrantId(value) { return typeof value === "string" && value.length >= 3 && value.length <= MAX_GRANT_ID_LENGTH && /^[a-zA-Z0-9._:-]+$/.test(value); }
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validateStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_ITEMS || value.some((item) => typeof item !== "string" || !item.trim())) errors.push(`${label} must be an array of up to ${MAX_SCOPE_ITEMS} non-empty strings.`);
}
function rejectPrivateFields(grant, errors) {
  for (const field of ["token", "secret", "apiKey", "password", "cookie", "authorization", "headers", "providerSecret", "inputValues", "runtimeInputs", "tabId"]) {
    if (Object.prototype.hasOwnProperty.call(grant, field)) errors.push(`Schedule grant must not contain private or transient field: ${field}.`);
  }
}
function sameStrings(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((item, index) => item === right[index]);
}
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
