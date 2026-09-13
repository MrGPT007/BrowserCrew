import { migrateSkillContractMetadata } from "./skills-contract-metadata.js";

export function compareSkillVersions(baseInput, candidateInput) {
  const base = migrateSkillContractMetadata(baseInput);
  const candidate = migrateSkillContractMetadata(candidateInput);
  assertComparable(base, candidate);

  const changes = [];
  compareScalar(changes, "Copy", "Name", base.title, candidate.title);
  compareScalar(changes, "Copy", "Description", base.description, candidate.description);
  compareInputs(changes, base.inputs || {}, candidate.inputs || {});
  compareSet(changes, "Access", "Websites", base.allowedOrigins, candidate.allowedOrigins, "scope_widening");
  compareSet(changes, "Access", "Resources", base.allowedResources, candidate.allowedResources, "scope_widening");
  compareSet(changes, "Access", "Actions", base.actionClasses, candidate.actionClasses, "scope_widening");
  compareSet(changes, "Access", "Data destinations", base.dataDestinations, candidate.dataDestinations, "scope_widening");
  compareSet(changes, "Access", "Provider capabilities", base.providerRequirements?.capabilities, candidate.providerRequirements?.capabilities, "scope_widening");
  compareBudget(changes, "Max steps", base.budgets?.maxSteps, candidate.budgets?.maxSteps);
  compareBudget(changes, "Max minutes", base.budgets?.maxMinutes, candidate.budgets?.maxMinutes);
  compareSafetyFlag(changes, "Write safety", "Approval required", base.writePolicy?.approvalRequired, candidate.writePolicy?.approvalRequired, true);
  compareSafetyFlag(changes, "Write safety", "No blind retry", base.writePolicy?.noBlindRetry, candidate.writePolicy?.noBlindRetry, true);
  compareSafetyFlag(changes, "Verification", "Re-observe targets before dispatch", base.verificationRules?.reobserveTargetsBeforeDispatch, candidate.verificationRules?.reobserveTargetsBeforeDispatch, true);
  compareSafetyFlag(changes, "Verification", "Require final verification", base.verificationRules?.requireFinalVerification, candidate.verificationRules?.requireFinalVerification, true);
  compareSafetyFlag(changes, "Recovery", "Retry writes", base.recovery?.retryWrites, candidate.recovery?.retryWrites, false);
  compareSafetyFlag(changes, "Recovery", "Reconcile unknown writes", base.recovery?.reconcileUnknownWrites, candidate.recovery?.reconcileUnknownWrites, true);
  compareSteps(changes, base.steps || [], candidate.steps || []);
  compareScalar(changes, "Compatibility", "Minimum BrowserCrew version", base.compatibility?.minBrowserCrewVersion, candidate.compatibility?.minBrowserCrewVersion);

  return {
    schemaVersion: 1,
    kind: "browsercrew.skill_version_diff",
    skillId: base.id,
    from: { version: base.version, status: base.status },
    to: { version: candidate.version, status: candidate.status },
    hasChanges: changes.length > 0,
    warningCount: changes.filter((change) => change.review !== "none").length,
    wideningCount: changes.filter((change) => change.review === "scope_widening" || change.review === "safety_weakening" || change.review === "behavior_expansion").length,
    changes
  };
}

function compareInputs(changes, before, after) {
  const names = sortedUnion(Object.keys(before), Object.keys(after));
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(before, name)) {
      changes.push(change("Inputs", name, "added", null, safeInput(after[name]), "input_change"));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(after, name)) {
      changes.push(change("Inputs", name, "removed", safeInput(before[name]), null, "input_change"));
      continue;
    }
    const left = safeInput(before[name]);
    const right = safeInput(after[name]);
    if (canonical(left) === canonical(right)) continue;
    const privacyWeakening = left.secret === true && right.secret !== true;
    changes.push(change("Inputs", name, "changed", left, right, privacyWeakening ? "safety_weakening" : "input_change"));
  }
}

