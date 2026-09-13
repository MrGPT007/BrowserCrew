import { validateSkill } from "./skills-contract.js";

export const MAX_DRAFT_COMPLETION_CHECKS = 5;
export const MAX_DRAFT_COMPLETION_TEXT = 160;
const ADDED_MARKER = "draft_review_visible_text";

export function listDraftCompletionChecks(skill = {}) {
  if (!Array.isArray(skill.steps)) return [];
  return skill.steps
    .filter((step) => step?.draftReviewCompletion === ADDED_MARKER && step.kind === "verify")
    .map((step) => ({ id: step.id, visibleText: String(step.expect?.visibleText || "") }));
}

export function updateDraftCompletionChecks(skill, values = []) {
  const original = structuredClone(skill || {});
  const initial = validateSkill(original);
  if (!initial.ok) throw new Error(`Cannot edit invalid skill draft: ${initial.errors.join(" ")}`);
  if (original.status !== "draft") throw new Error("Only a draft skill version can change completion checks.");
  if (!Array.isArray(values)) throw new Error("Completion checks must be a list of visible page text.");
  if (values.length > MAX_DRAFT_COMPLETION_CHECKS) throw new Error(`Keep at most ${MAX_DRAFT_COMPLETION_CHECKS} added completion checks.`);

  const texts = [];
  const seen = new Set();
  for (const value of values) {
    const text = normalizeVisibleText(value);
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`Completion check “${text}” is duplicated.`);
    seen.add(key);
    texts.push(text);
  }

  const unmarked = original.steps.filter((step) => step?.draftReviewCompletion !== ADDED_MARKER);
  const finalStep = unmarked.at(-1);
  if (!finalStep || finalStep.kind !== "verify" || !isPlainObject(finalStep.expect)) {
    throw new Error("The draft must keep its original final result check.");
  }
  const originalFinalText = normalizeVisibleText(finalStep.expect.visibleText || "").toLocaleLowerCase();
  if (originalFinalText && seen.has(originalFinalText)) throw new Error("That visible-text check is already the draft's required final result check.");

  const beforeFinal = unmarked.slice(0, -1);
  const origin = typeof finalStep.origin === "string" && finalStep.origin ? finalStep.origin : original.allowedOrigins?.[0];
  const usedIds = new Set(unmarked.map((step) => step.id));
  const additions = texts.map((text, index) => ({
    id: nextId(usedIds, index + 1),
    kind: "verify",
    purpose: `Verify the added success check: ${text}`,
    ...(origin ? { origin } : {}),
    expect: { visibleText: text },
    draftReviewCompletion: ADDED_MARKER
  }));

  const baseCriteria = (original.completionCriteria || []).filter((item) => item?.draftReviewCompletion !== ADDED_MARKER);
  const addedCriteria = texts.map((text) => ({
    claim: `The reviewed page shows “${text}”.`,
    verification: `Require visible text “${text}” before reporting success.`,
    draftReviewCompletion: ADDED_MARKER
  }));

  const next = {
    ...original,
    steps: [...beforeFinal, ...additions, finalStep],
    completionCriteria: [...baseCriteria, ...addedCriteria]
  };
  const result = validateSkill(next);
  if (!result.ok) throw new Error(`Edited completion checks are invalid: ${result.errors.join(" ")}`);
  return next;
}

function nextId(usedIds, index) {
  const base = `completion-check-${String(index).padStart(2, "0")}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base}-${suffix++}`;
  usedIds.add(id);
  return id;
}

function normalizeVisibleText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length > MAX_DRAFT_COMPLETION_TEXT) throw new Error(`Each completion check must be ${MAX_DRAFT_COMPLETION_TEXT} characters or fewer.`);
  return text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
