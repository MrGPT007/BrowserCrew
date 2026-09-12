import { assertSkillExecutable, promoteSkillDraft, validateSkill } from "./skills-contract.js";
import { runApprovedSkill } from "./skills-runner.js";

const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const LEGACY_SKILLS_KEY = "browsercrew.skills.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const SKILLS_PORT = "browsercrew-skills";
const MAX_SKILLS = 100;
const MAX_SKILL_RUNS = 100;
const activeSkillRuns = new Map();

reconcileInterruptedSkillRuns().catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SKILLS_PORT) return;
  port.onMessage.addListener((message) => {
    handleSkillMessage(message).then((result) => port.postMessage({ requestId: message?.requestId, ...result })).catch((error) => {
      port.postMessage({ requestId: message?.requestId, ok: false, error: safeError(error), run: error?.run || null });
    });
  });
});

async function handleSkillMessage(message) {
  switch (message?.type) {
    case "list": return { ok: true, skills: await listSkillVersions() };
    case "saveDraft": return saveSkillDraft(message.skill);
    case "approve": return approveSkillVersion(message.skillId, message.version);
    case "archive": return archiveSkillVersion(message.skillId, message.version);
    case "deleteDraft": return deleteDraft(message.skillId, message.version);
    case "get": return getSkillVersion(message.skillId, message.version);
    case "migrateLegacy": return migrateLegacySkills();
    case "run": return executeSkillVersion(message);
    case "stopRun": return stopSkillRun(message.runId);
    case "listRuns": return { ok: true, runs: await listSkillRuns() };
    default: return { ok: false, error: { code: "UNKNOWN_SKILL_REQUEST", message: "BrowserCrew received an unknown skill request." } };
  }
}

export async function listSkillVersions() {
  const data = await chrome.storage.local.get(SKILL_LIBRARY_KEY);
  const skills = Array.isArray(data[SKILL_LIBRARY_KEY]) ? data[SKILL_LIBRARY_KEY] : [];
  return skills.sort(compareSkills);
}

export async function getSkillVersion(skillId, version) {
  const skill = (await listSkillVersions()).find((item) => item.id === skillId && item.version === version) || null;
  return { ok: Boolean(skill), skill, error: skill ? undefined : { code: "SKILL_VERSION_NOT_FOUND", message: "That saved skill version could not be found." } };
}

export async function saveSkillDraft(input) {
  const skill = structuredClone(input || {});
  skill.status = "draft";
  const result = validateSkill(skill);
  if (!result.ok) throw coded("SKILL_INVALID", result.errors.join(" "));

  const skills = await listSkillVersions();
  const existing = skills.findIndex((item) => item.id === skill.id && item.version === skill.version);
  if (existing >= 0 && skills[existing].status !== "draft") throw coded("SKILL_VERSION_IMMUTABLE", "Approved or archived skill versions cannot be overwritten. Create a new version instead.");
  if (existing < 0 && skills.length >= MAX_SKILLS) throw coded("SKILL_LIMIT", `BrowserCrew can keep up to ${MAX_SKILLS} skill versions in this build.`);
  if (existing >= 0) skills[existing] = skill;
  else skills.push(skill);
  await persist(skills);
  return { ok: true, skill };
}

export async function approveSkillVersion(skillId, version) {
  const skills = await listSkillVersions();
  const index = skills.findIndex((item) => item.id === skillId && item.version === version);
  if (index < 0) throw coded("SKILL_VERSION_NOT_FOUND", "That draft skill version could not be found.");
  const approved = promoteSkillDraft(skills[index], { approvedAt: new Date().toISOString(), approvedBy: "user" });
  assertSkillExecutable(approved);
  skills[index] = approved;
  await persist(skills);
  return { ok: true, skill: approved };
}

