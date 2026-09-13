import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createNextVersionDraft } from "../src/skills-versioning.js";
import { listDraftCompletionChecks, MAX_DRAFT_COMPLETION_CHECKS, updateDraftCompletionChecks } from "../src/skills-completion-checks.js";

const execFileAsync = promisify(execFile);
const files = [
  "src/skills-versioning.js",
  "src/skills-test.js",
  "src/skills-run-ui.js",
  "src/skills-draft-test-ui.js",
  "src/skills-completion-checks.js",
  "src/skills-completion-checks-ui.js",
  "scripts/skill-run-ui-smoke.mjs",
  "scripts/skill-completion-check-smoke.mjs"
];
for (const file of files) {
  await access(file);
  await execFileAsync(process.execPath, ["--check", file]);
}

const sample = {
  schemaVersion: 1,
  id: "supplier-check",
  version: "1.0.0",
  status: "approved",
  title: "Supplier check",
  description: "Check a supplier page safely.",
  inputs: { query: { type: "string", required: true, secret: false, label: "Search" } },
  allowedOrigins: ["https://example.test"],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  budgets: { maxSteps: 8, maxMinutes: 5 },
  steps: [
    { id: "step-type", kind: "type", purpose: "Enter query.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.query}}" },
    { id: "step-verify", kind: "verify", purpose: "Verify result.", origin: "https://example.test", expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "Ready is visible.", verification: "Check visible Ready text." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-12T00:00:00.000Z" },
  approval: { approvedAt: "2026-09-12T00:01:00.000Z", approvedBy: "user" }
};
const next = createNextVersionDraft(sample, [sample, { ...sample, version: "1.0.1", status: "archived", archivedAt: "2026-09-12T00:02:00.000Z" }], { createdAt: "2026-09-13T00:00:00.000Z" });
assert.equal(next.id, sample.id);
assert.equal(next.version, "1.0.2");
assert.equal(next.status, "draft");
assert.equal(next.approval, undefined);
assert.equal(next.archivedAt, undefined);
assert.deepEqual(next.allowedOrigins, sample.allowedOrigins);
assert.deepEqual(next.actionClasses, sample.actionClasses);
assert.deepEqual(next.provenance.sourceSkillRef, { id: sample.id, version: sample.version });

const withCompletion = updateDraftCompletionChecks(next, ["Supplier lookup"]);
assert.equal(withCompletion.status, "draft");
assert.equal(withCompletion.approval, undefined);
assert.equal(withCompletion.steps.at(-1).id, next.steps.at(-1).id, "Original final verification must remain last.");
assert.deepEqual(withCompletion.steps.at(-1).expect, next.steps.at(-1).expect);
assert.equal(withCompletion.steps.at(-2).kind, "verify");
assert.equal(withCompletion.steps.at(-2).expect.visibleText, "Supplier lookup");
assert.equal(withCompletion.steps.at(-2).draftReviewCompletion, "draft_review_visible_text");
assert.deepEqual(listDraftCompletionChecks(withCompletion).map((item) => item.visibleText), ["Supplier lookup"]);
assert.equal(withCompletion.completionCriteria.some((item) => item.draftReviewCompletion === "draft_review_visible_text"), true);
assert.equal(next.steps.length, sample.steps.length, "Completion editing must not mutate source history.");
const replacedCompletion = updateDraftCompletionChecks(withCompletion, ["Supplier lookup", "Review complete"]);
assert.deepEqual(listDraftCompletionChecks(replacedCompletion).map((item) => item.visibleText), ["Supplier lookup", "Review complete"]);
assert.equal(replacedCompletion.steps.at(-1).id, next.steps.at(-1).id);
assert.throws(() => updateDraftCompletionChecks(next, ["Ready"]), /already the draft's required final result check/);
assert.throws(() => updateDraftCompletionChecks(next, ["Same", "same"]), /duplicated/);
assert.throws(() => updateDraftCompletionChecks(next, Array.from({ length: MAX_DRAFT_COMPLETION_CHECKS + 1 }, (_, i) => `Check ${i}`)), /at most/);
assert.throws(() => updateDraftCompletionChecks({ ...next, status: "approved" }, ["Extra"]), /Only a draft/);

const testSource = await readFile("src/skills-test.js", "utf8");
for (const phrase of ["testApprovedSkillOnPage", "testDraftSkillOnPage", "materializeSkillSteps", "validateSkill(skill)", 'mode: "draft_preflight"', "SKILL_STEP_REVIEW_REQUIRED", "TARGET_AMBIGUOUS", "Test does not navigate", "Recorded download replay is not enabled", "CLICK_REQUIRES_COMMIT_APPROVAL"]) {
  assert.ok(testSource.includes(phrase), `Safe Test contract missing: ${phrase}`);
}
assert.equal(testSource.includes("el.click()"), false);
assert.equal(testSource.includes("el.value ="), false);
assert.equal(testSource.includes("chrome.tabs.update"), false);

const runUi = await readFile("src/skills-run-ui.js", "utf8");
for (const phrase of ["A Skill is a saved way to do a browser job", "Versions", "Create next draft version", "Test this page (no changes)", "Review and run once", "Saved Skill requirements do not grant permission by themselves", 'scope: "one_run"', 'type: "run"', "chrome.permissions.request"]) {
  assert.ok(runUi.includes(phrase), `Skill Test/Run UI contract missing: ${phrase}`);
}
assert.equal(runUi.includes("chrome.storage"), false);

const draftUi = await readFile("src/skills-draft-test-ui.js", "utf8");
for (const phrase of ["Test draft — no changes", "DRAFT TEST · OBSERVATION ONLY", "without clicking, typing, navigating, downloading, saving, approving, or running this draft", "Draft Test never asks Chrome for new site access", "chrome.permissions.contains", "testDraftSkillOnPage", "Review this draft first", "No draft step ran and no approval was created"]) {
  assert.ok(draftUi.includes(phrase), `Draft Test UI safety contract missing: ${phrase}`);
}
for (const forbidden of ["chrome.permissions.request", "chrome.storage", 'type: "run"', "runPortRequest", "Review and run once"]) assert.equal(draftUi.includes(forbidden), false, `Draft Test UI must not contain authority path: ${forbidden}`);

const completionUi = await readFile("src/skills-completion-checks-ui.js", "utf8");
for (const phrase of ["Success checks", "Original final check · locked", "Add another check", "Save success checks", "Do not put names, emails, account numbers, passwords, tokens, or other private values here.", "cannot replace the original final result check", 'type: "saveDraft"', "still a draft and has not gained any permission"]) {
  assert.ok(completionUi.includes(phrase), `Completion-check review UI contract missing: ${phrase}`);
}
for (const forbidden of ["chrome.permissions.request", 'type: "run"', 'type: "approve"']) assert.equal(completionUi.includes(forbidden), false, `Completion-check editor must not contain authority path: ${forbidden}`);

const completionHelper = await readFile("src/skills-completion-checks.js", "utf8");
for (const phrase of ["MAX_DRAFT_COMPLETION_CHECKS = 5", "MAX_DRAFT_COMPLETION_TEXT = 160", 'draftReviewCompletion: ADDED_MARKER', "steps: [...beforeFinal, ...additions, finalStep]", "completionCriteria: [...baseCriteria, ...addedCriteria]", "validateSkill(next)"]) {
  assert.ok(completionHelper.includes(phrase), `Completion-check helper contract missing: ${phrase}`);
}

const completionSmoke = await readFile("scripts/skill-completion-check-smoke.mjs", "utf8");
for (const phrase of ["Run must fail while the user-added visible completion check is absent.", "SKILL_VERIFY_FAILED", "Original final verification must remain last and unchanged", "Saving success checks never self-approves", "completes only after the added success check and original final verification both pass", 'data-submits="0"']) {
  assert.ok(completionSmoke.includes(phrase), `Completion-check installed-extension proof missing: ${phrase}`);
}

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./skills-run-ui.js";'));
assert.ok(sidepanel.includes('import "./skills-draft-test-ui.js";'));
assert.ok(sidepanel.includes('import "./skills-completion-checks-ui.js";'));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false);
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false);

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of ["npm run skill-run-ui-smoke", "skill-run-ui-evidence"]) assert.ok(workflow.includes(phrase));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["skills-run-ui-check"], "node scripts/skills-run-ui-check.mjs");
assert.ok(String(pkg.scripts?.["skill-run-ui-smoke"] || "").includes("node scripts/skill-run-ui-smoke.mjs"));
assert.ok(String(pkg.scripts?.["skill-run-ui-smoke"] || "").includes("node scripts/skill-completion-check-smoke.mjs"));
assert.equal(pkg.scripts?.["skill-completion-check-smoke"], "node scripts/skill-completion-check-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("skills-run-ui-check.mjs"));
const previousStableRunner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousStableRunner.includes('"skill-run-ui-smoke.mjs"'));
assert.ok(previousStableRunner.includes('"skill-completion-check-smoke.mjs"'), "Chrome 152 matrix must include bounded completion-check smoke coverage.");

console.log("BrowserCrew Skill Versions/Test/Run and bounded draft success-check contracts passed.");
