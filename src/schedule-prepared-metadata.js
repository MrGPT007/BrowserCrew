export const PREPARED_SCHEDULE_METADATA_VERSION = 1;

export function createPreparedScheduleMetadata({ skill, pageUrl, reviewedAt = new Date().toISOString() } = {}) {
  if (!skill || skill.status !== "approved") throw coded("SCHEDULE_PREPARED_SKILL_REQUIRED", "Choose an approved exact Skill version before reviewing a starting page.");
  const startResource = createStartResource(skill, pageUrl, reviewedAt);
  const authorityPlan = createAuthorityPlan(skill, reviewedAt);
  return { startResource, authorityPlan };
}

export function validatePreparedScheduleMetadata(schedule) {
  const errors = [];
  const hasStart = Object.prototype.hasOwnProperty.call(schedule || {}, "startResource");
  const hasPlan = Object.prototype.hasOwnProperty.call(schedule || {}, "authorityPlan");
  if (!hasStart && !hasPlan) return { ok: true, legacy: true, bindingReady: false, errors: [] };
  if (hasStart !== hasPlan) errors.push("Prepared execution metadata must include both startResource and authorityPlan.");
  if (hasStart) validateStartResource(schedule.startResource, errors);
  if (hasPlan) validateAuthorityPlan(schedule.authorityPlan, schedule.skillRef, errors);
  return { ok: errors.length === 0, legacy: false, bindingReady: errors.length === 0, errors };
}

export function preparedScheduleNeedsBinding(schedule) {
  const result = validatePreparedScheduleMetadata(schedule);
  return result.legacy || !result.ok || !result.bindingReady;
}

export function assertPreparedScheduleMetadataForSkill(schedule, skill) {
  const validation = validatePreparedScheduleMetadata(schedule);
  if (validation.legacy) throw coded("SCHEDULE_BINDING_REQUIRED", "Review a safe starting page before this prepared schedule can ever run.");
  if (!validation.ok || !validation.bindingReady) throw coded("SCHEDULE_BINDING_INVALID", `Prepared schedule binding is invalid: ${validation.errors.join(" ")}`);
  if (!skill || skill.status !== "approved" || schedule?.skillRef?.id !== skill.id || schedule?.skillRef?.version !== skill.version) {
    throw coded("SCHEDULE_BINDING_SKILL_MISMATCH", "The prepared starting-page review no longer matches the exact approved Skill version.");
  }
  if (!(skill.allowedOrigins || []).includes(schedule.startResource.origin)) {
    throw coded("SCHEDULE_START_PAGE_OUT_OF_SCOPE", "The prepared starting page is outside this Skill's reviewed websites.");
  }
  const expectedResources = skill.allowedResources || [];
  if (!sameStrings(schedule.startResource.expectedResources, expectedResources)) {
    throw coded("SCHEDULE_BINDING_RESOURCE_MISMATCH", "The prepared starting-page resource requirements no longer match this exact Skill version.");
  }
  const expectedPlan = {
    origins: skill.allowedOrigins || [],
    resources: expectedResources,
    actionClasses: skill.actionClasses || [],
    providerCapabilities: skill.providerRequirements?.capabilities || [],
    dataDestinations: skill.dataDestinations || []
  };
  for (const [key, expected] of Object.entries(expectedPlan)) {
    if (!sameStrings(schedule.authorityPlan[key], expected)) {
      throw coded("SCHEDULE_AUTHORITY_PLAN_MISMATCH", "The prepared permission plan no longer matches this exact Skill version.");
    }
  }
  if (schedule.authorityPlan.reviewedAt !== schedule.startResource.reviewedAt) {
    throw coded("SCHEDULE_BINDING_REVIEW_MISMATCH", "The starting page and permission plan must come from the same explicit review.");
  }
  return true;
}

function createStartResource(skill, pageUrl, reviewedAt) {
  const url = safeReviewedUrl(pageUrl);
  if (!(skill.allowedOrigins || []).includes(url.origin)) {
    throw coded("SCHEDULE_START_PAGE_OUT_OF_SCOPE", "Choose a starting page on one of this Skill's reviewed websites.");
  }
  return {
    schemaVersion: PREPARED_SCHEDULE_METADATA_VERSION,
    kind: "exact_url",
    url: url.href,
    origin: url.origin,
    expectedResources: [...(skill.allowedResources || [])],
    reviewedAt
  };
}