export async function archiveSkillVersion(skillId, version) {
  const skills = await listSkillVersions();
  const index = skills.findIndex((item) => item.id === skillId && item.version === version);
  if (index < 0) throw coded("SKILL_VERSION_NOT_FOUND", "That skill version could not be found.");
  if (skills[index].status !== "approved") throw coded("SKILL_NOT_APPROVED", "Only an approved skill version can be archived.");
  skills[index] = { ...skills[index], status: "archived", archivedAt: new Date().toISOString() };
  await persist(skills);
  return { ok: true, skill: skills[index] };
}

export async function deleteDraft(skillId, version) {
  const skills = await listSkillVersions();
  const target = skills.find((item) => item.id === skillId && item.version === version);
  if (!target) throw coded("SKILL_VERSION_NOT_FOUND", "That draft skill version could not be found.");
  if (target.status !== "draft") throw coded("SKILL_VERSION_IMMUTABLE", "Approved skill versions stay immutable. Archive them instead of deleting them from history.");
  await persist(skills.filter((item) => item !== target));
  return { ok: true };
}

export async function executeSkillVersion({ skillId, version, tabId, inputValues = {}, grant = null } = {}) {
  const response = await getSkillVersion(skillId, version);
  if (!response.ok || !response.skill) throw coded("SKILL_VERSION_NOT_FOUND", "That exact skill version could not be found.");
  const skill = response.skill;
  assertSkillExecutable(skill);

  const run = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    skillRef: { id: skill.id, version: skill.version },
    tabId,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    receipt: null,
    error: null
  };
  await upsertSkillRun(run);

  const controller = new AbortController();
  activeSkillRuns.set(run.id, controller);
  try {
    const result = await runApprovedSkill({
      skill,
      inputValues,
      tabId,
      grant,
      signal: controller.signal,
      onEvent: async (event) => appendSkillRunEvent(run.id, event)
    });
    const completed = await mutateSkillRun(run.id, (item) => {
      item.status = "completed";
      item.receipt = result.receipt;
      item.completedAt = new Date().toISOString();
      item.error = null;
    });
    return { ok: true, run: completed };
  } catch (error) {
    const stopped = error?.code === "SKILL_RUN_STOPPED";
    const failed = await mutateSkillRun(run.id, (item) => {
      item.status = stopped ? "cancelled" : "failed";
      item.completedAt = new Date().toISOString();
      item.error = safeError(error);
      if (error?.receipt) item.receipt = error.receipt;
    });
    return { ok: false, run: failed, error: safeError(error) };
  } finally {
    activeSkillRuns.delete(run.id);
  }
}

export async function stopSkillRun(runId) {
  if (!runId) throw coded("SKILL_RUN_ID_REQUIRED", "Choose the skill run you want to stop.");
  const controller = activeSkillRuns.get(runId);
  if (!controller) {
    const existing = (await listSkillRuns()).find((item) => item.id === runId);
    if (!existing) throw coded("SKILL_RUN_NOT_FOUND", "That skill run could not be found.");
    return { ok: true, run: existing, alreadySettled: existing.status !== "running" };
  }
  controller.abort();
  const run = await mutateSkillRun(runId, (item) => {
    item.stopRequestedAt = new Date().toISOString();
  });
  return { ok: true, run, stopRequested: true };
}

export async function listSkillRuns() {
  const data = await chrome.storage.local.get(SKILL_RUNS_KEY);
  return Array.isArray(data[SKILL_RUNS_KEY]) ? data[SKILL_RUNS_KEY] : [];
}