function compareSet(changes, section, label, before = [], after = [], addedReview = "scope_widening") {
  const left = new Set((before || []).map(String));
  const right = new Set((after || []).map(String));
  const added = [...right].filter((value) => !left.has(value)).sort();
  const removed = [...left].filter((value) => !right.has(value)).sort();
  if (!added.length && !removed.length) return;
  changes.push({ section, label, kind: "set_changed", before: [...left].sort(), after: [...right].sort(), added, removed, review: added.length ? addedReview : "none" });
}

function compareBudget(changes, label, before, after) {
  if (Number(before) === Number(after)) return;
  const raised = Number(after) > Number(before);
  changes.push(change("Limits", label, "changed", Number(before), Number(after), raised ? "scope_widening" : "none"));
}

function compareSafetyFlag(changes, section, label, before, after, saferValue) {
  if (Boolean(before) === Boolean(after)) return;
  const weakened = Boolean(before) === Boolean(saferValue) && Boolean(after) !== Boolean(saferValue);
  changes.push(change(section, label, "changed", Boolean(before), Boolean(after), weakened ? "safety_weakening" : "none"));
}

function compareSteps(changes, beforeSteps, afterSteps) {
  const before = new Map(beforeSteps.map((step) => [step.id, step]));
  const after = new Map(afterSteps.map((step) => [step.id, step]));
  for (const id of sortedUnion([...before.keys()], [...after.keys()])) {
    if (!before.has(id)) {
      const step = safeStep(after.get(id));
      const expansion = !["verify", "waitFor"].includes(step.kind);
      changes.push(change("Steps", id, "added", null, step, expansion ? "behavior_expansion" : "behavior_change"));
      continue;
    }
    if (!after.has(id)) {
      changes.push(change("Steps", id, "removed", safeStep(before.get(id)), null, "behavior_change"));
      continue;
    }
    const left = safeStep(before.get(id));
    const right = safeStep(after.get(id));
    if (canonical(left) === canonical(right)) continue;
    const leftBehavior = { ...left }; delete leftBehavior.purpose;
    const rightBehavior = { ...right }; delete rightBehavior.purpose;
    const purposeOnly = canonical(leftBehavior) === canonical(rightBehavior);
    changes.push(change("Steps", id, "changed", left, right, purposeOnly ? "none" : "behavior_change"));
  }
}

function compareScalar(changes, section, label, before, after) {
  if (canonical(before) === canonical(after)) return;
  changes.push(change(section, label, "changed", before ?? null, after ?? null, "none"));
}

function safeInput(input = {}) {
  return {
    type: input.type || null,
    required: input.required === true,
    secret: input.secret === true,
    label: input.label || null,
    hasDefault: Object.prototype.hasOwnProperty.call(input, "default")
  };
}

function safeStep(step = {}) {
  const result = {
    id: step.id || null,
    kind: step.kind || null,
    purpose: step.purpose || null,
    origin: step.origin || null
  };
  if (step.target) result.target = scrub(step.target);
  if (step.expect) result.expect = scrub(step.expect);
  if (step.url) result.url = step.url;
  if (step.timeoutMs != null) result.timeoutMs = step.timeoutMs;
  if (typeof step.value === "string") result.valueBinding = step.value.replace(/[^{}]*?(\{\{input\.[^}]+\}\})?[^{}]*/g, "$1") || "literal-present";
  if (step.review) result.review = scrub(step.review);
  return result;
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, scrub(value[key])]));
}

function change(section, label, kind, before, after, review) {
  return { section, label, kind, before, after, review };
}

function sortedUnion(a, b) { return [...new Set([...a, ...b])].sort(); }
function canonical(value) { return JSON.stringify(scrub(value)); }
function assertComparable(base, candidate) {
  if (!base || !candidate || typeof base !== "object" || typeof candidate !== "object") throw new Error("Choose two saved Skill versions to compare.");
  if (!base.id || !candidate.id || base.id !== candidate.id) throw new Error("Compare versions of the same saved Skill. Duplicated Skills have a new identity and are reviewed separately.");
  if (!base.version || !candidate.version) throw new Error("Both saved Skill versions need an exact version number.");
}
