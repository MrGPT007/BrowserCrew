import { validateSkill } from "./skills-contract.js";
import { migrateSkillContractMetadata } from "./skills-contract-metadata.js";

export const SKILL_PORTABLE_FORMAT = "browsercrew.skill";
export const SKILL_PORTABLE_FORMAT_VERSION = 1;
export const MAX_PORTABLE_SKILL_BYTES = 1_000_000;

const ENVELOPE_KEYS = new Set(["format", "formatVersion", "skill"]);
const EXECUTABLE_LIKE_KEYS = /^(?:code|script|javascript|eval|shell|command|remoteCode|remoteScript|executable|function|module|wasm|scriptUrl|codeUrl)$/i;

export function exportSkillBundle(skill) {
  const normalized = normalizePortableSkill(skill);
  const envelope = { format: SKILL_PORTABLE_FORMAT, formatVersion: SKILL_PORTABLE_FORMAT_VERSION, skill: normalized };
  return `${stableStringify(envelope)}\n`;
}

export function parseSkillBundle(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Choose a BrowserCrew Skill JSON file to import.");
  if (new TextEncoder().encode(text).byteLength > MAX_PORTABLE_SKILL_BYTES) throw new Error("That Skill file is too large. BrowserCrew accepts Skill JSON up to 1 MB.");

  let envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new Error("That file is not valid JSON."); }
  if (!isPlainObject(envelope)) throw new Error("Skill import must contain one JSON object.");
  for (const key of Object.keys(envelope)) if (!ENVELOPE_KEYS.has(key)) throw new Error(`Unsupported Skill bundle field: ${key}.`);
  if (envelope.format !== SKILL_PORTABLE_FORMAT) throw new Error("This is not a BrowserCrew Skill export.");
  if (envelope.formatVersion !== SKILL_PORTABLE_FORMAT_VERSION) throw new Error(`Unsupported Skill export version: ${String(envelope.formatVersion ?? "missing")}.`);
  if (!isPlainObject(envelope.skill)) throw new Error("Skill export is missing its declarative skill object.");

  rejectExecutableLikeKeys(envelope.skill, "$.skill");
  const sourceSkill = normalizePortableSkill(envelope.skill);
  const canonicalText = exportSkillBundle(sourceSkill);
  return { format: SKILL_PORTABLE_FORMAT, formatVersion: SKILL_PORTABLE_FORMAT_VERSION, sourceSkill, canonicalText, preview: previewPortableSkill(sourceSkill) };
}

export function importSkillAsDraft(parsedOrText, { id, createdAt } = {}) {
  const parsed = typeof parsedOrText === "string" ? parseSkillBundle(parsedOrText) : parsedOrText;
  if (!parsed?.sourceSkill) throw new Error("Parse the Skill file before importing it.");
  if (!id || !createdAt) throw new Error("Imported Skill requires a new id and creation time.");

  const source = normalizePortableSkill(parsed.sourceSkill);
  const draft = {
    ...source,
    id,
    version: "0.1.0",
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    provenance: {
      source: "skill_import",
      createdAt,
      sourceSkillRef: { id: source.id, version: source.version },
      portableFormatVersion: SKILL_PORTABLE_FORMAT_VERSION
    }
  };
  delete draft.approval;
  delete draft.archivedAt;

  const check = validateSkill(draft, { requireMetadata: true });
  if (!check.ok) throw new Error(`Imported draft is invalid: ${check.errors.join(" ")}`);
  return draft;
}

export function previewPortableSkill(skill) {
  const normalized = normalizePortableSkill(skill);
  return {
    sourceRef: { id: normalized.id, version: normalized.version, status: normalized.status },
    title: normalized.title,
    description: normalized.description,
    allowedOrigins: structuredClone(normalized.allowedOrigins),
    allowedResources: structuredClone(normalized.allowedResources || []),
    actionClasses: structuredClone(normalized.actionClasses),
    dataDestinations: structuredClone(normalized.dataDestinations || []),
    providerCapabilities: structuredClone(normalized.providerRequirements?.capabilities || []),
    inputCount: Object.keys(normalized.inputs || {}).length,
    stepCount: normalized.steps.length,
    budgets: structuredClone(normalized.budgets),
    compatibility: structuredClone(normalized.compatibility)
  };
}

