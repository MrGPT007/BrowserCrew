export const SKILL_SCHEMA_VERSION = 1;
export const SKILL_STATUSES = Object.freeze(["draft", "approved", "archived"]);
export const SKILL_STEP_KINDS = Object.freeze([
  "navigate",
  "click",
  "type",
  "select",
  "waitFor",
  "verify",
  "download"
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const INPUT_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set([
  "code",
  "script",
  "javascript",
  "eval",
  "shell",
  "command",
  "remoteCode",
  "remoteScript",
  "cookie",
  "cookies",
  "authHeader",
  "authorization"
]);

export function validateSkill(skill, { requireApproved = false } = {}) {
  const errors = [];
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return { ok: false, errors: ["Skill must be an object."] };

  if (skill.schemaVersion !== SKILL_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SKILL_SCHEMA_VERSION}.`);
  if (!ID_PATTERN.test(String(skill.id || ""))) errors.push("id must be a stable lowercase identifier.");
  if (!VERSION_PATTERN.test(String(skill.version || ""))) errors.push("version must use semantic x.y.z form.");
  if (!SKILL_STATUSES.includes(skill.status)) errors.push(`status must be one of: ${SKILL_STATUSES.join(", ")}.`);
  if (requireApproved && skill.status !== "approved") errors.push("Only approved skill versions may execute.");
  if (!cleanText(skill.title, 120)) errors.push("title is required and must be 120 characters or fewer.");
  if (!cleanText(skill.description, 600)) errors.push("description is required and must be 600 characters or fewer.");

  const inputs = skill.inputs || {};
  if (!isPlainObject(inputs)) errors.push("inputs must be an object keyed by input name.");
  else for (const [name, input] of Object.entries(inputs)) validateInput(name, input, errors);

  validateStringArray(skill.allowedOrigins, "allowedOrigins", errors, { min: 1, max: 32 });
  for (const origin of skill.allowedOrigins || []) {
    try {
      const url = new URL(origin);
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin) errors.push(`allowedOrigins contains non-origin value: ${origin}`);
    } catch {
      errors.push(`allowedOrigins contains invalid URL: ${origin}`);
    }
  }

  validateStringArray(skill.actionClasses, "actionClasses", errors, { min: 1, max: 32 });
  validateStringArray(skill.dataDestinations || [], "dataDestinations", errors, { min: 0, max: 32 });
  if (!isPlainObject(skill.budgets)) errors.push("budgets must be an object.");
  else {
    if (!positiveInteger(skill.budgets.maxSteps, 1, 500)) errors.push("budgets.maxSteps must be an integer from 1 to 500.");
    if (!positiveInteger(skill.budgets.maxMinutes, 1, 120)) errors.push("budgets.maxMinutes must be an integer from 1 to 120.");
  }

  if (!Array.isArray(skill.steps) || skill.steps.length < 1 || skill.steps.length > 200) errors.push("steps must contain 1 to 200 semantic steps.");
  else {
    const seen = new Set();
    skill.steps.forEach((step, index) => validateStep(step, index, inputs, seen, errors));
  }

  if (!Array.isArray(skill.completionCriteria) || !skill.completionCriteria.length) errors.push("completionCriteria must contain at least one verification criterion.");
  else for (const criterion of skill.completionCriteria) {
    if (!isPlainObject(criterion) || !cleanText(criterion.claim, 240) || !cleanText(criterion.verification, 240)) {
      errors.push("Each completion criterion needs claim and verification text.");
    }
  }

  if (!isPlainObject(skill.recovery) || skill.recovery.retryWrites !== false || skill.recovery.reconcileUnknownWrites !== true) {
    errors.push("recovery must preserve no-blind-write-retry semantics.");
  }

  if (!isPlainObject(skill.provenance)) errors.push("provenance is required.");
  else {
    if (!cleanText(skill.provenance.source, 80)) errors.push("provenance.source is required.");
    if (!cleanText(skill.provenance.createdAt, 64)) errors.push("provenance.createdAt is required.");
  }

  walkForForbiddenKeys(skill, "$", errors);
  return { ok: errors.length === 0, errors };
}

export function assertSkillExecutable(skill) {
  const result = validateSkill(skill, { requireApproved: true });
  if (!result.ok) throw new Error(`Skill is not executable: ${result.errors.join(" ")}`);
  return true;
}

export function materializeSkillSteps(skill, inputValues = {}) {
  assertSkillExecutable(skill);
  const resolved = {};
  for (const [name, definition] of Object.entries(skill.inputs || {})) {
    const hasValue = Object.prototype.hasOwnProperty.call(inputValues, name);
    const value = hasValue ? inputValues[name] : definition.default;
    if (definition.required && (value === undefined || value === null || value === "")) throw new Error(`Missing required skill input: ${name}`);
    if (value !== undefined) resolved[name] = validateInputValue(name, definition, value);
  }
  return skill.steps.map((step) => replaceInputRefs(structuredClone(step), resolved));
}

export function promoteSkillDraft(skill, { approvedAt, approvedBy = "user" } = {}) {
  const check = validateSkill(skill);
  if (!check.ok) throw new Error(`Cannot approve invalid skill: ${check.errors.join(" ")}`);
  if (skill.status !== "draft") throw new Error("Only a draft skill can be approved.");
  if (!approvedAt) throw new Error("approvedAt is required.");
  return {
    ...structuredClone(skill),
    status: "approved",
    approval: { approvedAt, approvedBy }
  };
}

function validateInput(name, input, errors) {
  if (!INPUT_NAME_PATTERN.test(name)) errors.push(`Invalid input name: ${name}`);
  if (!isPlainObject(input)) { errors.push(`Input ${name} must be an object.`); return; }
  if (!["string", "number", "boolean"].includes(input.type)) errors.push(`Input ${name} has unsupported type.`);
  if (input.secret === true && Object.prototype.hasOwnProperty.call(input, "default")) errors.push(`Secret input ${name} cannot have a persisted default.`);
  if (input.label && !cleanText(input.label, 120)) errors.push(`Input ${name} label is invalid.`);
}

function validateStep(step, index, inputs, seen, errors) {
  const label = `steps[${index}]`;
  if (!isPlainObject(step)) { errors.push(`${label} must be an object.`); return; }
  if (!ID_PATTERN.test(String(step.id || ""))) errors.push(`${label}.id is invalid.`);
  if (seen.has(step.id)) errors.push(`${label}.id must be unique.`);
  seen.add(step.id);
  if (!SKILL_STEP_KINDS.includes(step.kind)) errors.push(`${label}.kind is unsupported.`);
  if (!cleanText(step.purpose, 240)) errors.push(`${label}.purpose is required.`);
  if (step.origin && !(Array.isArray(step.origin) || typeof step.origin === "string")) errors.push(`${label}.origin must be a string or input reference.`);

  if (["click", "type", "select"].includes(step.kind)) {
    if (!isPlainObject(step.target)) errors.push(`${label}.target is required for ${step.kind}.`);
    else {
      if (!cleanText(step.target.role, 80) && !cleanText(step.target.label, 160) && !cleanText(step.target.testId, 160)) {
        errors.push(`${label}.target needs a semantic role, label, or stable test id.`);
      }
      if (step.target.coordinates) errors.push(`${label}.target cannot rely on raw screen coordinates.`);
    }
  }
  if (step.kind === "type" && step.value === undefined) errors.push(`${label}.value is required for type.`);
  if (step.kind === "verify" && !isPlainObject(step.expect)) errors.push(`${label}.expect is required for verify.`);
  validateInputReferences(step, inputs, label, errors);
}

function validateInputReferences(value, inputs, path, errors) {
  if (typeof value === "string") {
    const matches = value.matchAll(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g);
    for (const match of matches) if (!Object.prototype.hasOwnProperty.call(inputs, match[1])) errors.push(`${path} references unknown input ${match[1]}.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => validateInputReferences(item, inputs, `${path}[${index}]`, errors));
  if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) validateInputReferences(child, inputs, `${path}.${key}`, errors);
}

