export const SKILL_STEP_STABILITY = Object.freeze(["stable", "fragile"]);

const TARGETED_KINDS = new Set(["click", "type", "select", "download"]);

export function inferRecordedStepReview(step = {}) {
  if (!TARGETED_KINDS.has(step.kind)) return { stability: "stable", unresolved: false };
  const target = step.target && typeof step.target === "object" && !Array.isArray(step.target) ? step.target : {};
  const hasTestId = Boolean(clean(target.testId));
  const hasRoleAndHumanLabel = Boolean(clean(target.role) && (clean(target.label) || clean(target.ariaLabel)));
  if (hasTestId || hasRoleAndHumanLabel) return { stability: "stable", unresolved: false };
  return {
    stability: "fragile",
    unresolved: true,
    reason: "This recorded target has a weak semantic fingerprint. Review or remove this step before approving the skill."
  };
}

export function validateStepReviewMetadata(review, path = "step.review") {
  const errors = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) return [`${path} must be an object.`];
  if (!SKILL_STEP_STABILITY.includes(review.stability)) errors.push(`${path}.stability must be stable or fragile.`);
  if (typeof review.unresolved !== "boolean") errors.push(`${path}.unresolved must be true or false.`);
  if (review.stability === "stable" && review.unresolved === true) errors.push(`${path} cannot mark a stable step unresolved.`);
  if (review.stability === "fragile") {
    const reason = clean(review.reason);
    if (!reason) errors.push(`${path}.reason is required for a fragile step.`);
    else if (reason.length > 240) errors.push(`${path}.reason must be 240 characters or fewer.`);
  } else if (review.reason !== undefined && typeof review.reason !== "string") {
    errors.push(`${path}.reason must be text when present.`);
  }
  return errors;
}

export function unresolvedSkillStepReviews(skill = {}) {
  if (!Array.isArray(skill.steps)) return [];
  return skill.steps.filter((step) => step?.review?.unresolved === true).map((step) => ({
    id: step.id,
    kind: step.kind,
    stability: step.review?.stability || "fragile",
    reason: clean(step.review?.reason) || "This step still needs review."
  }));
}

export function assertSkillStepReviewsResolved(skill = {}) {
  const unresolved = unresolvedSkillStepReviews(skill);
  if (!unresolved.length) return true;
  const error = new Error(`${unresolved.length} recorded step${unresolved.length === 1 ? " still needs" : "s still need"} target review before this skill can be approved or run.`);
  error.code = "SKILL_STEP_REVIEW_REQUIRED";
  error.steps = unresolved;
  throw error;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