function createAuthorityPlan(skill, reviewedAt) {
  return {
    schemaVersion: PREPARED_SCHEDULE_METADATA_VERSION,
    status: "prepared_only",
    skillRef: { id: skill.id, version: skill.version },
    origins: [...(skill.allowedOrigins || [])],
    resources: [...(skill.allowedResources || [])],
    actionClasses: [...(skill.actionClasses || [])],
    providerCapabilities: [...(skill.providerRequirements?.capabilities || [])],
    dataDestinations: [...(skill.dataDestinations || [])],
    reviewedAt
  };
}

function validateStartResource(resource, errors) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    errors.push("startResource must be a reviewed starting-page object.");
    return;
  }
  if (resource.schemaVersion !== PREPARED_SCHEDULE_METADATA_VERSION) errors.push(`startResource.schemaVersion must be ${PREPARED_SCHEDULE_METADATA_VERSION}.`);
  if (resource.kind !== "exact_url") errors.push("startResource.kind must be exact_url.");
  let url = null;
  try { url = safeReviewedUrl(resource.url); }
  catch (error) { errors.push(error.message); }
  if (url && resource.origin !== url.origin) errors.push("startResource.origin must exactly match its reviewed URL origin.");
  validateStringArray(resource.expectedResources, "startResource.expectedResources", errors);
  if (!validTimestamp(resource.reviewedAt)) errors.push("startResource.reviewedAt must be an ISO timestamp.");
  rejectOwnFields(resource, ["tabId", "username", "password", "query", "search", "hash", "token", "secret", "cookie", "authorization", "headers", "apiKey", "grant", "grantId"], "startResource", errors);
}

function validateAuthorityPlan(plan, skillRef, errors) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    errors.push("authorityPlan must be a prepared-only requirements object.");
    return;
  }
  if (plan.schemaVersion !== PREPARED_SCHEDULE_METADATA_VERSION) errors.push(`authorityPlan.schemaVersion must be ${PREPARED_SCHEDULE_METADATA_VERSION}.`);
  if (plan.status !== "prepared_only") errors.push("authorityPlan.status must remain prepared_only until explicit future activation.");
  if (!plan.skillRef || plan.skillRef.id !== skillRef?.id || plan.skillRef.version !== skillRef?.version) errors.push("authorityPlan.skillRef must match the exact scheduled Skill version.");
  for (const [key, label] of [["origins", "authorityPlan.origins"], ["resources", "authorityPlan.resources"], ["actionClasses", "authorityPlan.actionClasses"], ["providerCapabilities", "authorityPlan.providerCapabilities"], ["dataDestinations", "authorityPlan.dataDestinations"]]) {
    validateStringArray(plan[key], label, errors);
  }
  if (!validTimestamp(plan.reviewedAt)) errors.push("authorityPlan.reviewedAt must be an ISO timestamp.");
  rejectOwnFields(plan, ["scope", "expiresAt", "revoked", "active", "token", "secret", "grantId", "id", "grant", "permissions", "authorization", "credential", "cookie", "headers", "apiKey", "password"], "authorityPlan", errors);
}

function safeReviewedUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw coded("SCHEDULE_START_PAGE_INVALID", "Choose a normal http or https starting page."); }
  if (!/^https?:$/.test(url.protocol)) throw coded("SCHEDULE_START_PAGE_INVALID", "Choose a normal http or https starting page.");
  if (url.username || url.password) throw coded("SCHEDULE_START_PAGE_PRIVATE_URL", "Starting pages cannot save usernames or passwords in the URL.");
  if (url.search || url.hash) throw coded("SCHEDULE_START_PAGE_PRIVATE_URL", "Choose a starting page without query parameters or a page fragment. BrowserCrew will not persist private or session-specific URL data for unattended runs.");
  return url;
}

function validateStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) errors.push(`${label} must be an array of non-empty strings.`);
}

function rejectOwnFields(value, fields, label, errors) {
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${label} must not contain private or executable field: ${field}.`);
}

function sameStrings(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((item, index) => item === right[index]);
}

function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
