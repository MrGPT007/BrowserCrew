import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  SKILL_PORTABLE_FORMAT,
  SKILL_PORTABLE_FORMAT_VERSION,
  exportSkillBundle,
  importSkillAsDraft,
  parseSkillBundle
} from "../src/skills-portable.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/skills-portable.js",
  "src/skills-portable-ui.js",
  "scripts/skills-portable-check.mjs",
  "scripts/skill-portable-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const skill = {
  schemaVersion: 1,
  id: "portable-supplier-review",
  version: "2.3.1",
  status: "approved",
  title: "Review supplier dashboard",
  description: "Read the supplier dashboard, prepare reviewed data, and verify the result.",
  inputs: {
    searchTerm: { name: "searchTerm", type: "string", required: true, secret: false, label: "Search term", maxLength: 80 },
    accountSecret: { name: "accountSecret", type: "string", required: true, secret: true, label: "Private value" }
  },
  allowedOrigins: ["https://example.test"],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: ["https://partner.test"],
  budgets: { maxSteps: 12, maxMinutes: 9 },
  steps: [
    { id: "step-search", kind: "type", purpose: "Enter the reviewed search term.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.searchTerm}}" },
    { id: "step-verify", kind: "verify", purpose: "Verify the reviewed result.", origin: "https://example.test", expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "The supplier result is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", sessionId: "watch-portable", createdAt: "2026-09-13T00:00:00.000Z", eventCount: 2 },
  approval: { approvedAt: "2026-09-13T00:05:00.000Z", approvedBy: "user" }
};

const first = exportSkillBundle(skill);
const second = exportSkillBundle(structuredClone(skill));
assert.equal(first, second, "Portable Skill export must be deterministic for the same exact version.");
const parsed = parseSkillBundle(first);
assert.equal(parsed.format, SKILL_PORTABLE_FORMAT);
assert.equal(parsed.formatVersion, SKILL_PORTABLE_FORMAT_VERSION);
assert.equal(parsed.canonicalText, first, "Export -> parse -> export must be a deterministic round trip.");
assert.deepEqual(parsed.preview.allowedOrigins, skill.allowedOrigins);
assert.deepEqual(parsed.preview.actionClasses, skill.actionClasses);
assert.deepEqual(parsed.preview.dataDestinations, skill.dataDestinations);
assert.deepEqual(parsed.preview.sourceRef, { id: skill.id, version: skill.version, status: "approved" });
assert.equal(parsed.sourceSkill.approval.approvedBy, "user");
assert.equal(parsed.sourceSkill.inputs.accountSecret.default, undefined, "Portable exports must not invent a secret default.");

const imported = importSkillAsDraft(parsed, { id: "skill-import-1234", createdAt: "2026-09-13T01:00:00.000Z" });
assert.equal(imported.id, "skill-import-1234");
assert.equal(imported.version, "0.1.0");
assert.equal(imported.status, "draft");
assert.equal(imported.approval, undefined, "Imported Skill must lose source approval authority.");
assert.equal(imported.archivedAt, undefined, "Imported Skill must lose archive state.");
assert.deepEqual(imported.allowedOrigins, skill.allowedOrigins);
assert.deepEqual(imported.actionClasses, skill.actionClasses);
assert.deepEqual(imported.dataDestinations, skill.dataDestinations);
assert.deepEqual(imported.budgets, skill.budgets);
assert.deepEqual(imported.steps, skill.steps);
assert.equal(imported.provenance.source, "skill_import");
assert.deepEqual(imported.provenance.sourceSkillRef, { id: skill.id, version: skill.version });
assert.equal(imported.provenance.portableFormatVersion, SKILL_PORTABLE_FORMAT_VERSION);

const hostileEnvelope = JSON.parse(first);
hostileEnvelope.skill.remoteCode = "https://evil.test/payload.js";
assert.throws(() => parseSkillBundle(JSON.stringify(hostileEnvelope)), /forbidden executable field|forbidden/i);
const nestedHostile = JSON.parse(first);
nestedHostile.skill.steps[0].target.scriptUrl = "https://evil.test/target.js";
assert.throws(() => parseSkillBundle(JSON.stringify(nestedHostile)), /forbidden executable field/i);
const unknownEnvelope = JSON.parse(first);
unknownEnvelope.authority = "run-anywhere";
assert.throws(() => parseSkillBundle(JSON.stringify(unknownEnvelope)), /Unsupported Skill bundle field: authority/);
const wrongVersion = JSON.parse(first);
wrongVersion.formatVersion = 999;
assert.throws(() => parseSkillBundle(JSON.stringify(wrongVersion)), /Unsupported Skill export version/);
assert.throws(() => parseSkillBundle("not-json"), /not valid JSON/);
assert.throws(() => parseSkillBundle(" "), /Choose a BrowserCrew Skill JSON file/);

const ui = await readFile("src/skills-portable-ui.js", "utf8");
for (const phrase of [
  "Import Skill JSON",
  "Export JSON",
  "UNTRUSTED IMPORT",
  "Requested websites",
  "Requested actions",
  "Data destinations",
  "Import as draft",
  "Importing never preserves approval or archive authority.",
  "Nothing runs and no permission is granted by this file.",
  'type: "saveDraft"'
]) if (!ui.includes(phrase)) throw new Error(`Portable Skill UI safety contract missing: ${phrase}`);
if (ui.includes("chrome.permissions.request")) throw new Error("Skill import/export must not request new Chrome permissions.");

const sidepanel = await readFile("src/sidepanel.js", "utf8");
if (!sidepanel.includes('import "./skills-portable-ui.js"')) throw new Error("Side panel must load safe Skill import/export UI.");

const runner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!runner.includes('"skill-portable-smoke.mjs"')) throw new Error("Chrome 152 matrix must include portable Skill smoke coverage.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run skill-portable-smoke",
  "name: skill-portable-evidence",
  "path: artifacts/skill-portable-smoke"
]) if (!workflow.includes(phrase)) throw new Error(`Current-stable portable Skill CI gate missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["skills-portable-check"] !== "node scripts/skills-portable-check.mjs") throw new Error("skills-portable-check must stay wired.");
if (pkg.scripts?.["skill-portable-smoke"] !== "node scripts/skill-portable-smoke.mjs") throw new Error("skill-portable-smoke must stay wired.");
if (!String(pkg.scripts?.check || "").includes("skills-portable-check.mjs")) throw new Error("npm run check must include portable Skill contracts.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if ((manifest.permissions || []).includes("alarms")) throw new Error("Portable Skill work must not widen the v0.2 manifest with alarms.");
const serviceWorker = await readFile("src/service-worker.js", "utf8");
if (serviceWorker.includes("bootSchedulesRuntime")) throw new Error("Portable Skill work must not activate production scheduling.");

console.log("BrowserCrew deterministic safe Skill import/export contracts passed.");
