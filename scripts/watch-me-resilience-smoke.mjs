import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "watch-me-resilience-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-watch-resilience-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
const HIDDEN_CANARY = "HIDDEN_API_TOKEN_CANARY_77";
const FILE_CANARY = "REPORT_FILE_CONTENT_CANARY_88";
let context;
const report = { schemaVersion: 1, kind: "browsercrew.watch_me_resilience_smoke", startedAt: new Date().toISOString(), checks: [] };
const fixture = await startFixtureServer();

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir, fixture.origin);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/form.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.locator("#watchMeStartButton").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#watchMeWaitText").waitFor({ state: "attached", timeout: timeoutMs });

  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStartButton")?.click());
  await panel.locator("#watchMeRunning").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => (await watchState(worker))?.session?.status === "watching", "Watch session should persist before resilience checks.");

  await target.locator("#beforeRestart").click();
  await waitUntil(async () => countClicks(await watchState(worker), "Before restart") === 1, "First semantic click should be recorded exactly once.");
  pass("Recorder captured a semantic click while ignoring a hostile synthetic hidden-field change");

  const restartedWorker = waitForNextWorker(context, extensionId);
  await terminateServiceWorker(context, panel, extensionId);
  worker = await restartedWorker;
  await target.locator("#afterRestart").click();
  await waitUntil(async () => countClicks(await watchState(worker), "After restart") === 1, "Recorder should reconnect after service-worker termination and deliver the next event once.", 45_000);
  const afterRestartState = await watchState(worker);
  assert.equal(countClicks(afterRestartState, "Before restart"), 1, "Restart recovery must not duplicate earlier events.");
  assert.equal(countClicks(afterRestartState, "After restart"), 1, "Restart recovery must not duplicate the resumed event.");
  pass("Recorder reconnected after an actual extension service-worker target termination without duplicating semantic events");

  await panel.locator("#watchMeWaitText").fill("Results loaded");
  await panel.locator("#watchMeMarkWaitButton").click();
  await waitUntil(async () => (await watchState(worker))?.session?.events?.some((event) => event.kind === "waitFor" && event.expect?.visibleText === "Results loaded"), "User-authored visible wait condition should persist.");
  pass("User explicitly added a bounded visible-text wait condition instead of trusting page-authored instructions");

  const downloadPromise = target.waitForEvent("download", { timeout: timeoutMs });
  await target.locator("#downloadReport").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "report.txt");
  await waitUntil(async () => (await watchState(worker))?.session?.events?.some((event) => event.kind === "download" && event.target?.label === "Download report"), "Explicit download anchor should become one semantic download event.");
  pass("Explicit user download was recorded as a declarative download step without reading the file contents");

  await panel.locator("#watchMeCompletionText").fill("Resilience complete");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStopButton")?.click());
  await panel.locator("#watchMeDraftResult").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => (await storedSkills(worker)).some((skill) => skill.provenance?.source === "watch_me_demonstration" && skill.status === "draft"), "Stopped resilient recording should save a draft.");

  const storage = await worker.evaluate(async () => chrome.storage.local.get(null));
  const durable = JSON.stringify(storage);
  assert.equal(durable.includes(HIDDEN_CANARY), false, "Hidden-field values must never enter durable Watch Me state.");
  assert.equal(durable.includes(FILE_CANARY), false, "Downloaded file contents must never enter durable Watch Me state.");
  assert.equal(/screenshot/i.test(Object.keys(storage).join(" ")), false, "Watch Me must not persist screenshots by default.");
  const drafts = await storedSkills(worker);
  const draft = drafts.find((skill) => skill.provenance?.source === "watch_me_demonstration" && skill.status === "draft");
  assert.ok(draft, "A resilient recording should remain an unapproved draft.");
  assert.equal(draft.approval, undefined);
  assert.equal(draft.steps.filter((step) => step.kind === "waitFor").length, 1);
  assert.equal(draft.steps.filter((step) => step.kind === "download").length, 1);
  assert.equal(draft.steps.at(-1)?.kind, "verify");
  assert.equal(draft.steps.at(-1)?.expect?.visibleText, "Resilience complete");
  assert.equal(draft.steps.some((step) => String(step.target?.type || "").toLowerCase() === "hidden"), false);
  assert.ok(draft.actionClasses.includes("download"), "Semantic download requires a reviewed download action class.");
  assert.deepEqual(draft.allowedResources, [], "Saved Watch Me drafts should use the complete Skill metadata contract.");
  assert.deepEqual(draft.providerRequirements, { capabilities: [] });
  assert.deepEqual(draft.writePolicy, { approvalRequired: true, noBlindRetry: true });
  assert.deepEqual(draft.verificationRules, { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true });
  assert.equal(draft.createdAt, draft.provenance.createdAt);
  assert.ok(Date.parse(draft.updatedAt) >= Date.parse(draft.createdAt));
  assert.deepEqual(draft.compatibility, { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" });
  pass("Recovered recording saved one metadata-complete unapproved draft with wait/download/final verification and no hidden/file-content leakage");

  const permissions = await worker.evaluate(async () => chrome.permissions.getAll());
  assert.equal((permissions.permissions || []).includes("alarms"), false, "Recorder resilience must not activate scheduling permissions.");
  await panel.screenshot({ path: join(artifactDir, "watch-me-resilience.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.draftRef = { id: draft.id, version: draft.version };
  report.eventCount = (await watchState(worker))?.session?.events?.length || 0;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Watch Me resilience installed-extension smoke checks passed.");
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

async function watchState(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.watchMe.v1"))["browsercrew.watchMe.v1"] || null);
}
async function storedSkills(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []);
}
function countClicks(state, label) {
  return state?.session?.events?.filter((event) => event.kind === "click" && event.target?.label === label).length || 0;
}
function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function waitForNextWorker(browserContext, extensionId) {
  return browserContext.waitForEvent("serviceworker", {
    predicate: (candidate) => {
      try { return new URL(candidate.url()).host === extensionId; } catch { return false; }
    },
    timeout: 45_000
  });
}

async function terminateServiceWorker(browserContext, page, extensionId) {
  const session = await browserContext.newCDPSession(page);
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find((item) => item.type === "service_worker" && item.url.startsWith(`chrome-extension://${extensionId}/`));
    assert.ok(target?.targetId, "Could not find the active BrowserCrew extension service-worker CDP target.");
    const result = await session.send("Target.closeTarget", { targetId: target.targetId });
    assert.equal(result?.success, true, "Chrome refused to terminate the extension service-worker target for the resilience proof.");
  } finally {
    await session.detach().catch(() => {});
  }
}

async function prepareExtension(target, origin) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Watch Resilience Fixture</title></head><body>
    <main>
      <h1>Recorder resilience</h1>
      <input id="hostileHidden" name="api_token" type="hidden" value="${HIDDEN_CANARY}">
      <button id="beforeRestart" type="button">Before restart</button>
      <button id="afterRestart" type="button">After restart</button>
      <p id="results">Results loaded</p>
      <a id="downloadReport" href="/report.txt" download="report.txt">Download report</a>
      <p id="complete">Resilience complete</p>
    </main>
    <script>
      document.querySelector('#beforeRestart').addEventListener('click', () => {
        document.querySelector('#hostileHidden').dispatchEvent(new Event('change', { bubbles: true }));
      });
    </script>
  </body></html>`;
  const server = createServer((req, res) => {
    if (req.url === "/report.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=report.txt" });
      res.end("${FILE_CANARY}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
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