function validateInputValue(name, definition, value) {
  if (definition.type === "string") {
    if (typeof value !== "string") throw new Error(`Input ${name} must be a string.`);
    if (Number.isInteger(definition.maxLength) && value.length > definition.maxLength) throw new Error(`Input ${name} is too long.`);
  } else if (definition.type === "number" && typeof value !== "number") throw new Error(`Input ${name} must be a number.`);
  else if (definition.type === "boolean" && typeof value !== "boolean") throw new Error(`Input ${name} must be a boolean.`);
  return value;
}

function replaceInputRefs(value, inputs) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{input\.([a-zA-Z0-9_]+)\}\}$/);
    if (exact) return inputs[exact[1]];
    return value.replace(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g, (_, name) => String(inputs[name] ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => replaceInputRefs(item, inputs));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceInputRefs(child, inputs)]));
  return value;
}

function walkForForbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) return value.forEach((item, index) => walkForForbiddenKeys(item, `${path}[${index}]`, errors));
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`${path}.${key} is forbidden in declarative skills.`);
    walkForForbiddenKeys(child, `${path}.${key}`, errors);
  }
}

function validateStringArray(value, name, errors, { min, max }) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push(`${name} must contain ${min} to ${max} non-empty strings.`);
  }
}

function cleanText(value, max) { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function positiveInteger(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
