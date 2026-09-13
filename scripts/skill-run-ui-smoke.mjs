import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-run-ui-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-run-ui-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_run_ui_smoke", startedAt: new Date().toISOString(), checks: [] };
const fixture = await startFixtureServer();
const RUN_VALUE = "safe-runtime-query-42";

function skill(version, status) {
  return {
    schemaVersion: 1,
    id: "supplier-check",
    version,
    status,
    title: "Supplier check",
    description: "Enter a supplier query, preview it, and check the visible result without submitting anything.",
    inputs: { query: { type: "string", required: true, secret: false, label: "Search query" } },
    allowedOrigins: [fixture.origin],
    actionClasses: ["read", "page_write_prepare"],
    dataDestinations: [],
    budgets: { maxSteps: 8, maxMinutes: 5 },
    steps: [
      { id: "step-type", kind: "type", purpose: "Enter the run-time query.", origin: fixture.origin, target: { role: "textbox", label: "Search" }, value: "{{input.query}}" },
      { id: "step-preview", kind: "click", purpose: "Preview the query without submitting it.", origin: fixture.origin, target: { role: "button", label: "Preview" } },
      { id: "step-verify", kind: "verify", purpose: "Verify the preview result.", origin: fixture.origin, expect: { visibleText: "Ready" } }
    ],
    completionCriteria: [{ claim: "Preview is ready.", verification: "Visible text says Ready." }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "test", createdAt: `2026-09-12T12:0${version === "1.0.0" ? "1" : "0"}:00.000Z` },
    approval: { approvedAt: "2026-09-12T12:05:00.000Z", approvedBy: "user" },
    ...(status === "archived" ? { archivedAt: "2026-09-12T12:10:00.000Z" } : {})
  };
}
const approved = skill("1.0.0", "approved");
const archived = skill("0.9.0", "archived");
const fragileDraft = {
  schemaVersion: 1,
  id: "fragile-draft",
  version: "0.1.0",
  status: "draft",
  title: "Fragile draft",
  description: "A recorded draft with one target that still needs review.",
  inputs: {},
  allowedOrigins: [fixture.origin],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  budgets: { maxSteps: 6, maxMinutes: 5 },
  steps: [
    {
      id: "fragile-preview",
      kind: "click",
      purpose: "Preview using the recorded weak target.",
      origin: fixture.origin,
      target: { role: "button" },
      review: {
        stability: "fragile",
        unresolved: true,
        reason: "This recorded target has a weak semantic fingerprint. Review or remove this step before approving the skill."
      }
    },
    { id: "fragile-verify", kind: "verify", purpose: "Verify result.", origin: fixture.origin, expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "Preview is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", createdAt: "2026-09-12T12:20:00.000Z" }
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir, fixture.origin);

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
  await worker.evaluate(async (skills) => chrome.storage.local.set({ "browsercrew.skillLibrary.v1": skills }), [approved, archived, fragileDraft]);

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/form.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  const approvedCard = panel.locator('[data-skill-record="supplier-check@@1.0.0"]');
  const fragileCard = panel.locator('[data-skill-record="fragile-draft@@0.1.0"]');
  await approvedCard.waitFor({ state: "visible", timeout: timeoutMs });
  await fragileCard.waitFor({ state: "visible", timeout: timeoutMs });
  await approvedCard.getByRole("button", { name: "Versions" }).waitFor({ state: "visible", timeout: timeoutMs });
  await approvedCard.getByRole("button", { name: "Test / Run" }).waitFor({ state: "visible", timeout: timeoutMs });
  await fragileCard.getByRole("button", { name: "Test draft — no changes" }).waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await approvedCard.locator("[data-test-draft-skill]").count(), 0, "Approved versions must not expose the draft-only Test button.");
  assert.equal(await fragileCard.locator("[data-open-skill-run]").count(), 0, "Draft versions must never expose Run.");
  assert.equal(await panel.locator('[data-skill-status="archived"] [data-open-skill-run]').count(), 0, "Archived versions must not expose Run.");
  assert.equal(await panel.locator('[data-skill-status="archived"] [data-test-draft-skill]').count(), 0, "Archived versions must not expose draft Test.");
  pass("My Skills separates approved Test / Run from observation-only Draft Test, and exposes Run only on approved exact versions");

  await approvedCard.getByRole("button", { name: "Versions" }).click();
  await panel.locator("#skillVersionsPanel").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await panel.locator("#skillVersionsList [data-version-row]").count(), 2);
  assert.match(await panel.locator("#skillVersionsList").innerText(), /v1\.0\.0 · Approved/);
  assert.match(await panel.locator("#skillVersionsList").innerText(), /v0\.9\.0 · Archived/);
  await panel.getByRole("button", { name: "Create next draft version" }).click();
  await waitUntil(async () => (await storedSkills(worker)).some((item) => item.id === "supplier-check" && item.version === "1.0.1" && item.status === "draft"), "Next exact version should persist as a draft.");
  let skills = await storedSkills(worker);
  const next = skills.find((item) => item.id === "supplier-check" && item.version === "1.0.1");
  assert.equal(next.approval, undefined);
  assert.equal(next.archivedAt, undefined);
  assert.deepEqual(next.allowedOrigins, approved.allowedOrigins);
  assert.deepEqual(next.actionClasses, approved.actionClasses);
  assert.deepEqual(next.allowedResources, []);
  assert.deepEqual(next.providerRequirements, { capabilities: [] });
  assert.deepEqual(next.writePolicy, { approvalRequired: true, noBlindRetry: true });
  assert.deepEqual(next.verificationRules, { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true });
  assert.equal(next.createdAt, next.provenance.createdAt, "The new exact version must use its own creation timestamp.");
  assert.notEqual(next.createdAt, approved.provenance.createdAt, "The new exact version must not inherit the source version creation time.");
  assert.ok(Date.parse(next.updatedAt) >= Date.parse(next.createdAt));
  assert.deepEqual(next.compatibility, { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" });
  assert.deepEqual(next.provenance.sourceSkillRef, { id: approved.id, version: approved.version });
  const storedLegacyApproved = skills.find((item) => item.id === "supplier-check" && item.version === "1.0.0");
  assert.equal(Object.prototype.hasOwnProperty.call(storedLegacyApproved, "allowedResources"), false, "Reading a legacy approved version must not rewrite immutable stored history.");
  pass("Legacy v1 metadata is normalized in memory while every newly saved draft persists complete safe metadata with its own timestamp without rewriting approved history");

  const generatedDraftCard = panel.locator('[data-skill-record="supplier-check@@1.0.1"]');
  await generatedDraftCard.waitFor({ state: "visible", timeout: timeoutMs });
  await generatedDraftCard.getByRole("button", { name: "Test draft — no changes" }).waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await generatedDraftCard.locator("[data-open-skill-run]").count(), 0, "New draft versions must not expose Run before approval.");
  const draftLibraryBefore = await storedSkills(worker);
  const draftRunsBefore = await storedRuns(worker);
  const draftPermissionsBefore = await grantedPermissions(worker);
  assert.equal(draftRunsBefore.length, 0);
  assert.equal(await target.locator("#search").inputValue(), "");
  assert.equal(await target.locator("#ready").isVisible(), false);
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector('[data-skill-record="supplier-check@@1.0.1"] [data-test-draft-skill]')?.click());
  const draftPanel = panel.locator("#skillDraftTestPanel");
  await draftPanel.waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await draftPanel.innerText(), /DRAFT TEST · OBSERVATION ONLY/i);
  assert.match(await draftPanel.innerText(), /never asks Chrome for new site access/i);
  assert.equal(await draftPanel.getByRole("button", { name: /run/i }).count(), 0, "Draft Test panel must contain no Run control.");
  await draftPanel.locator('[data-draft-test-input="query"]').fill(RUN_VALUE);
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#skillDraftTestPanel [data-run-draft-test]")?.click());
  await waitUntil(async () => /Draft looks testable on this page/.test(await panel.locator("#skillDraftTestResult").innerText()), "Draft preflight should inspect the current page without running it.");
  assert.equal(await target.locator("#search").inputValue(), "", "Draft Test must not type the runtime input.");
  assert.equal(await target.locator("#ready").isVisible(), false, "Draft Test must not click Preview.");
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0", "Draft Test must not submit the form.");
  assert.deepEqual(await storedRuns(worker), draftRunsBefore, "Draft Test must not create a durable execution receipt.");
  assert.deepEqual(await storedSkills(worker), draftLibraryBefore, "Draft Test must not approve or mutate any stored Skill version.");
  assert.deepEqual(await grantedPermissions(worker), draftPermissionsBefore, "Draft Test must not grant new Chrome permission.");
  assert.equal((await storedSkills(worker)).find((item) => item.id === "supplier-check" && item.version === "1.0.1")?.status, "draft");
  pass("Draft Test re-observes a reviewable draft without clicking, typing, navigating, persisting authority, creating a run, or granting site access");
  await draftPanel.getByRole("button", { name: "Close" }).click();

  await panel.getByRole("button", { name: /^All versions/ }).click();
  await waitUntil(async () => await panel.locator('[data-skill-record="fragile-draft@@0.1.0"]').count() === 1, "Fragile draft should remain visible in All versions.");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector('[data-skill-record="fragile-draft@@0.1.0"] [data-test-draft-skill]')?.click());
  const fragilePanel = panel.locator("#skillDraftTestPanel");
  await fragilePanel.waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await fragilePanel.innerText(), /1 recorded target still needs review/i);
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#skillDraftTestPanel [data-run-draft-test]")?.click());
  await waitUntil(async () => /Review this draft first/.test(await panel.locator("#skillDraftTestResult").innerText()), "Unresolved draft Test should fail closed as review-needed.");
  assert.match(await panel.locator("#skillDraftTestResult").innerText(), /weak semantic fingerprint/i);
  assert.equal(await target.locator("#search").inputValue(), "");
  assert.equal(await target.locator("#ready").isVisible(), false);
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0");
  assert.equal((await storedRuns(worker)).length, 0);
  const fragileStored = (await storedSkills(worker)).find((item) => item.id === "fragile-draft");
  assert.equal(fragileStored.status, "draft");
  assert.equal(fragileStored.steps[0].review.unresolved, true);
  pass("Draft Test surfaces unresolved fragile targets as blocked review work instead of inspecting or executing them");
  await fragilePanel.getByRole("button", { name: "Close" }).click();

  await waitUntil(async () => await panel.locator('[data-skill-record="supplier-check@@1.0.0"]').count() === 1, "Approved version should remain in All versions.");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector('[data-skill-record="supplier-check@@1.0.0"] [data-open-skill-run]')?.click());
  await panel.locator("#skillRunPanel").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator('[data-skill-input="query"]').fill(RUN_VALUE);
  const scopeText = await panel.locator("#skillRunScope").innerText();
  assert.match(scopeText, /Exact version v1\.0\.0/);
  assert.match(scopeText, /page_write_prepare/);
  assert.match(scopeText, /Resources: none/);
  assert.match(scopeText, /Provider capabilities: none/);
  pass("Approved Test / Run review still shows the pinned version, websites, resources, actions, provider capabilities, data destinations, limits, and run-time inputs before authority exists");

  const beforeRuns = await storedRuns(worker);
  assert.equal(beforeRuns.length, 0);
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#skillTestButton")?.click());
  await waitUntil(async () => /Ready to run on this page/.test(await panel.locator("#skillTestResult").innerText()), "Read-only approved Test should report readiness.");
  assert.equal(await target.locator("#search").inputValue(), "", "Approved Test must not type the runtime input.");
  assert.equal(await target.locator("#ready").isVisible(), false, "Approved Test must not click Preview or create the result.");
  assert.equal((await storedRuns(worker)).length, 0, "Approved Test must not create an execution receipt.");
  pass("Approved Test continues to re-observe semantic controls on the current page without clicking, typing, navigating, or creating a run");

  await target.locator("#search").evaluate((el) => el.remove());
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#skillTestButton")?.click());
  await waitUntil(async () => /Review before running/.test(await panel.locator("#skillTestResult").innerText()), "Stale target Test should fail safely.");
  assert.match(await panel.locator("#skillTestResult").innerText(), /could not be found/i);
  assert.equal((await storedRuns(worker)).length, 0);
  pass("Approved Test detects a stale missing target and fails safely without dispatching any step");

  await target.reload();
  await target.bringToFront();
  panel.once("dialog", (dialog) => dialog.accept());
  await panel.evaluate(() => document.querySelector("#skillRunOnceButton")?.click());
  await waitUntil(async () => /Run completed and checked/.test(await panel.locator("#skillTestResult").innerText()), "Approved exact version should complete through the existing Skill runner.", 45_000);
  assert.equal(await target.locator("#search").inputValue(), RUN_VALUE);
  assert.equal(await target.locator("#ready").isVisible(), true);
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0", "Run must not submit the form.");
  const runs = await storedRuns(worker);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.deepEqual(runs[0].skillRef, { id: approved.id, version: approved.version });
  assert.equal(JSON.stringify(runs[0]).includes(RUN_VALUE), false, "Run-time input values must not enter durable history.");
  pass("Run remains approved-only, uses the exact approved version, existing revalidation runner, one-run review authority, and final verification without submitting");

  const allStorage = await worker.evaluate(async () => chrome.storage.local.get(null));
  const grantKeys = Object.keys(allStorage).filter((key) => /grant/i.test(key));
  assert.deepEqual(grantKeys, [], "The one-run Skill grant must not be persisted as reusable authority.");
  const permissions = await worker.evaluate(async () => chrome.permissions.getAll());
  assert.equal((permissions.permissions || []).includes("alarms"), false);
  pass("One-run authority is not persisted and the post-v0.2 scheduling permission remains unbooted");

  await panel.screenshot({ path: join(artifactDir, "skill-versions-test-run.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.skillRef = { id: approved.id, version: approved.version };
  report.runId = runs[0].id;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Skill Versions/Test/Run installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "skill-versions-test-run-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function storedSkills(worker) { return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []); }
async function storedRuns(worker) { return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillRuns.v1"))["browsercrew.skillRuns.v1"] || []); }
async function grantedPermissions(worker) {
  return worker.evaluate(async () => {
    const value = await chrome.permissions.getAll();
    return { origins: [...(value.origins || [])].sort(), permissions: [...(value.permissions || [])].sort() };
  });
}
function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }
async function prepareExtension(target, origin) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    const first = relative.split(/[/\\]/)[0];
    return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
  } });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
async function startFixtureServer() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Skill Run Fixture</title></head><body data-submits="0"><main><h1>Supplier lookup</h1><form id="form"><label for="search">Search</label><input id="search" name="search"><button id="preview" type="button">Preview</button><button id="save" type="submit">Save changes</button><p id="ready" hidden>Ready</p></form></main><script>document.querySelector('#preview').addEventListener('click',()=>{document.querySelector('#ready').hidden=false});document.querySelector('#form').addEventListener('submit',(event)=>{event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||'0')+1)})</script></body></html>`;
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}
async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
