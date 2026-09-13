import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createNextVersionDraft } from "../src/skills-versioning.js";

const execFileAsync = promisify(execFile);
const files = [
  "src/skills-versioning.js",
  "src/skills-test.js",
  "src/skills-run-ui.js",
  "scripts/skill-run-ui-smoke.mjs"
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
assert.equal(next.id, sample.id, "A new version must preserve the stable skill id.");
assert.equal(next.version, "1.0.2", "A new version draft must increment beyond existing exact versions.");
assert.equal(next.status, "draft");
assert.equal(next.approval, undefined, "A new version draft must not inherit approval authority.");
assert.equal(next.archivedAt, undefined);
assert.deepEqual(next.allowedOrigins, sample.allowedOrigins);
assert.deepEqual(next.actionClasses, sample.actionClasses);
assert.deepEqual(next.provenance.sourceSkillRef, { id: sample.id, version: sample.version });

const testSource = await readFile("src/skills-test.js", "utf8");
for (const phrase of ["testApprovedSkillOnPage", "materializeSkillSteps", "TARGET_AMBIGUOUS", "Test does not navigate", "Recorded download replay is not enabled", "CLICK_REQUIRES_COMMIT_APPROVAL"]) assert.ok(testSource.includes(phrase), `Safe Test contract missing: ${phrase}`);
assert.equal(testSource.includes("el.click()"), false, "Safe Test must never click page controls.");
assert.equal(testSource.includes("el.value ="), false, "Safe Test must never type into page controls.");
assert.equal(testSource.includes("chrome.tabs.update"), false, "Safe Test must never navigate the page.");

const ui = await readFile("src/skills-run-ui.js", "utf8");
for (const phrase of [
  "A Skill is a saved way to do a browser job",
  "Versions",
  "Create next draft version",
  "Test this page (no changes)",
  "Review and run once",
  "Saved Skill requirements do not grant permission by themselves",
  'scope: "one_run"',
  'type: "run"',
  "chrome.permissions.request"
]) assert.ok(ui.includes(phrase), `Skill Test/Run UI contract missing: ${phrase}`);
assert.equal(ui.includes("chrome.storage"), false, "One-run grants must not be persisted by the Skill UI.");

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./skills-run-ui.js";'), "Side panel must load the Versions/Test/Run UI.");
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Skill Test/Run must not boot production scheduling or add alarms permission.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of ["npm run skill-run-ui-smoke", "skill-run-ui-evidence"]) assert.ok(workflow.includes(phrase), `Quality workflow Skill Test/Run coverage missing: ${phrase}`);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["skills-run-ui-check"], "node scripts/skills-run-ui-check.mjs");
assert.equal(pkg.scripts?.["skill-run-ui-smoke"], "node scripts/skill-run-ui-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("skills-run-ui-check.mjs"));

console.log("BrowserCrew Skill Versions/Test/Run contracts passed.");
