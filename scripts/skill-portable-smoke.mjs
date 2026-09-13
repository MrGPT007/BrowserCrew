import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { exportSkillBundle, parseSkillBundle } from "../src/skills-portable.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-portable-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-portable-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_portable_smoke", startedAt: new Date().toISOString(), checks: [] };

const sourceSkill = {
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
  allowedResources: ["workspace:supplier-review"],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: ["https://partner.test"],
  providerRequirements: { capabilities: ["text_generation"] },
  budgets: { maxSteps: 12, maxMinutes: 9 },
  steps: [
    { id: "step-search", kind: "type", purpose: "Enter the reviewed search term.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.searchTerm}}", review: { stability: "stable", unresolved: false } },
    { id: "step-verify", kind: "verify", purpose: "Verify the reviewed result.", origin: "https://example.test", expect: { visibleText: "Ready" }, review: { stability: "stable", unresolved: false } }
  ],
  completionCriteria: [{ claim: "The supplier result is ready.", verification: "Visible text says Ready." }],
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", sessionId: "watch-portable", createdAt: "2026-09-13T00:00:00.000Z", eventCount: 2 },
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:05:00.000Z",
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" },
  approval: { approvedAt: "2026-09-13T00:05:00.000Z", approvedBy: "user" }
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);
  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false, "Portable Skill proof must keep the v0.2 manifest free of alarms permission.");

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  await worker.evaluate(async (skillSeed) => {
    await chrome.storage.local.set({ "browsercrew.skillLibrary.v1": [skillSeed] });
  }, sourceSkill);
  const permissionsBefore = await grantedPermissions(worker);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.getByRole("button", { name: "Import Skill JSON" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("button", { name: "Export JSON" }).waitFor({ state: "visible", timeout: timeoutMs });
  pass("My Skills exposes explicit JSON import and per-version export controls");

  const downloadPromise = panel.waitForEvent("download", { timeout: timeoutMs });
  await panel.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /review-supplier-dashboard-v2\.3\.1\.browsercrew-skill\.json$/);
  const exportedPath = join(artifactDir, "exported-skill.json");
  await download.saveAs(exportedPath);
  const exportedText = await readFile(exportedPath, "utf8");
  assert.equal(exportedText, exportSkillBundle(sourceSkill), "UI export must use the deterministic portable Skill format.");
  const parsed = parseSkillBundle(exportedText);
  assert.equal(parsed.canonicalText, exportedText, "Export -> parse -> export must stay byte-stable.");
  assert.deepEqual(parsed.preview.allowedResources, sourceSkill.allowedResources);
  assert.deepEqual(parsed.preview.providerCapabilities, sourceSkill.providerRequirements.capabilities);
  assert.equal(parsed.preview.unresolvedStepCount, 0);
  assert.equal(parsed.preview.fragileStepCount, 0);
  assert.deepEqual(parsed.sourceSkill.steps[0].review, { stability: "stable", unresolved: false });
  pass("Approved exact version exports deterministic target-review metadata without changing authority");

  const libraryAfterExport = await storedSkills(worker);
  assert.equal(libraryAfterExport.length, 1);
  assert.equal(libraryAfterExport[0].status, "approved");
  assert.ok(libraryAfterExport[0].approval, "Export must not mutate source approval.");

  await panel.locator("#skillImportFile").setInputFiles({
    name: "supplier.browsercrew-skill.json",
    mimeType: "application/json",
    buffer: Buffer.from(exportedText)
  });
  const preview = panel.locator("#skillImportPreview");
  await preview.waitFor({ state: "visible", timeout: timeoutMs });
  const previewText = await preview.innerText();
  assert.match(previewText, /UNTRUSTED IMPORT/i);
  assert.match(previewText, /https:\/\/example\.test/);
  assert.match(previewText, /workspace:supplier-review/);
  assert.match(previewText, /page_write_prepare/);
  assert.match(previewText, /text_generation/);
  assert.match(previewText, /https:\/\/partner\.test/);
  assert.match(previewText, /Importing never preserves approval or archive authority/i);
  assert.match(previewText, /Nothing runs and no permission is granted/i);
  assert.equal((await storedSkills(worker)).length, 1, "Previewing an import must not persist it.");
  pass("Untrusted import previews exact sites, resources, actions, provider capabilities, destinations, budgets, and source version before persistence");

  await preview.getByRole("button", { name: "Import as draft" }).click();
  await waitUntil(async () => (await storedSkills(worker)).length === 2, "Confirmed Skill import should create one additional version.");
  const skills = await storedSkills(worker);
  const imported = skills.find((item) => item.provenance?.source === "skill_import");
  assert.ok(imported, "Imported draft should be identifiable by provenance.");
  assert.notEqual(imported.id, sourceSkill.id);
  assert.equal(imported.version, "0.1.0");
  assert.equal(imported.status, "draft");
  assert.equal(imported.approval, undefined, "Import must strip source approval authority.");
  assert.equal(imported.archivedAt, undefined);
  assert.deepEqual(imported.allowedOrigins, sourceSkill.allowedOrigins);
  assert.deepEqual(imported.allowedResources, sourceSkill.allowedResources);
  assert.deepEqual(imported.actionClasses, sourceSkill.actionClasses);
  assert.deepEqual(imported.providerRequirements, sourceSkill.providerRequirements);
  assert.deepEqual(imported.dataDestinations, sourceSkill.dataDestinations);
  assert.deepEqual(imported.budgets, sourceSkill.budgets);
  assert.deepEqual(imported.steps, sourceSkill.steps, "Import must preserve target-review metadata exactly.");
  assert.deepEqual(imported.provenance.sourceSkillRef, { id: sourceSkill.id, version: sourceSkill.version });
  assert.equal(imported.createdAt, imported.provenance.createdAt);
  assert.ok(Date.parse(imported.updatedAt) >= Date.parse(imported.createdAt));
  assert.equal(skills.find((item) => item.id === sourceSkill.id)?.status, "approved", "Import must not alter the source exact version.");
  await waitUntil(async () => /Imported as a new draft/i.test(await panel.locator("#toast").innerText()), "Import should explain that the new version remains a draft.");
  const permissionsAfterImport = await grantedPermissions(worker);
  assert.deepEqual(permissionsAfterImport, permissionsBefore, "Skill import must not grant Chrome permissions.");
  pass("Confirmed import creates a new unapproved 0.1.0 draft, preserves bounded declarative scope, metadata, and reviewed target state, and grants nothing");

  const fragile = JSON.parse(exportedText);
  fragile.skill.status = "draft";
  delete fragile.skill.approval;
  fragile.skill.steps[0].target = { role: "textbox" };
  fragile.skill.steps[0].review = {
    stability: "fragile",
    unresolved: true,
    reason: "This recorded target has a weak semantic fingerprint. Review or remove this step before approving the skill."
  };
  await panel.locator("#skillImportFile").setInputFiles({
    name: "fragile.browsercrew-skill.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fragile))
  });
  const fragilePreview = panel.locator("#skillImportPreview");
  await fragilePreview.waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await fragilePreview.innerText(), /1 recorded target still needs review/i);
  assert.match(await fragilePreview.innerText(), /Fragile-step review state is preserved by import/i);
  assert.equal((await storedSkills(worker)).length, 2, "Reviewing unresolved import metadata must not persist the file.");
  await fragilePreview.getByRole("button", { name: "Cancel import" }).click();
  await waitUntil(async () => await panel.locator("#skillImportPreview").count() === 0, "Cancelling unresolved import preview should remove the preview.");
  pass("Portable import visibly preserves unresolved fragile-target state instead of silently trusting it");

  const hostile = JSON.parse(exportedText);
  hostile.skill.remoteCode = "https://evil.test/payload.js";
  await panel.locator("#skillImportFile").setInputFiles({
    name: "hostile.browsercrew-skill.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(hostile))
  });
  await waitUntil(async () => /forbidden executable field|forbidden/i.test(await panel.locator("#toast").innerText()), "Hostile executable import should fail closed.");
  assert.equal(await panel.locator("#skillImportPreview").count(), 0, "Rejected hostile import must not leave an actionable preview.");
  assert.equal((await storedSkills(worker)).length, 2, "Rejected hostile import must not persist anything.");
  assert.deepEqual(await grantedPermissions(worker), permissionsBefore, "Rejected import must not alter Chrome permissions.");
  pass("Executable or remote-code fields are rejected before preview, persistence, approval, or permission changes");

  await panel.screenshot({ path: join(artifactDir, "skill-portable.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew safe Skill import/export installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function storedSkills(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []);
}

async function grantedPermissions(worker) {
  return worker.evaluate(async () => {
    const value = await chrome.permissions.getAll();
    return {
      origins: [...(value.origins || [])].sort(),
      permissions: [...(value.permissions || [])].sort()
    };
  });
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareExtension(target) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
    }
  });
}

async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
