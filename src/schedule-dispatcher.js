import { materializeSkillSteps } from "./skills-contract.js";
import { assertSkillMetadataGrantCoversRequirements } from "./skills-contract-metadata.js";
import { assertGrantCoversSkill } from "./skills-runner.js";
import { executeSkillVersion } from "./skills-runtime.js";

export function createScheduleSkillDispatcher({ resolveProvider, resolveGrant, resolveResource, executeSkill = executeSkillVersion } = {}) {
  if (typeof resolveProvider !== "function") throw coded("SCHEDULE_PROVIDER_RESOLVER_REQUIRED", "Scheduled Skill dispatch needs an explicit provider resolver.");
  if (typeof resolveGrant !== "function") throw coded("SCHEDULE_GRANT_RESOLVER_REQUIRED", "Scheduled Skill dispatch needs an explicit grant resolver.");
  if (typeof resolveResource !== "function") throw coded("SCHEDULE_RESOURCE_RESOLVER_REQUIRED", "Scheduled Skill dispatch needs an explicit resource resolver.");
  if (typeof executeSkill !== "function") throw coded("SCHEDULE_SKILL_EXECUTOR_REQUIRED", "Scheduled Skill dispatch needs the normal exact-version Skill executor.");

  return async function dispatchScheduledSkill(input = {}) {
    const schedule = input.schedule;
    const skill = input.skill;
    const resolved = await resolveScheduleExecution({ schedule, skill, resolveProvider, resolveGrant, resolveResource });

    if (resolved.blockers.length) throwBlocker(resolved.blockers[0]);

    if (input.mode === "preflight") {
      return {
        grantsValid: true,
        providerAvailable: true,
        resourceFresh: true,
        blockers: []
      };
    }

    // Re-resolve immediately before dispatch instead of trusting preflight state.
    const final = await resolveScheduleExecution({ schedule, skill, resolveProvider, resolveGrant, resolveResource });
    if (final.blockers.length) throwBlocker(final.blockers[0]);

    const result = await executeSkill({
      skillId: skill.id,
      version: skill.version,
      tabId: final.resource.tabId,
      inputValues: final.inputValues,
      grant: final.grant
    });
    return {
      ok: result?.ok === true,
      taskId: result?.run?.id || null,
      task: result?.run ? { id: result.run.id, status: result.run.status, error: result.run.error || null } : null,
      skillRun: result?.run || null,
      error: result?.error || undefined
    };
  };
}

export async function inspectScheduleSkillReadiness({ schedule, skill, resolveProvider, resolveGrant, resolveResource } = {}) {
  const resolved = await resolveScheduleExecution({ schedule, skill, resolveProvider, resolveGrant, resolveResource });
  return {
    ready: resolved.blockers.length === 0,
    grantsValid: resolved.grantsValid,
    providerAvailable: resolved.providerAvailable,
    resourceFresh: resolved.resourceFresh,
    blockers: resolved.blockers.map(publicBlocker),
    inputNames: Object.keys(resolved.inputValues || {}),
    resource: resolved.resource ? publicResource(resolved.resource) : null,
    provider: resolved.provider ? publicProvider(resolved.provider) : null
  };
}

async function resolveScheduleExecution({ schedule, skill, resolveProvider, resolveGrant, resolveResource }) {
  const blockers = [];
  assertExactScheduleSkill(schedule, skill, blockers);
  assertBudgetsDoNotWiden(schedule, skill, blockers);
  const inputValues = scheduledInputDefaults(skill, blockers);

  let provider = null;
  let grant = null;
  let resource = null;

  if (typeof resolveProvider !== "function") blockers.push(block("SCHEDULE_PROVIDER_RESOLVER_REQUIRED", "BrowserCrew cannot verify the saved AI connection for this schedule."));
  else {
    try { provider = await resolveProvider(schedule?.providerRef, { schedule, skill }); }
    catch { provider = null; }
    assertProvider(schedule, skill, provider, blockers);
  }

  if (typeof resolveGrant !== "function") blockers.push(block("SCHEDULE_GRANT_RESOLVER_REQUIRED", "BrowserCrew cannot resolve the saved permission grant for this schedule."));
  else {
    try { grant = await resolveGrant(schedule?.grantRefs || [], { schedule, skill }); }
    catch { grant = null; }
    assertScheduledGrant(skill, grant, blockers);
  }

  if (typeof resolveResource !== "function") blockers.push(block("SCHEDULE_RESOURCE_RESOLVER_REQUIRED", "BrowserCrew cannot re-find the saved starting resource for this schedule."));
  else {
    try { resource = await resolveResource({ schedule, skill, grant, provider }); }
    catch { resource = null; }
    assertFreshResource(skill, resource, blockers);
  }

  const unique = dedupeBlockers(blockers);
  return {
    blockers: unique,
    provider,
    grant,
    resource,
    inputValues,
    grantsValid: !unique.some((item) => item.code.startsWith("SCHEDULE_GRANT_")),
    providerAvailable: !unique.some((item) => item.code.startsWith("SCHEDULE_PROVIDER_")),
    resourceFresh: !unique.some((item) => item.code.startsWith("SCHEDULE_RESOURCE_"))
  };
}

