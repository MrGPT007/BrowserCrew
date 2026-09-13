import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { reviewSkillDraft } from "../src/skills-draft-review.js";
import { promoteSkillDraft, validateSkill } from "../src/skills-contract.js";
import { draftSkillFromWatchSession } from "../src/watch-me-contract.js";
import { inferRecordedStepReview, unresolvedSkillStepReviews } from "../src/skills-step-review.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/skills-step-review.js",
  "src/skills-contract.js",
  "src/watch-me-contract.js",
  "src/skills-draft-review.js",
  "src/skills-draft-review-ui.js",
  "scripts/skills-draft-review-check.mjs",
  "scripts/skill-draft-review-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const origin = "https://example.test";
const draft = {
  schemaVersion: 1,
  id: "review-recorded-form",
  version: "0.1.0",
  status: "draft",
  title: "My recorded browser job",
  description: "Recorded draft waiting for review.",
  inputs: {
    emailAddress: { name: "emailAddress", type: "string", required: true, secret: false, label: "Email address" },
    department: { name: "department", type: "string", required: true, secret: false, label: "Department" }
  },
  allowedOrigins: [origin],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  budgets: { maxSteps: 18, maxMinutes: 30 },
  steps: [
    { id: "step-open", kind: "navigate", purpose: "Open the demonstrated page.", origin, url: `${origin}/form` },
    { id: "step-email", kind: "type", purpose: "Enter the reviewed email.", origin, target: { role: "textbox", label: "Email address" }, value: "{{input.emailAddress}}" },
    { id: "step-department", kind: "select", purpose: "Choose the reviewed department.", origin, target: { role: "combobox", label: "Department" }, value: "{{input.department}}" },
    { id: "step-preview", kind: "click", purpose: "Choose Preview.", origin, target: { role: "button", label: "Preview" } },
    { id: "step-verify", kind: "verify", purpose: "Verify the reviewed result.", origin, expect: { visibleText: "Ready to review" } }
  ],
  completionCriteria: [{ claim: "The form reached review state.", verification: "Visible text says Ready to review." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", createdAt: "2026-09-12T12:00:00.000Z" }
};
assert.equal(validateSkill(draft).ok, true);

const reviewed = reviewSkillDraft(draft, {
  title: "Prepare reviewed form",
  description: "Prepare the form with reviewed run-time inputs and verify the final review state.",
  inputEdits: {
    emailAddress: { name: "recipientEmail", label: "Recipient email" },
    department: { name: "department", label: "Department to use" }
  },
  stepEdits: {
    "step-email": { purpose: "Enter the recipient email only at run time." },
    "step-preview": { remove: true }
  }
});
assert.equal(reviewed.id, draft.id);
assert.equal(reviewed.version, draft.version);
assert.equal(reviewed.status, "draft");
assert.equal(reviewed.title, "Prepare reviewed form");
assert.equal(reviewed.inputs.emailAddress, undefined);
assert.equal(reviewed.inputs.recipientEmail.label, "Recipient email");
assert.equal(reviewed.inputs.recipientEmail.name, "recipientEmail");
assert.equal(reviewed.steps.find((step) => step.id === "step-email")?.value, "{{input.recipientEmail}}");
assert.equal(reviewed.steps.find((step) => step.id === "step-email")?.purpose, "Enter the recipient email only at run time.");
assert.equal(reviewed.steps.some((step) => step.id === "step-preview"), false);
assert.equal(reviewed.steps.at(-1).id, "step-verify");
assert.deepEqual(reviewed.allowedOrigins, draft.allowedOrigins, "Draft review without scope edits must preserve site scope exactly.");
assert.deepEqual(reviewed.actionClasses, draft.actionClasses, "Draft review without scope edits must preserve action scope exactly.");
assert.deepEqual(reviewed.budgets, draft.budgets, "Draft review must not widen or rewrite budgets.");
assert.equal(validateSkill(reviewed).ok, true);
assert.equal(draft.inputs.recipientEmail, undefined, "Draft review must not mutate the stored source object in place.");
assert.equal(draft.steps.some((step) => step.id === "step-preview"), true);

const pruned = reviewSkillDraft(draft, {
  inputEdits: {
    emailAddress: { name: "recipientEmail", label: "Recipient email" },
    department: { name: "department", label: "Department" }
  },
  stepEdits: { "step-department": { remove: true } }
});
assert.equal(pruned.inputs.department, undefined, "Removing the only step that uses an input must prune that unused input definition.");
assert.ok(pruned.inputs.recipientEmail);

const unusedOrigin = "https://unused.example.test";
const widerRecordedDraft = structuredClone(draft);
widerRecordedDraft.allowedOrigins = [origin, unusedOrigin];
widerRecordedDraft.actionClasses = ["read", "page_write_prepare", "download"];
assert.equal(validateSkill(widerRecordedDraft).ok, true);
const narrowed = reviewSkillDraft(widerRecordedDraft, {
  scopeEdits: { allowedOrigins: [origin], actionClasses: ["read", "page_write_prepare"] }
});
assert.deepEqual(narrowed.allowedOrigins, [origin], "Review may remove an unused recorded website.");
assert.deepEqual(narrowed.actionClasses, ["read", "page_write_prepare"], "Review may remove an unused recorded action.");
assert.deepEqual(widerRecordedDraft.allowedOrigins, [origin, unusedOrigin], "Scope narrowing must not mutate source history.");
assert.deepEqual(widerRecordedDraft.actionClasses, ["read", "page_write_prepare", "download"]);

const readOnly = reviewSkillDraft(widerRecordedDraft, {
  stepEdits: {
    "step-email": { remove: true },
    "step-department": { remove: true },
    "step-preview": { remove: true }
  },
  scopeEdits: { allowedOrigins: [origin], actionClasses: ["read"] }
});
assert.deepEqual(readOnly.actionClasses, ["read"], "After page-change steps are removed, their action scope may also be removed.");
assert.deepEqual(readOnly.inputs, {}, "Removing all input-consuming steps must prune their runtime inputs.");
assert.equal(readOnly.steps.at(-1).kind, "verify");

assert.deepEqual(inferRecordedStepReview({ kind: "click", target: { role: "button", label: "Preview" } }), { stability: "stable", unresolved: false });
const weakReview = inferRecordedStepReview({ kind: "click", target: { role: "button" } });
assert.equal(weakReview.stability, "fragile");
assert.equal(weakReview.unresolved, true);
assert.match(weakReview.reason, /weak semantic fingerprint/i);

const stoppedWatchSession = {
  schemaVersion: 1,
  id: "watch-fragile-static",
  status: "stopped",
  approvedTabs: [11],
  approvedOrigins: [origin],
  startedAt: "2026-09-12T12:00:00.000Z",
  stoppedAt: "2026-09-12T12:01:00.000Z",
  events: [
    { id: "weak-click", kind: "click", tabId: 11, origin, target: { role: "button" } },
    { id: "final-check", kind: "verify", tabId: 11, origin, expect: { visibleText: "Ready" } }
  ],
  variables: {},
  warnings: []
};
const watchDraft = draftSkillFromWatchSession(stoppedWatchSession, {
  skillId: "watch-fragile-static",
  title: "Fragile recorded target",
  description: "Review the weak recorded target before approval."
});
assert.equal(watchDraft.steps[0].review.stability, "fragile");
assert.equal(watchDraft.steps[0].review.unresolved, true);
assert.deepEqual(watchDraft.steps[1].review, { stability: "stable", unresolved: false });
assert.equal(unresolvedSkillStepReviews(watchDraft).length, 1);
assert.equal(validateSkill(watchDraft).ok, true, "Unresolved metadata must remain valid draft data.");
assert.throws(() => promoteSkillDraft(watchDraft, { approvedAt: "2026-09-12T12:02:00.000Z" }), (error) => error?.code === "SKILL_STEP_REVIEW_REQUIRED");

const resolvedWatchDraft = reviewSkillDraft(watchDraft, {
  stepEdits: { "weak-click": { confirmTarget: true } }
});
assert.equal(resolvedWatchDraft.steps[0].review.stability, "fragile", "Review must preserve the fragility signal instead of pretending the target became stronger.");
assert.equal(resolvedWatchDraft.steps[0].review.unresolved, false);
assert.deepEqual(resolvedWatchDraft.steps[0].target, watchDraft.steps[0].target, "Target review must never rewrite the semantic target.");
const approvedResolved = promoteSkillDraft(resolvedWatchDraft, { approvedAt: "2026-09-12T12:03:00.000Z" });
assert.equal(approvedResolved.status, "approved");
assert.equal(approvedResolved.steps[0].review.unresolved, false);
assert.throws(() => reviewSkillDraft(draft, { stepEdits: { "step-preview": { confirmTarget: true } } }), /does not have an unresolved recorded target/);

assert.throws(() => reviewSkillDraft(widerRecordedDraft, {
  scopeEdits: { allowedOrigins: [origin, "https://new.example.test"], actionClasses: widerRecordedDraft.actionClasses }
}), /cannot add a new website/);
assert.throws(() => reviewSkillDraft(widerRecordedDraft, {
  scopeEdits: { allowedOrigins: widerRecordedDraft.allowedOrigins, actionClasses: ["read", "page_write_prepare", "download", "page_write_commit"] }
}), /cannot add a new action/);
assert.throws(() => reviewSkillDraft(widerRecordedDraft, {
  scopeEdits: { allowedOrigins: [unusedOrigin], actionClasses: widerRecordedDraft.actionClasses }
}), /kept step still uses/i);
assert.throws(() => reviewSkillDraft(widerRecordedDraft, {
  scopeEdits: { allowedOrigins: widerRecordedDraft.allowedOrigins, actionClasses: ["read", "download"] }
}), /page_write_prepare/);

assert.throws(() => reviewSkillDraft({ ...draft, status: "approved" }), /Only a draft skill version can be edited/);
assert.throws(() => reviewSkillDraft(draft, { stepEdits: { "step-verify": { remove: true } } }), /final result check cannot be removed/);
assert.throws(() => reviewSkillDraft(draft, {
  inputEdits: {
    emailAddress: { name: "sharedInput", label: "Email" },
    department: { name: "sharedInput", label: "Department" }
  }
}), /already used/);
assert.throws(() => reviewSkillDraft(draft, { inputEdits: { emailAddress: { name: "1invalid", label: "Email" } } }), /must start with a lowercase letter/);

const uiSource = await readFile("src/skills-draft-review-ui.js", "utf8");
for (const phrase of [
  "Review & edit draft",
  "Recorded runtime values are never displayed here.",
  "This screen cannot add websites, actions, permissions, budgets, or runtime values.",
  "You can only make this draft narrower",
  "Keep only the access this draft still needs",
  "A fragile target stays blocked from approval",
  "I reviewed this fragile recorded target and want to keep this step",
  "confirmFragileStep",
  "scopeOrigin",
  "scopeAction",
  "The final result check cannot be removed.",
  'type: "saveDraft"',
  "Draft review saved. It is still a draft and has not gained any new permission.",
  'const card = document.querySelector("#versionedSkillsCard")',
  'card.addEventListener("click", onReviewAction)',
  "host.append(activeEditor)",
  "findSkillCard(saved.skill)"
]) if (!uiSource.includes(phrase)) throw new Error(`Skill draft review UI safety contract missing: ${phrase}`);
if (uiSource.includes('list.addEventListener("click", onReviewAction)')) throw new Error("Draft review actions must be delegated from the stable Skills card, not the replaceable version list.");

const helperSource = await readFile("src/skills-draft-review.js", "utf8");
for (const phrase of [
  'original.status !== "draft"',
  "rewriteInputRefs",
  "collectInputRefs",
  "narrowStringScope",
  "assertKeptStepsFitScope",
  "scopeEdits",
  "confirmTarget",
  "does not have an unresolved recorded target",
  "Draft review cannot add a new",
  "validateSkill(next)",
  "The final result check cannot be removed."
]) if (!helperSource.includes(phrase)) throw new Error(`Skill draft review helper contract missing: ${phrase}`);

const contractSource = await readFile("src/skills-contract.js", "utf8");
for (const phrase of [
  'import { validateStepReviewMetadata } from "./skills-step-review.js"',
  "SKILL_STEP_REVIEW_REQUIRED",
  "Approved skill versions cannot contain unresolved recorded steps"
]) if (!contractSource.includes(phrase)) throw new Error(`Skill unresolved-step execution boundary missing: ${phrase}`);

const watchSource = await readFile("src/watch-me-contract.js", "utf8");
for (const phrase of [
  'import { inferRecordedStepReview } from "./skills-step-review.js"',
  "step.review = inferRecordedStepReview(step)"
]) if (!watchSource.includes(phrase)) throw new Error(`Watch Me unresolved-step capture contract missing: ${phrase}`);

const sidepanelSource = await readFile("src/sidepanel.js", "utf8");
if (!sidepanelSource.includes('import "./skills-draft-review-ui.js"')) throw new Error("Side panel must load the skill draft review UI.");

const previousStableRunner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!previousStableRunner.includes('"skill-draft-review-smoke.mjs"')) throw new Error("Chrome 152 matrix must include skill draft review smoke coverage.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run skill-draft-review-smoke",
  "name: skill-draft-review-evidence",
  "path: artifacts/skill-draft-review-smoke"
]) if (!workflow.includes(phrase)) throw new Error(`Current-stable skill draft review CI gate missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["skills-draft-review-check"] !== "node scripts/skills-draft-review-check.mjs") throw new Error("skills-draft-review-check script must stay wired.");
if (pkg.scripts?.["skill-draft-review-smoke"] !== "node scripts/skill-draft-review-smoke.mjs") throw new Error("skill-draft-review-smoke must stay wired.");
if (!String(pkg.scripts?.check || "").includes("skills-draft-review-check.mjs")) throw new Error("npm run check must include skill draft review contracts.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if ((manifest.permissions || []).includes("alarms")) throw new Error("Fragile-step review must not widen the v0.2 manifest with alarms.");
const serviceWorker = await readFile("src/service-worker.js", "utf8");
if (serviceWorker.includes("bootSchedulesRuntime")) throw new Error("Fragile-step review must not activate production scheduling.");

console.log("BrowserCrew skill draft review contracts passed.");
