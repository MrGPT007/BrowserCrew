import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-run-ui-smoke", "completion-checks");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-completion-check-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
const fixture = await startFixtureServer();
const COMPLETION_TEXT = "Extra completion marker";
const RUN_VALUE = "completion-check-query";
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_completion_check_smoke", startedAt: new Date().toISOString(), checks: [] };

const draft = {
  schemaVersion: 1,
  id: "completion-check-draft",
  version: "0.1.0",
  status: "draft",
  title: "Completion check draft",
  description: "Prepare a preview and require every reviewed success check before reporting completion.",
  inputs: { query: { type: "string", required: true, secret: false, label: "Search query" } },
  allowedOrigins: [fixture.origin],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  budgets: { maxSteps: 10, maxMinutes: 5 },
  steps: [
    { id: "step-type", kind: "type", purpose: "Enter the run-time query.", origin: fixture.origin, target: { role: "textbox", label: "Search" }, value: "{{input.query}}" },
    { id: "step-preview", kind: "click", purpose: "Preview without submitting.", origin: fixture.origin, target: { role: "button", label: "Preview" } },
    { id: "step-final", kind: "verify", purpose: "Verify the original final result.", origin: fixture.origin, expect: { visibleText: "Ready" } }
  ],
  completionCriteria: [{ claim: "Preview is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", createdAt: "2026-09-13T03:00:00.000Z" }
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir, fixture.origin);
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;
  await worker.evaluate(async (seed) => chrome.storage.local.set({ "browsercrew.skillLibrary.v1": [seed] }), draft);

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/form.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  const card = panel.locator('[data-skill-record="completion-check-draft@@0.1.0"]');
  await card.waitFor({ state: "visible", timeout: timeoutMs });
  const permissionsBefore = await grantedPermissions(worker);

  await card.getByRole("button", { name: "Success checks" }).click();
  const checksPanel = panel.locator("#skillCompletionChecksPanel");
  await checksPanel.waitFor({ state: "visible", timeout: timeoutMs });
  const panelText = await checksPanel.innerText();
  assert.match(panelText, /Original final check · locked/i);
  assert.match(panelText, /Visible text: “Ready”/i);
  assert.match(panelText, /cannot replace the original final result check/i);
  assert.match(panelText, /Do not put names, emails, account numbers, passwords, tokens, or other private values/i);
  pass("Draft review exposes bounded success checks while keeping the original final verification visibly locked");

  await checksPanel.locator("[data-completion-check-text]").first().fill(COMPLETION_TEXT);
  await checksPanel.getByRole("button", { name: "Save success checks" }).click();
  await waitUntil(async () => /Success checks saved/i.test(await panel.locator("#toast").innerText()), "Success check should save.");
  const saved = (await storedSkills(worker)).find((item) => item.id === draft.id);
  assert.equal(saved.status, "draft");
  assert.equal(saved.approval, undefined);
  assert.equal(saved.steps.length, 4);
  assert.equal(saved.steps.at(-1).id, "step-final");
  assert.deepEqual(saved.steps.at(-1).expect, { visibleText: "Ready" });
  const added = saved.steps.at(-2);
  assert.equal(added.kind, "verify");
  assert.equal(added.expect.visibleText, COMPLETION_TEXT);
  assert.equal(added.draftReviewCompletion, "draft_review_visible_text");
  assert.equal(saved.completionCriteria.some((item) => item.draftReviewCompletion === "draft_review_visible_text"), true);
  assert.deepEqual(await grantedPermissions(worker), permissionsBefore);
  assert.equal((await storedRuns(worker)).length, 0);
  pass("Saving inserts a real verify step before the locked final check while preserving draft status and zero run authority");

  await waitUntil(async () => await panel.locator('[data-skill-record="completion-check-draft@@0.1.0"]').count() === 1, "Draft card should remain visible.");
  panel.once("dialog", (dialog) => dialog.accept());
  await panel.locator('[data-skill-record="completion-check-draft@@0.1.0"]').getByRole("button", { name: "Approve this version" }).click();
  await waitUntil(async () => (await storedSkills(worker)).find((item) => item.id === draft.id)?.status === "approved", "Separate approval should persist.");
  const approved = (await storedSkills(worker)).find((item) => item.id === draft.id);
  assert.ok(approved.approval?.approvedAt);
  assert.equal(approved.steps.at(-2).expect.visibleText, COMPLETION_TEXT);
  pass("Saving success checks never self-approves; exact-version approval remains a separate user action");

  await target.bringToFront();
  const active = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }));
  assert.equal(active?.ok, true);
  assert.equal(new URL(active.tab.url).origin, fixture.origin);
  const grant = {
    origins: [fixture.origin], resources: [], actionClasses: ["read", "page_write_prepare"],
    providerCapabilities: [], dataDestinations: [], revoked: false, expiresAt: "2099-01-01T00:00:00.000Z"
  };
  const request = { skillId: approved.id, version: approved.version, tabId: active.tab.id, inputValues: { query: RUN_VALUE }, grant };
  const failed = await runSkill(panel, request);
  assert.equal(failed.ok, false, "Run must fail while the user-added visible completion check is absent.");
  assert.equal(failed.error?.code, "SKILL_VERIFY_FAILED");
  assert.equal(await target.locator("#ready").isVisible(), true);
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0");
  const failedAdded = failed.run?.receipt?.steps?.find((step) => step.id === added.id);
  assert.equal(failedAdded?.kind, "verify");
  assert.equal(failedAdded?.status, "failed");
  pass("Approved execution enforces the added visible-text check and fails safely when it is absent");

  await target.evaluate((text) => {
    const marker = document.createElement("p");
    marker.id = "extra-completion-marker";
    marker.textContent = text;
    document.querySelector("main")?.append(marker);
  }, COMPLETION_TEXT);
  const completed = await runSkill(panel, request);
  assert.equal(completed.ok, true, completed.error?.message || "All completion checks should pass.");
  assert.equal(completed.run?.status, "completed");
  assert.equal(completed.run?.receipt?.steps?.find((step) => step.id === added.id)?.status, "completed");
  assert.equal(completed.run?.receipt?.steps?.at(-1)?.id, "step-final");
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0");
  const runs = await storedRuns(worker);
  assert.equal(runs.length, 2);
  assert.equal(runs.some((item) => item.status === "failed"), true);
  assert.equal(runs.some((item) => item.status === "completed"), true);
  pass("The same approved version completes only after the added success check and original final verification both pass");

  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false);
  await panel.screenshot({ path: join(artifactDir, "completion-checks.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.skillRef = { id: approved.id, version: approved.version };
  report.failedRunId = failed.run?.id || null;
  report.completedRunId = completed.run?.id || null;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew bounded draft success-check installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function runSkill(panel, payload) {
  return panel.evaluate(async (request) => {
    const port = chrome.runtime.connect({ name: "browsercrew-skills" });
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("Skill run timed out.")); }, 20_000);
      port.onMessage.addListener((message) => {
        if (message?.requestId !== requestId) return;
        clearTimeout(timer);
        try { port.disconnect(); } catch {}
        resolve(message);
      });
      port.postMessage({ type: "run", requestId, ...request });
    });
  }, payload);
}
async function storedSkills(worker) { return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []); }
async function storedRuns(worker) { return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillRuns.v1"))["browsercrew.skillRuns.v1"] || []); }
async function grantedPermissions(worker) { return worker.evaluate(async () => { const value = await chrome.permissions.getAll(); return { origins: [...(value.origins || [])].sort(), permissions: [...(value.permissions || [])].sort() }; }); }
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Completion Check Fixture</title></head><body data-submits="0"><main><h1>Supplier lookup</h1><form id="form"><label for="search">Search</label><input id="search" name="search"><button id="preview" type="button">Preview</button><button id="save" type="submit">Save changes</button><p id="ready" hidden>Ready</p></form></main><script>document.querySelector('#preview').addEventListener('click',()=>{document.querySelector('#ready').hidden=false});document.querySelector('#form').addEventListener('submit',(event)=>{event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||'0')+1)})</script></body></html>`;
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
