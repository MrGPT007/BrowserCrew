import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "watch-me-scope-review-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-watch-scope-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const report = { schemaVersion: 1, kind: "browsercrew.watch_me_scope_review_smoke", startedAt: new Date().toISOString(), checks: [] };
const timeoutMs = 30_000;
let context;
const fixtureA = await startFixtureServer("start");
const fixtureB = await startFixtureServer("work");

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareTestExtension(extensionDir, [fixtureA.origin, fixtureB.origin]);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;

  const target = await context.newPage();
  await target.goto(`${fixtureA.origin}/start`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.locator("#watchMeStartButton").waitFor({ state: "visible", timeout: timeoutMs });

  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStartButton")?.click());
  await waitForText(panel.locator("#watchMeBadge"), "Watching");
  pass("Watch Me starts on the first explicitly selected site");

  const beforeCrossSite = await readWatchState(worker);
  const initialEventCount = beforeCrossSite.session.events.length;
  assert.deepEqual(beforeCrossSite.session.approvedOrigins, [fixtureA.origin]);

  await target.goto(`${fixtureB.origin}/work`);
  await waitForText(panel.locator("#watchMeBadge"), "Site changed");
  await panel.locator("#watchMeApproveScopeButton").waitFor({ state: "visible", timeout: timeoutMs });
  const reviewText = await panel.locator("#watchMeScopeReview").innerText();
  assert.ok(reviewText.includes(fixtureB.origin));
  assert.match(reviewText, /Nothing on this website is recorded until you approve it/i);
  pass("Cross-origin navigation pauses visibly for exact-site review even when Chrome already has host access");

  await target.locator("#preview").click();
  await target.locator("#ready").waitFor({ state: "visible", timeout: timeoutMs });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const beforeApproval = await readWatchState(worker);
  assert.equal(beforeApproval.session.status, "scope_review");
  assert.equal(beforeApproval.session.events.length, initialEventCount, "No event on the new origin may be recorded before Watch Me scope approval.");
  assert.deepEqual(beforeApproval.session.approvedOrigins, [fixtureA.origin]);
  pass("Actions performed on the new site before approval create zero recorded steps");

  panel.once("dialog", (dialog) => dialog.accept());
  await panel.locator("#watchMeApproveScopeButton").click();
  await waitForText(panel.locator("#watchMeBadge"), "Watching");
  const afterApproval = await readWatchState(worker);
  assert.equal(afterApproval.session.status, "watching");
  assert.deepEqual(afterApproval.session.approvedOrigins, [fixtureA.origin, fixtureB.origin]);
  const navigate = afterApproval.session.events.find((event) => event.kind === "navigate" && event.origin === fixtureB.origin);
  assert.ok(navigate, "Explicit scope approval should journal the exact cross-origin navigation semantically.");
  assert.equal(navigate.pageUrl, `${fixtureB.origin}/work`);
  pass("User explicitly approved the exact second origin and Watch Me resumed with a semantic navigation step");

  await target.locator("#ready").evaluate((el) => { el.hidden = true; });
  await target.locator("#preview").click();
  await target.locator("#ready").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => (await readWatchState(worker)).session.events.some((event) => event.kind === "click" && event.origin === fixtureB.origin), "Approved second-site click should be recorded.");
  pass("After approval, semantic actions on the second origin are recorded normally");

  await panel.locator("#watchMeCompletionText").fill("Cross-site ready");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStopButton")?.click());
  await waitForText(panel.locator("#watchMeDraftResult"), "Draft ready for review");
  const libraryBeforeApproval = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []);
  const draft = libraryBeforeApproval.find((item) => item.provenance?.source === "watch_me_demonstration");
  assert.ok(draft, "Scope-reviewed recording should save a draft Skill.");
  assert.equal(draft.status, "draft");
  assert.deepEqual(draft.allowedOrigins, [fixtureA.origin, fixtureB.origin]);
  assert.ok(draft.steps.some((step) => step.kind === "navigate" && step.origin === fixtureB.origin));
  assert.ok(draft.steps.some((step) => step.kind === "click" && step.origin === fixtureB.origin));
  assert.equal(draft.steps.at(-1)?.kind, "verify");
  assert.equal(draft.steps.at(-1)?.origin, fixtureB.origin);
  pass("Draft preserves both explicitly reviewed origins and verifies completion on the current approved site");

  const approveButton = panel.locator(`#versionedSkillList [data-approve-skill="${draft.id}"][data-skill-version="${draft.version}"]`);
  panel.once("dialog", (dialog) => dialog.accept());
  await approveButton.click();
  await waitUntil(async () => {
    const items = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []);
    return items.some((item) => item.id === draft.id && item.version === draft.version && item.status === "approved");
  }, "Recorded cross-site draft should require and accept exact-version approval.");
  const approved = (await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || [])).find((item) => item.id === draft.id && item.version === draft.version);
  pass("Cross-site recording remains a draft until the user explicitly approves that exact version");

  await target.goto(`${fixtureA.origin}/start`);
  await target.bringToFront();
  const selected = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }));
  assert.equal(selected?.ok, true);
  assert.equal(new URL(selected.tab.url).origin, fixtureA.origin);
  const grant = {
    origins: [fixtureA.origin, fixtureB.origin],
    actionClasses: ["read", "page_write_prepare"],
    dataDestinations: [],
    revoked: false,
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
  const replay = await runSkill(panel, { skillId: approved.id, version: approved.version, tabId: selected.tab.id, grant });
  assert.equal(replay.ok, true, replay.error?.message || "Approved cross-site Skill should replay successfully.");
  await target.waitForURL(`${fixtureB.origin}/work`, { timeout: timeoutMs });
  await target.locator("#ready").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal((await target.locator("#ready").innerText()).trim(), "Cross-site ready");
  pass("Replay may cross only between the two reviewed origins and reaches the saved verified outcome");

  const runs = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillRuns.v1"))["browsercrew.skillRuns.v1"] || []);
  const run = runs.find((item) => item.id === replay.run?.id);
  assert.equal(run?.status, "completed");
  assert.equal(run?.receipt?.status, "completed");
  assert.deepEqual(run?.receipt?.skillRef, { id: approved.id, version: approved.version });
  pass("Cross-site replay produces a durable exact-version completed run receipt");

  await panel.screenshot({ path: join(artifactDir, "watch-me-scope-review.png"), fullPage: true });
  report.skill = { id: approved.id, version: approved.version, allowedOrigins: approved.allowedOrigins, stepCount: approved.steps.length };
  report.replay = { runId: replay.run?.id, status: replay.run?.status };
  report.ok = true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Watch Me explicit cross-site scope review smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.ok = false;
  report.completedAt = new Date().toISOString();
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixtureA.close();
  await fixtureB.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function readWatchState(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.watchMe.v1"))["browsercrew.watchMe.v1"]);
}

function runSkill(panel, { skillId, version, tabId, grant }) {
  return panel.evaluate(async ({ skillId, version, tabId, grant }) => {
    const port = chrome.runtime.connect({ name: "browsercrew-skills" });
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("Cross-site replay timed out.")); }, 20_000);
      port.onMessage.addListener((message) => {
        if (message?.requestId !== requestId) return;
        clearTimeout(timeout);
        try { port.disconnect(); } catch {}
        resolve(message);
      });
      port.postMessage({ type: "run", requestId, skillId, version, tabId, inputValues: {}, grant });
    });
  }, { skillId, version, tabId, grant });
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(relative.split(/[/\\]/)[0]);
  } });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function startFixtureServer(kind) {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (kind === "work") {
        res.end(`<!doctype html><html><body><h1>Second site</h1><button id="preview" type="button">Preview cross-site result</button><p id="ready" hidden>Cross-site ready</p><script>document.querySelector('#preview').addEventListener('click',()=>{document.querySelector('#ready').hidden=false;});</script></body></html>`);
      } else {
        res.end(`<!doctype html><html><body><h1>First site</h1><p>Start the recorded workflow here.</p></body></html>`);
      }
    });
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) });
    });
  });
}

async function waitForText(locator, expected) {
  await waitUntil(async () => (await locator.innerText()).includes(expected), `Expected text ${expected}`);
}

async function waitUntil(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
