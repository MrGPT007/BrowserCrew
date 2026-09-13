import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateSkill } from "../src/skills-contract.js";
import {
  assertSkillCompatibility,
  assertSkillMetadataGrantCoversRequirements,
  hasCompleteSkillContractMetadata,
  migrateSkillContractMetadata
} from "../src/skills-contract-metadata.js";
import { duplicateSkillAsDraft } from "../src/skills-library-lifecycle.js";
import { createNextVersionDraft } from "../src/skills-versioning.js";
import { exportSkillBundle, importSkillAsDraft, parseSkillBundle } from "../src/skills-portable.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/skills-contract-metadata.js",
  "src/skills-contract.js",
  "src/skills-runtime.js",
  "src/skills-versioning.js",
  "src/skills-library-lifecycle.js",
  "src/skills-portable.js",
  "src/skills-portable-ui.js",
  "src/skills-run-ui.js",
  "scripts/skills-contract-metadata-check.mjs",
  "scripts/skill-portable-smoke.mjs",
  "scripts/skill-run-ui-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const legacyApproved = {
  schemaVersion: 1,
  id: "supplier-review",
  version: "1.2.0",
  status: "approved",
  title: "Review supplier dashboard",
  description: "Read the supplier dashboard and prepare a reviewed update.",
  inputs: { query: { type: "string", required: true, secret: false, label: "Search query" } },
  allowedOrigins: ["https://example.test"],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: ["https://partner.test"],
  budgets: { maxSteps: 12, maxMinutes: 9 },
  steps: [
    { id: "step-type", kind: "type", purpose: "Enter the query.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.query}}" },
    { id: "step-verify", kind: "verify", purpose: "Verify the supplier result.", origin: "https://example.test", expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "The supplier result is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", createdAt: "2026-09-12T13:00:00.000Z" },
  approval: { approvedAt: "2026-09-12T13:05:00.000Z", approvedBy: "user" }
};
assert.equal(validateSkill(legacyApproved).ok, true, "Existing v1 Skills without extended metadata must remain readable.");
const legacySnapshot = JSON.stringify(legacyApproved);
const effective = migrateSkillContractMetadata(legacyApproved);
assert.equal(JSON.stringify(legacyApproved), legacySnapshot, "Metadata migration must never mutate stored immutable history in place.");
assert.equal(hasCompleteSkillContractMetadata(effective), true);
assert.deepEqual(effective.allowedResources, []);
assert.deepEqual(effective.providerRequirements, { capabilities: [] });
assert.deepEqual(effective.writePolicy, { approvalRequired: true, noBlindRetry: true });
assert.deepEqual(effective.verificationRules, { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true });
assert.equal(effective.createdAt, legacyApproved.provenance.createdAt);
assert.equal(effective.updatedAt, legacyApproved.provenance.createdAt);
assert.deepEqual(effective.compatibility, { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" });
assert.equal(validateSkill(effective, { requireApproved: true, requireMetadata: true }).ok, true);
assert.equal(assertSkillCompatibility(effective), true);
assert.throws(() => assertSkillCompatibility({ ...effective, compatibility: { ...effective.compatibility, minBrowserCrewVersion: "99.0.0" } }), /requires BrowserCrew 99\.0\.0 or newer/);

const scoped = {
  ...structuredClone(effective),
  allowedResources: ["workspace:supplier-review"],
  providerRequirements: { capabilities: ["text_generation"] }
};
assert.equal(validateSkill(scoped, { requireApproved: true, requireMetadata: true }).ok, true);
const fullGrant = { resources: ["workspace:supplier-review"], providerCapabilities: ["text_generation"] };
assert.equal(assertSkillMetadataGrantCoversRequirements(scoped, fullGrant), true);
assert.throws(() => assertSkillMetadataGrantCoversRequirements(scoped, { ...fullGrant, resources: [] }), /reviewed resource/);
assert.throws(() => assertSkillMetadataGrantCoversRequirements(scoped, { ...fullGrant, providerCapabilities: [] }), /provider capability/);
assert.equal(validateSkill({ ...scoped, writePolicy: { approvalRequired: false, noBlindRetry: true } }, { requireMetadata: true }).ok, false);
assert.equal(validateSkill({ ...scoped, verificationRules: { reobserveTargetsBeforeDispatch: false, requireFinalVerification: true } }, { requireMetadata: true }).ok, false);
assert.equal(validateSkill({ ...scoped, updatedAt: "2026-09-12T12:00:00.000Z" }, { requireMetadata: true }).ok, false);

const versionCreatedAt = "2026-09-13T02:00:00.000Z";
const next = createNextVersionDraft(scoped, [scoped], { createdAt: versionCreatedAt });
assert.equal(next.id, scoped.id);
assert.equal(next.version, "1.2.1");
assert.equal(next.status, "draft");
assert.equal(next.createdAt, versionCreatedAt, "A new version needs its own creation timestamp.");
assert.equal(next.updatedAt, versionCreatedAt);
assert.deepEqual(next.allowedResources, scoped.allowedResources);
assert.deepEqual(next.providerRequirements, scoped.providerRequirements);
assert.deepEqual(next.provenance.sourceSkillRef, { id: scoped.id, version: scoped.version });
assert.equal(next.approval, undefined);

const duplicateCreatedAt = "2026-09-13T02:05:00.000Z";
const duplicate = duplicateSkillAsDraft(scoped, { id: "supplier-review-copy", createdAt: duplicateCreatedAt });
assert.equal(duplicate.createdAt, duplicateCreatedAt, "A duplicate needs its own creation timestamp.");
assert.equal(duplicate.updatedAt, duplicateCreatedAt);
assert.deepEqual(duplicate.allowedResources, scoped.allowedResources);
assert.deepEqual(duplicate.providerRequirements, scoped.providerRequirements);
assert.deepEqual(duplicate.provenance.sourceSkillRef, { id: scoped.id, version: scoped.version });
assert.equal(scoped.status, "approved", "Creating drafts must not mutate the source approved version.");

const firstExport = exportSkillBundle(scoped);
const parsed = parseSkillBundle(firstExport);
assert.equal(parsed.canonicalText, firstExport, "Metadata-complete portable JSON must remain byte-stable across parse/export.");
assert.deepEqual(parsed.preview.allowedResources, scoped.allowedResources);
assert.deepEqual(parsed.preview.providerCapabilities, scoped.providerRequirements.capabilities);
const importedAt = "2026-09-13T02:10:00.000Z";
const imported = importSkillAsDraft(parsed, { id: "supplier-review-import", createdAt: importedAt });
assert.equal(imported.status, "draft");
assert.equal(imported.createdAt, importedAt);
assert.equal(imported.updatedAt, importedAt);
assert.deepEqual(imported.allowedResources, scoped.allowedResources);
assert.deepEqual(imported.providerRequirements, scoped.providerRequirements);
assert.equal(imported.approval, undefined);
assert.deepEqual(imported.provenance.sourceSkillRef, { id: scoped.id, version: scoped.version });

const runtimeSource = await readFile("src/skills-runtime.js", "utf8");
const metadataGrantCheck = runtimeSource.indexOf("assertSkillMetadataGrantCoversRequirements(skill, grant)");
const runReceiptCreation = runtimeSource.indexOf("const run = {");
assert.ok(metadataGrantCheck >= 0, "Skill runtime must enforce resource/provider requirements.");
assert.ok(runReceiptCreation > metadataGrantCheck, "Resource/provider authority must be checked before durable running state is created.");
assert.ok(runtimeSource.includes("migrateSkillContractMetadata(stored)"), "Legacy Skill metadata must be normalized on read.");
assert.ok(runtimeSource.includes("validateSkill(skill, { requireMetadata: true })"), "New saved drafts must persist complete metadata.");

const runUi = await readFile("src/skills-run-ui.js", "utf8");
for (const phrase of ["Resources:", "Provider capabilities:", "resources: [...resources]", "providerCapabilities: [...providerCapabilities]"]) {
  assert.ok(runUi.includes(phrase), `One-run metadata review contract missing: ${phrase}`);
}
const portableUi = await readFile("src/skills-portable-ui.js", "utf8");
for (const phrase of ["Requested resources", "Provider capabilities"]) assert.ok(portableUi.includes(phrase), `Import review must expose ${phrase}.`);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Metadata hardening must not widen the active v0.2 manifest.");
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Metadata hardening must not boot production scheduling.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["skills-contract-metadata-check"], "node scripts/skills-contract-metadata-check.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("skills-contract-metadata-check.mjs"));

console.log("BrowserCrew complete Skill contract metadata checks passed.");
