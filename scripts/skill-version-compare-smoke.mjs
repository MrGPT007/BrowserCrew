import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-library-lifecycle-smoke", "version-compare");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-version-compare-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_version_compare_smoke", startedAt: new Date().toISOString(), checks: [] };

function baseSkill() {
  return {
    schemaVersion: 1,
    id: "supplier-check",
    version: "1.0.0",
    status: "approved",
    title: "Supplier check",
    description: "Check a supplier safely.",
    inputs: { apiKey: { type: "string", required: true, secret: true, label: "Private supplier key" } },
    allowedOrigins: ["https://example.test"],
    allowedResources: [],
    actionClasses: ["read", "page_write_prepare"],
    dataDestinations: [],
    providerRequirements: { capabilities: [] },
    budgets: { maxSteps: 6, maxMinutes: 5 },
    steps: [
      { id: "step-type", kind: "type", purpose: "Enter supplier query.", origin: "https://example.test", target: { role: "textbox", label: "Search" }, value: "{{input.apiKey}}" },
      { id: "step-final", kind: "verify", purpose: "Verify supplier result.", origin: "https://example.test", expect: { visibleText: "Ready" } }
    ],
    completionCriteria: [{ claim: "Ready", verification: "Visible Ready" }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "test", createdAt: "2026-09-13T00:00:00.000Z" },
    approval: { approvedAt: "2026-09-13T00:01:00.000Z", approvedBy: "user" },
    writePolicy: { approvalRequired: true, noBlindRetry: true },
    verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:01:00.000Z",
    compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
  };
}
const base = baseSkill();
const candidate = structuredClone(base);
candidate.version = "1.1.0";
candidate.status = "draft";
candidate.title = "Supplier check with export";
candidate.description = "Check a supplier and prepare an export.";
delete candidate.approval;
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
candidate.steps.splice(1, 0, { id: "step-export", kind: "click", purpose: "Export supplier data.", origin: "https://example.test", target: { role: "button", label: "Export" }, value: "COMPARE_LITERAL_CANARY_77" });
candidate.compatibility.minBrowserCrewVersion = "0.3.0";
candidate.updatedAt = "2026-09-13T01:00:00.000Z";
const unrelated = { ...baseSkill(), id: "other-skill", version: "2.0.0", title: "Other skill" };

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;
  await worker.evaluate(async (skills) => chrome.storage.local.set({ "browsercrew.skillLibrary.v1": skills }), [base, candidate, unrelated]);

  const storageBefore = await worker.evaluate(async () => chrome.storage.local.get(null));
  const permissionsBefore = await worker.evaluate(async () => chrome.permissions.getAll());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await waitUntil(async () => await panel.locator('[data-skill-record="supplier-check@@1.1.0"]').count() === 1, "Candidate exact version should render in My Skills.");
  const card = panel.locator('[data-skill-record="supplier-check@@1.1.0"]');
  await card.getByRole("button", { name: "Compare versions" }).waitFor({ state: "visible", timeout: timeoutMs });
  pass("Every exact saved Skill version exposes read-only Compare without replacing lifecycle controls");

  await card.getByRole("button", { name: "Compare versions" }).click();
  const compare = panel.locator("#skillVersionComparePanel");
  await compare.waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await compare.innerText(), /READ-ONLY VERSION COMPARE/i);
  assert.match(await compare.innerText(), /cannot approve, run, save, archive, or grant site access/i);
  assert.equal(await compare.locator('[data-compare-base-version] option').count(), 1, "Only versions of the same stable Skill ID may be selected as comparison baselines.");
  assert.equal(await compare.locator('[data-compare-base-version]').inputValue(), "1.0.0");
  const resultText = await panel.locator("#skillVersionCompareResult").innerText();
  assert.match(resultText, /v1\.0\.0 → v1\.1\.0/);
  assert.match(resultText, /Review widening/);
  assert.match(resultText, /ACCESS WIDENING/);
  assert.match(resultText, /https:\/\/new\.example\.test/);
  assert.match(resultText, /crm:vendors/);
  assert.match(resultText, /vision/);
  assert.match(resultText, /SAFETY WEAKENING/);
  assert.match(resultText, /Private supplier key/);
  assert.match(resultText, /NEW BEHAVIOR/);
  assert.match(resultText, /step-export/);
  assert.equal(resultText.includes("COMPARE_LITERAL_CANARY_77"), false, "Compare surface must not reveal literal step values.");
  assert.deepEqual(await compare.getByRole("button").allTextContents(), ["Close"], "Compare panel must expose no mutation or execution controls.");
  pass("Compare separates scope widening, safety weakening, input privacy changes, and new semantic behavior without revealing literals");

  const storageAfter = await worker.evaluate(async () => chrome.storage.local.get(null));
  const permissionsAfter = await worker.evaluate(async () => chrome.permissions.getAll());
  assert.deepEqual(storageAfter, storageBefore, "Read-only Compare must not mutate Skills, approvals, runs, or any durable state.");
  assert.deepEqual(permissionsAfter, permissionsBefore, "Read-only Compare must not request or change Chrome permissions.");
  assert.equal(Array.isArray(storageAfter["browsercrew.skillRuns.v1"]) ? storageAfter["browsercrew.skillRuns.v1"].length : 0, 0, "Read-only Compare must not create a Skill run.");
  pass("Compare produced zero storage, approval, execution, and permission side effects");

  await panel.screenshot({ path: join(artifactDir, "skill-version-compare.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.skillId = candidate.id;
  report.fromVersion = base.version;
  report.toVersion = candidate.version;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Skill exact-version Compare installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "skill-version-compare-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function prepareExtension(target) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    const first = relative.split(/[/\\]/)[0];
    return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
  } });
}
async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
