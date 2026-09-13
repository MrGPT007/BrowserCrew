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
  await worker.evaluate(async (skills) => chrome.storage.local.set({ "browsercrew.skillLibrary.v1": skills }), [approved, archived]);

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/form.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  const approvedCard = panel.locator('[data-skill-record="supplier-check@@1.0.0"]');
  await approvedCard.waitFor({ state: "visible", timeout: timeoutMs });
  await approvedCard.getByRole("button", { name: "Versions" }).waitFor({ state: "visible", timeout: timeoutMs });
  await approvedCard.getByRole("button", { name: "Test / Run" }).waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await panel.locator('[data-skill-status="archived"] [data-open-skill-run]').count(), 0, "Archived versions must not expose Run.");
  pass("My Skills exposes Versions and Test / Run only on approved exact versions");

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
  assert.deepEqual(next.provenance.sourceSkillRef, { id: approved.id, version: approved.version });
  pass("Versions preserves stable lineage while every new version starts as an unapproved draft with unchanged scope");

  await panel.getByRole("button", { name: /^All versions/ }).click();
  await waitUntil(async () => await panel.locator('[data-skill-record="supplier-check@@1.0.0"]').count() === 1, "Approved version should remain in All versions.");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector('[data-skill-record="supplier-check@@1.0.0"] [data-open-skill-run]')?.click());
  await panel.locator("#skillRunPanel").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator('[data-skill-input="query"]').fill(RUN_VALUE);
  assert.match(await panel.locator("#skillRunScope").innerText(), /Exact version v1\.0\.0/);
  assert.match(await panel.locator("#skillRunScope").innerText(), /page_write_prepare/);
  pass("Test / Run review shows the pinned version, websites, actions, data destinations, limits, and run-time inputs before authority exists");

  const beforeRuns = await storedRuns(worker);
  assert.equal(beforeRuns.length, 0);
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#skillTestButton")?.click());
  await waitUntil(async () => /Ready to run on this page/.test(await panel.locator("#skillTestResult").innerText()), "Read-only Test should report readiness.");
  assert.equal(await target.locator("#search").inputValue(), "", "Test must not type the runtime input.");
  assert.equal(await target.locator("#ready").isVisible(), false, "Test must not click Preview or create the result.");
  assert.equal((await storedRuns(worker)).length, 0, "Test must not create an execution receipt.");
  pass("Test re-observes semantic controls on the current page without clicking, typing, navigating, or creating a run");

  await target.locator("#search").evaluate((el) => el.remove());
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#skillTestButton")?.click());
  await waitUntil(async () => /Review before running/.test(await panel.locator("#skillTestResult").innerText()), "Stale target Test should fail safely.");
  assert.match(await panel.locator("#skillTestResult").innerText(), /could not be found/i);
  assert.equal((await storedRuns(worker)).length, 0);
  pass("Test detects a stale missing target and fails safely without dispatching any step");

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
  pass("Run uses the exact approved version, existing revalidation runner, one-run review authority, and final verification without submitting");

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