export async function migrateLegacySkills() {
  const data = await chrome.storage.local.get([LEGACY_SKILLS_KEY, SKILL_LIBRARY_KEY]);
  const legacy = Array.isArray(data[LEGACY_SKILLS_KEY]) ? data[LEGACY_SKILLS_KEY] : [];
  const existing = Array.isArray(data[SKILL_LIBRARY_KEY]) ? data[SKILL_LIBRARY_KEY] : [];
  const existingLegacyIds = new Set(existing.map((item) => item.provenance?.legacySkillId).filter(Boolean));
  const migrated = [];

  for (const old of legacy) {
    if (!old?.id || existingLegacyIds.has(old.id)) continue;
    const id = slug(old.name || "reusable-job", old.id);
    const createdAt = old.createdAt || new Date().toISOString();
    const draft = {
      schemaVersion: 1,
      id,
      version: "0.1.0",
      status: "draft",
      title: String(old.name || "Reusable job").slice(0, 120),
      description: String(old.goal || "Review and finish migrating this reusable job before running it.").slice(0, 600),
      inputs: {},
      allowedOrigins: ["https://migration.invalid"],
      actionClasses: ["read"],
      dataDestinations: [],
      budgets: { maxSteps: 20, maxMinutes: 10 },
      steps: [{
        id: "step-01",
        kind: "verify",
        purpose: "Review the legacy reusable-job instructions and replace this migration placeholder with semantic steps.",
        origin: "https://migration.invalid",
        expect: { state: "manual_migration_required" }
      }],
      completionCriteria: [{
        claim: "The legacy reusable job has been reviewed and converted to explicit semantic steps.",
        verification: "A user must edit and approve this draft before it can execute."
      }],
      recovery: { retryWrites: false, reconcileUnknownWrites: true },
      provenance: { source: "legacy_reusable_job", legacySkillId: old.id, createdAt }
    };
    const validation = validateSkill(draft);
    if (!validation.ok) continue;
    existing.push(draft);
    migrated.push(draft);
  }

  if (migrated.length) await persist(existing);
  return { ok: true, migratedCount: migrated.length, skills: migrated };
}

async function appendSkillRunEvent(runId, event) {
  return mutateSkillRun(runId, (run) => {
    run.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...sanitizeRunEvent(event) });
    run.events = run.events.slice(-250);
  });
}

async function reconcileInterruptedSkillRuns() {
  const runs = await listSkillRuns();
  let changed = false;
  for (const run of runs) {
    if (run.status !== "running") continue;
    run.status = "paused";
    run.updatedAt = new Date().toISOString();
    run.error = { code: "SKILL_WORKER_RESTARTED", message: "Chrome restarted BrowserCrew during this skill run. The run was paused and will not replay an uncertain step automatically." };
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [SKILL_RUNS_KEY]: runs.slice(0, MAX_SKILL_RUNS) });
}

async function upsertSkillRun(run) {
  const runs = await listSkillRuns();
  const index = runs.findIndex((item) => item.id === run.id);
  if (index >= 0) runs[index] = run;
  else runs.unshift(run);
  await chrome.storage.local.set({ [SKILL_RUNS_KEY]: runs.slice(0, MAX_SKILL_RUNS) });
  return run;
}

async function mutateSkillRun(runId, mutate) {
  const runs = await listSkillRuns();
  const index = runs.findIndex((item) => item.id === runId);
  if (index < 0) throw coded("SKILL_RUN_NOT_FOUND", "That skill run could not be found.");
  mutate(runs[index]);
  runs[index].updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [SKILL_RUNS_KEY]: runs.slice(0, MAX_SKILL_RUNS) });
  return runs[index];
}

async function persist(skills) {
  const sorted = [...skills].sort(compareSkills).slice(0, MAX_SKILLS);
  await chrome.storage.local.set({ [SKILL_LIBRARY_KEY]: sorted });
}

function sanitizeRunEvent(event) {
  const copy = structuredClone(event || {});
  delete copy.value;
  delete copy.inputValues;
  delete copy.secret;
  return copy;
}

function compareSkills(a, b) {
  return String(b.provenance?.createdAt || "").localeCompare(String(a.provenance?.createdAt || "")) || String(a.id).localeCompare(String(b.id)) || String(b.version).localeCompare(String(a.version));
}

function slug(name, fallback) {
  const base = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "reusable-job";
  const suffix = String(fallback || crypto.randomUUID()).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `${base}-${suffix}`;
}

function safeError(error) { return { code: error?.code || "SKILL_LIBRARY_ERROR", message: error?.message || "BrowserCrew could not update this skill." }; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