export function stableStringify(value) { return JSON.stringify(sortValue(value), null, 2); }

function normalizePortableSkill(rawSkill) {
  if (!isPlainObject(rawSkill)) throw new Error("Skill must be a JSON object.");
  rejectExecutableLikeKeys(rawSkill, "$.skill");
  const rawCheck = validateSkill(rawSkill);
  if (!rawCheck.ok) throw new Error(`Skill failed validation: ${rawCheck.errors.join(" ")}`);
  const effective = migrateSkillContractMetadata(rawSkill);

  const skill = {
    schemaVersion: effective.schemaVersion,
    id: effective.id,
    version: effective.version,
    status: effective.status,
    title: effective.title,
    description: effective.description,
    inputs: projectInputs(effective.inputs || {}),
    allowedOrigins: structuredClone(effective.allowedOrigins),
    allowedResources: structuredClone(effective.allowedResources || []),
    actionClasses: structuredClone(effective.actionClasses),
    dataDestinations: structuredClone(effective.dataDestinations || []),
    providerRequirements: structuredClone(effective.providerRequirements),
    budgets: { maxSteps: effective.budgets.maxSteps, maxMinutes: effective.budgets.maxMinutes },
    steps: effective.steps.map(projectStep),
    completionCriteria: effective.completionCriteria.map((item) => ({ claim: item.claim, verification: item.verification })),
    verificationRules: structuredClone(effective.verificationRules),
    writePolicy: structuredClone(effective.writePolicy),
    recovery: { retryWrites: effective.recovery.retryWrites, reconcileUnknownWrites: effective.recovery.reconcileUnknownWrites },
    provenance: structuredClone(effective.provenance),
    createdAt: effective.createdAt,
    updatedAt: effective.updatedAt,
    compatibility: structuredClone(effective.compatibility)
  };
  if (isPlainObject(effective.approval)) skill.approval = structuredClone(effective.approval);
  if (typeof effective.archivedAt === "string") skill.archivedAt = effective.archivedAt;

  const check = validateSkill(skill, { requireMetadata: true });
  if (!check.ok) throw new Error(`Portable Skill normalization failed: ${check.errors.join(" ")}`);
  return skill;
}

function projectInputs(inputs) {
  const out = {};
  for (const [name, input] of Object.entries(inputs)) {
    const projected = {};
    for (const key of ["name", "type", "required", "secret", "label", "default", "maxLength"]) if (Object.prototype.hasOwnProperty.call(input, key)) projected[key] = structuredClone(input[key]);
    out[name] = projected;
  }
  return out;
}

function projectStep(step) {
  const projected = { id: step.id, kind: step.kind, purpose: step.purpose };
  for (const key of ["origin", "value", "url", "timeoutMs"]) if (Object.prototype.hasOwnProperty.call(step, key)) projected[key] = structuredClone(step[key]);
  if (isPlainObject(step.target)) projected.target = pick(step.target, ["role", "label", "ariaLabel", "name", "id", "testId", "type", "autocomplete", "placeholder"]);
  if (isPlainObject(step.expect)) projected.expect = pick(step.expect, ["visibleText", "urlIncludes", "role", "label", "state"]);
  if (isPlainObject(step.download)) projected.download = pick(step.download, ["userInitiated", "expectedUrlOrigin"]);
  return projected;
}

function pick(value, keys) {
  const out = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = structuredClone(value[key]);
  return out;
}
function rejectExecutableLikeKeys(value, path) {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectExecutableLikeKeys(item, `${path}[${index}]`));
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (EXECUTABLE_LIKE_KEYS.test(key)) throw new Error(`Imported Skill contains forbidden executable field at ${path}.${key}.`);
    rejectExecutableLikeKeys(child, `${path}.${key}`);
  }
}
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