function assertExactScheduleSkill(schedule, skill, blockers) {
  if (!schedule || !skill || schedule.skillRef?.id !== skill.id || schedule.skillRef?.version !== skill.version || skill.status !== "approved") {
    blockers.push(block("SCHEDULE_SKILL_VERSION_CHANGED", "The schedule must still point to the exact approved Skill version that was reviewed."));
  }
}

function assertBudgetsDoNotWiden(schedule, skill, blockers) {
  const scheduleSteps = Number(schedule?.budgets?.maxSteps);
  const scheduleMinutes = Number(schedule?.budgets?.maxMinutes);
  const skillSteps = Number(skill?.budgets?.maxSteps);
  const skillMinutes = Number(skill?.budgets?.maxMinutes);
  if (!Number.isInteger(scheduleSteps) || !Number.isInteger(scheduleMinutes) || !Number.isInteger(skillSteps) || !Number.isInteger(skillMinutes)
    || scheduleSteps > skillSteps || scheduleMinutes > skillMinutes) {
    blockers.push(block("SCHEDULE_BUDGET_WIDENED", "The schedule cannot use a larger step or time budget than its approved Skill version."));
  }
}

function scheduledInputDefaults(skill, blockers) {
  const values = {};
  for (const [name, definition] of Object.entries(skill?.inputs || {})) {
    if (definition?.secret === true) {
      blockers.push(block("SCHEDULE_SECRET_INPUT_REQUIRED", `Scheduled runs cannot persist or guess the private input “${name}”.`));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(definition || {}, "default")) {
      blockers.push(block("SCHEDULE_INPUT_REQUIRED", `Scheduled runs need a reviewed saved value for “${name}” before they can run unattended.`));
      continue;
    }
    values[name] = structuredClone(definition.default);
  }
  if (!blockers.some((item) => item.code === "SCHEDULE_SECRET_INPUT_REQUIRED" || item.code === "SCHEDULE_INPUT_REQUIRED")) {
    try { materializeSkillSteps(skill, values); }
    catch { blockers.push(block("SCHEDULE_INPUT_INVALID", "The saved unattended Skill inputs no longer satisfy this exact Skill version.")); }
  }
  return values;
}

function assertProvider(schedule, skill, provider, blockers) {
  if (!provider || provider.available !== true || provider.id !== schedule?.providerRef) {
    blockers.push(block("SCHEDULE_PROVIDER_UNAVAILABLE", "The named AI connection is unavailable or no longer matches this schedule."));
    return;
  }
  const capabilities = new Set(provider.capabilities || []);
  for (const required of skill?.providerRequirements?.capabilities || []) {
    if (!capabilities.has(required)) {
      blockers.push(block("SCHEDULE_PROVIDER_CAPABILITY_MISSING", `The named AI connection does not provide required capability “${required}”.`));
    }
  }
}

function assertScheduledGrant(skill, grant, blockers) {
  if (!grant || grant.scope !== "schedule" || grant.skillRef?.id !== skill?.id || grant.skillRef?.version !== skill?.version) {
    blockers.push(block("SCHEDULE_GRANT_SKILL_MISMATCH", "The schedule needs a schedule-scoped permission grant pinned to this exact Skill version."));
    return;
  }
  try {
    assertGrantCoversSkill(skill, grant);
    assertSkillMetadataGrantCoversRequirements(skill, grant);
  } catch (error) {
    blockers.push(block("SCHEDULE_GRANT_INVALID", error?.message || "The saved schedule grant is missing, expired, revoked, or too narrow."));
  }
}

function assertFreshResource(skill, resource, blockers) {
  if (!resource || resource.fresh !== true || !Number.isInteger(resource.tabId) || typeof resource.url !== "string") {
    blockers.push(block("SCHEDULE_RESOURCE_STALE", "BrowserCrew could not safely re-find the saved starting resource."));
    return;
  }
  let origin;
  try { origin = new URL(resource.url).origin; }
  catch { origin = null; }
  if (!origin || !(skill?.allowedOrigins || []).includes(origin)) {
    blockers.push(block("SCHEDULE_RESOURCE_OUT_OF_SCOPE", "The re-resolved starting page is outside the approved Skill site scope."));
  }
  const resolvedResources = new Set(resource.resources || []);
  for (const required of skill?.allowedResources || []) {
    if (!resolvedResources.has(required)) blockers.push(block("SCHEDULE_RESOURCE_STALE", `Required resource “${required}” was not re-resolved for this run.`));
  }
}

function throwBlocker(item) { throw coded(item.code, item.message); }
function publicBlocker(item) { return { code: item.code, message: item.message }; }
function publicResource(resource) { return { tabId: resource.tabId, url: resource.url, resources: [...(resource.resources || [])] }; }
function publicProvider(provider) { return { id: provider.id, available: provider.available === true, capabilities: [...(provider.capabilities || [])] }; }
function block(code, message) { return { code, message }; }
function dedupeBlockers(items) { const seen = new Set(); return items.filter((item) => { const key = `${item.code}:${item.message}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
