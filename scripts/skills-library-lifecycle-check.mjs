import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { duplicateSkillAsDraft } from "../src/skills-library-lifecycle.js";
import { validateSkill } from "../src/skills-contract.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/skills-library-lifecycle.js",
  "src/skills-library-lifecycle-ui.js",
  "scripts/skills-library-lifecycle-check.mjs",
  "scripts/skill-library-lifecycle-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const source = {
  schemaVersion: 1,
  id: "supplier-check",
  version: "1.4.0",
  status: "approved",
  title: "Check supplier dashboard",
  description: "Read the supplier dashboard and prepare a reviewed update.",
  inputs: { query: { name: "query", type: "string", required: true, secret: false, label: "Search query" } },
  allowedOrigins: ["https://example.test"],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  budgets: { maxSteps: 12, maxMinutes: 9 },
  steps: [
    { id: "step-type", kind: "type", purpose: "Enter the query.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.query}}" },
    { id: "step-verify", kind: "verify", purpose: "Verify the supplier dashboard result.", origin: "https://example.test", expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "The supplier result is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", createdAt: "2026-09-12T13:00:00.000Z" },
  approval: { approvedAt: "2026-09-12T13:05:00.000Z", approvedBy: "user" }
};
assert.equal(validateSkill(source).ok, true);
const duplicate = duplicateSkillAsDraft(source, {
  id: "skill-copy-1234",
  title: "Check supplier dashboard copy",
  createdAt: "2026-09-12T14:00:00.000Z"
});
assert.equal(duplicate.id, "skill-copy-1234");
assert.equal(duplicate.version, "0.1.0");
assert.equal(duplicate.status, "draft");
assert.equal(duplicate.approval, undefined);
assert.equal(duplicate.archivedAt, undefined);
assert.deepEqual(duplicate.allowedOrigins, source.allowedOrigins);
assert.deepEqual(duplicate.actionClasses, source.actionClasses);
assert.deepEqual(duplicate.dataDestinations, source.dataDestinations);
assert.deepEqual(duplicate.budgets, source.budgets);
assert.deepEqual(duplicate.steps, source.steps);
assert.deepEqual(duplicate.inputs, source.inputs);
assert.deepEqual(duplicate.recovery, source.recovery);
assert.deepEqual(duplicate.provenance.sourceSkillRef, { id: source.id, version: source.version });
assert.equal(duplicate.provenance.source, "skill_duplicate");
assert.equal(validateSkill(duplicate).ok, true);
assert.equal(source.status, "approved", "Duplicating must not mutate the source version.");
assert.ok(source.approval, "Duplicating must not strip approval from the source version.");
assert.throws(() => duplicateSkillAsDraft({ ...source, id: "INVALID ID" }, { id: "copy-id", createdAt: "2026-09-12T14:00:00.000Z" }), /Cannot duplicate invalid skill version/);

const ui = await readFile("src/skills-library-lifecycle-ui.js", "utf8");
for (const phrase of [
  "All versions",
  "Drafts",
  "Approved",
  "Archived",
  'type: "deleteDraft"',
  'type: "archive"',
  'type: "saveDraft"',
  "Duplicate as draft",
  "Archived versions stay in history but cannot run or be scheduled.",
  "Only this unapproved draft will be removed."
]) if (!ui.includes(phrase)) throw new Error(`Skill library lifecycle UI contract missing: ${phrase}`);
if (ui.includes('type: "delete"')) throw new Error("Skill library lifecycle must not introduce a generic delete operation for approved or archived history.");

const sidepanel = await readFile("src/sidepanel.js", "utf8");
if (!sidepanel.includes('import "./skills-library-lifecycle-ui.js"')) throw new Error("Side panel must load the skill library lifecycle UI.");

const runner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!runner.includes('"skill-library-lifecycle-smoke.mjs"')) throw new Error("Chrome 152 matrix must include skill library lifecycle smoke coverage.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run skill-library-lifecycle-smoke",
  "name: skill-library-lifecycle-evidence",
  "path: artifacts/skill-library-lifecycle-smoke"
]) if (!workflow.includes(phrase)) throw new Error(`Current-stable Skill library lifecycle CI gate missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["skills-library-lifecycle-check"] !== "node scripts/skills-library-lifecycle-check.mjs") throw new Error("skills-library-lifecycle-check must stay wired.");
if (pkg.scripts?.["skill-library-lifecycle-smoke"] !== "node scripts/skill-library-lifecycle-smoke.mjs") throw new Error("skill-library-lifecycle-smoke must stay wired.");
if (!String(pkg.scripts?.check || "").includes("skills-library-lifecycle-check.mjs")) throw new Error("npm run check must include Skill library lifecycle contracts.");

console.log("BrowserCrew Skill library lifecycle contracts passed.");
