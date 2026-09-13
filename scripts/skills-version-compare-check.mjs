import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { compareSkillVersions } from "../src/skills-version-diff.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/skills-version-diff.js",
  "src/skills-version-compare-ui.js",
  "scripts/skills-version-compare-check.mjs",
  "scripts/skill-version-compare-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const base = {
  schemaVersion: 1,
  id: "supplier-check",
  version: "1.0.0",
  status: "approved",
  title: "Supplier check",
  description: "Check one supplier safely.",
  inputs: { apiKey: { type: "string", required: true, secret: true, label: "Private key" } },
  allowedOrigins: ["https://example.test"],
  allowedResources: [],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  providerRequirements: { capabilities: [] },
  budgets: { maxSteps: 6, maxMinutes: 5 },
  steps: [
    { id: "step-type", kind: "type", purpose: "Enter query.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.apiKey}}" },
    { id: "step-final", kind: "verify", purpose: "Verify ready.", origin: "https://example.test", expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "Ready", verification: "Visible Ready" }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-13T00:00:00.000Z" },
  approval: { approvedAt: "2026-09-13T00:01:00.000Z", approvedBy: "user" },
  allowedResources: [],
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:01:00.000Z",
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
};
const candidate = structuredClone(base);
candidate.version = "1.1.0";
candidate.status = "draft";
delete candidate.approval;
candidate.title = "Supplier check with export";
candidate.inputs.apiKey.secret = false;
candidate.allowedOrigins.push("https://new.example.test");
candidate.allowedResources.push("crm:vendors");
candidate.actionClasses.push("download");
candidate.dataDestinations.push("local_download");
candidate.providerRequirements.capabilities.push("vision");
candidate.budgets = { maxSteps: 10, maxMinutes: 8 };
candidate.writePolicy = { approvalRequired: false, noBlindRetry: false };
candidate.verificationRules = { reobserveTargetsBeforeDispatch: false, requireFinalVerification: false };
candidate.recovery = { retryWrites: true, reconcileUnknownWrites: false };
candidate.steps.splice(1, 0, { id: "step-export", kind: "click", purpose: "Export supplier data.", origin: "https://example.test", target: { role: "button", label: "Export" }, value: "HOSTILE_LITERAL_SHOULD_NOT_RENDER" });
candidate.compatibility.minBrowserCrewVersion = "0.3.0";

const first = compareSkillVersions(base, candidate);
const second = compareSkillVersions(base, candidate);
assert.equal(JSON.stringify(first), JSON.stringify(second), "Exact-version comparison must be deterministic.");
assert.equal(first.skillId, "supplier-check");
assert.deepEqual(first.from, { version: "1.0.0", status: "approved" });
assert.deepEqual(first.to, { version: "1.1.0", status: "draft" });
assert.ok(first.wideningCount >= 1);
assert.ok(first.changes.some((change) => change.section === "Access" && change.label === "Websites" && change.review === "scope_widening"));
assert.ok(first.changes.some((change) => change.section === "Inputs" && change.label === "apiKey" && change.review === "safety_weakening"));
assert.ok(first.changes.some((change) => change.section === "Write safety" && change.review === "safety_weakening"));
assert.ok(first.changes.some((change) => change.section === "Steps" && change.label === "step-export" && change.review === "behavior_expansion"));
assert.equal(JSON.stringify(first).includes("HOSTILE_LITERAL_SHOULD_NOT_RENDER"), false, "Version comparison must not surface literal step values.");
assert.throws(() => compareSkillVersions(base, { ...candidate, id: "other-skill" }), /same saved Skill/);

const ui = await readFile("src/skills-version-compare-ui.js", "utf8");
for (const phrase of [
  "Compare versions",
  "READ-ONLY VERSION COMPARE",
  "cannot approve, run, save, archive, or grant site access",
  "ACCESS WIDENING",
  "SAFETY WEAKENING",
  "NEW BEHAVIOR",
  'type: "get"',
  'type: "list"'
]) assert.ok(ui.includes(phrase), `Skill version Compare UI contract missing: ${phrase}`);
for (const forbidden of ["chrome.permissions.request", "chrome.storage", 'type: "run"', 'type: "saveDraft"', 'type: "approve"', 'type: "archive"']) {
  assert.equal(ui.includes(forbidden), false, `Read-only Compare must not contain authority/mutation path: ${forbidden}`);
}

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./skills-version-compare-ui.js";'), "Side panel must load exact-version Compare UI.");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["skills-version-compare-check"], "node scripts/skills-version-compare-check.mjs");
assert.equal(pkg.scripts?.["skill-version-compare-smoke"], "node scripts/skill-version-compare-smoke.mjs");
assert.ok(String(pkg.scripts?.["skill-library-lifecycle-smoke"] || "").includes("node scripts/skill-library-lifecycle-smoke.mjs"));
assert.ok(String(pkg.scripts?.["skill-library-lifecycle-smoke"] || "").includes("node scripts/skill-version-compare-smoke.mjs"));
assert.ok(String(pkg.scripts?.check || "").includes("skills-version-compare-check.mjs"));

const runner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(runner.includes('"skill-version-compare-smoke.mjs"'), "Chrome 152 matrix must include exact-version Compare coverage.");
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false);
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false);

console.log("BrowserCrew read-only Skill exact-version comparison contracts passed.");
