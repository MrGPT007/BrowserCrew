import { validateSkill } from "./skills-contract.js";

const INPUT_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;

export function reviewSkillDraft(skill, { title, description, inputEdits = {}, stepEdits = {}, scopeEdits = {} } = {}) {
  const original = structuredClone(skill || {});
  const initial = validateSkill(original);
  if (!initial.ok) throw new Error(`Cannot edit invalid skill draft: ${initial.errors.join(" ")}`);
  if (original.status !== "draft") throw new Error("Only a draft skill version can be edited.");

  const next = structuredClone(original);
  next.title = normalizeText(title ?? original.title, 120, "Skill title");
  next.description = normalizeText(description ?? original.description, 600, "Skill description");

  const renameMap = {};
  const renamedInputs = {};
  for (const [oldName, definition] of Object.entries(original.inputs || {})) {
    const edit = isPlainObject(inputEdits?.[oldName]) ? inputEdits[oldName] : {};
    const nextName = String(edit.name ?? oldName).trim();
    if (!INPUT_NAME_PATTERN.test(nextName)) {
      throw new Error(`Runtime input name “${nextName || "(empty)"}” must start with a lowercase letter and use only letters, numbers, or underscore.`);
    }
    if (Object.prototype.hasOwnProperty.call(renamedInputs, nextName)) {
      throw new Error(`Runtime input name “${nextName}” is already used in this draft.`);
    }
    const copy = structuredClone(definition);
    copy.label = normalizeText(edit.label ?? copy.label ?? "Runtime input", 120, `Label for ${nextName}`);
    if (Object.prototype.hasOwnProperty.call(copy, "name")) copy.name = nextName;
    renamedInputs[nextName] = copy;
    renameMap[oldName] = nextName;
  }

  const reviewedSteps = [];
  for (let index = 0; index < original.steps.length; index += 1) {
    const step = original.steps[index];
    const edit = isPlainObject(stepEdits?.[step.id]) ? stepEdits[step.id] : {};
    if (edit.remove === true) {
      if (index === original.steps.length - 1) throw new Error("The final result check cannot be removed.");
      continue;
    }
    const copy = rewriteInputRefs(structuredClone(step), renameMap);
    if (Object.prototype.hasOwnProperty.call(edit, "purpose")) {
      copy.purpose = normalizeText(edit.purpose, 240, `Description for ${step.id}`);
    }
    if (edit.confirmTarget === true) {
      if (copy.review?.unresolved !== true) throw new Error(`Step ${step.id} does not have an unresolved recorded target to confirm.`);
      copy.review = { ...copy.review, unresolved: false };
    }
    reviewedSteps.push(copy);
  }

  if (!reviewedSteps.length) throw new Error("A skill draft must keep at least one step.");
  const finalStep = reviewedSteps.at(-1);
  if (finalStep.kind !== "verify" || !isPlainObject(finalStep.expect)) {
    throw new Error("The draft must keep its final visible result check.");
  }

  const hasOriginEdit = Object.prototype.hasOwnProperty.call(scopeEdits || {}, "allowedOrigins");
  const hasActionEdit = Object.prototype.hasOwnProperty.call(scopeEdits || {}, "actionClasses");
  if (hasOriginEdit || hasActionEdit) {
    next.allowedOrigins = hasOriginEdit
      ? narrowStringScope(original.allowedOrigins, scopeEdits.allowedOrigins, "website")
      : structuredClone(original.allowedOrigins);
    next.actionClasses = hasActionEdit
      ? narrowStringScope(original.actionClasses, scopeEdits.actionClasses, "action")
      : structuredClone(original.actionClasses);
    assertKeptStepsFitScope(reviewedSteps, next.allowedOrigins, next.actionClasses);
  }

  const usedInputs = collectInputRefs(reviewedSteps);
  next.inputs = Object.fromEntries(Object.entries(renamedInputs).filter(([name]) => usedInputs.has(name)));
  next.steps = reviewedSteps;

  const result = validateSkill(next);
  if (!result.ok) throw new Error(`Edited skill draft is invalid: ${result.errors.join(" ")}`);
  return next;
}

function narrowStringScope(originalValues, requestedValues, label) {
  if (!Array.isArray(requestedValues)) throw new Error(`Choose the ${label} scope from the values already recorded in this draft.`);
  const original = new Set(originalValues || []);
  const requested = [...new Set(requestedValues.map((value) => String(value || "").trim()).filter(Boolean))];
  for (const value of requested) {
    if (!original.has(value)) throw new Error(`Draft review cannot add a new ${label}: ${value}.`);
  }
  if (!requested.length) throw new Error(`Keep at least one ${label} in this draft.`);
  return requested;
}

function assertKeptStepsFitScope(steps, allowedOrigins, actionClasses) {
  const origins = new Set(allowedOrigins || []);
  for (const step of steps) {
    if (typeof step.origin === "string" && /^https?:\/\//.test(step.origin) && !origins.has(step.origin)) {
      throw new Error(`A kept step still uses ${step.origin}. Keep that website or remove every step that uses it first.`);
    }
  }

  const actions = new Set(actionClasses || []);
  const required = new Set(["read"]);
  if (steps.some((step) => ["click", "type", "select"].includes(step.kind))) required.add("page_write_prepare");
  if (steps.some((step) => step.kind === "download")) required.add("download");
  for (const action of required) {
    if (!actions.has(action)) throw new Error(`Kept steps still need the “${action}” action. Keep that action or remove those steps first.`);
  }
}

function rewriteInputRefs(value, renameMap) {
  if (typeof value === "string") {
    return value.replace(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g, (match, name) => {
      const replacement = renameMap[name];
      return replacement ? `{{input.${replacement}}}` : match;
    });
  }
  if (Array.isArray(value)) return value.map((item) => rewriteInputRefs(item, renameMap));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteInputRefs(child, renameMap)]));
  }
  return value;
}

function collectInputRefs(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g)) found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectInputRefs(child, found);
    return found;
  }
  if (isPlainObject(value)) for (const child of Object.values(value)) collectInputRefs(child, found);
  return found;
}

function normalizeText(value, max, label) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} cannot be empty.`);
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
