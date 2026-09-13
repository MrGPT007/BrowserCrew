import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-run-ui-smoke", "replay-resilience");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-replay-resilience-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
const fixture = await startFixtureServer();
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_replay_resilience_smoke", startedAt: new Date().toISOString(), checks: [] };

const approved = {
  schemaVersion: 1,
  id: "replay-resilience",
  version: "1.0.0",
  status: "approved",
  title: "Replay resilience",
  description: "Prepare once, wait for a signal, then finish only if the same run remains live.",
  inputs: {},
  allowedOrigins: [fixture.origin],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  budgets: { maxSteps: 8, maxMinutes: 5 },
  steps: [
    { id: "step-prepare", kind: "click", purpose: "Prepare once.", origin: fixture.origin, target: { role: "button", label: "Prepare" } },
    { id: "step-wait", kind: "waitFor", purpose: "Wait for the continuation signal.", origin: fixture.origin, timeoutMs: 30_000, expect: { visibleText: "Continue signal" } },
    { id: "step-finish", kind: "click", purpose: "Finish after the wait.", origin: fixture.origin, target: { role: "button", label: "Finish preview" } },
    { id: "step-verify", kind: "verify", purpose: "Verify the finished state.", origin: fixture.origin, expect: { visibleText: "Done" } }
  ],
  completionCriteria: [{ claim: "The replay finished.", verification: "Visible text says Done." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: "2026-09-13T04:00:00.000Z" },
  approval: { approvedAt: "2026-09-13T04:01:00.000Z", approvedBy: "user" }
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir, fixture.origin);
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;
  await worker.evaluate(async (skill) => chrome.storage.local.set({ "browsercrew.skillLibrary.v1": [skill] }), approved);

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/run.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await target.bringToFront();
  const active = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }));
  assert.equal(active?.ok, true);
  assert.equal(new URL(active.tab.url).origin, fixture.origin);

  const grant = { origins: [fixture.origin], actionClasses: ["read", "page_write_prepare"], dataDestinations: [], revoked: false, expiresAt: "2099-01-01T00:00:00.000Z" };
  await panel.evaluate((request) => {
    const port = chrome.runtime.connect({ name: "browsercrew-skills" });
    window.__browsercrewReplayPort = port;
    window.__browsercrewReplayMessages = [];
    port.onMessage.addListener((message) => window.__browsercrewReplayMessages.push(message));
    port.postMessage({ type: "run", requestId: crypto.randomUUID(), ...request });
  }, { skillId: approved.id, version: approved.version, tabId: active.tab.id, inputValues: {}, grant });

  await waitUntil(async () => await target.locator("body").getAttribute("data-prepare-writes") === "1", "First reviewed click should execute exactly once before suspension.");
  await waitUntil(async () => {
    const runs = await storedRuns(worker);
    const run = runs.find((item) => item.skillRef?.id === approved.id);
    return run?.status === "running" && run.events?.some((event) => event.type === "skill.step.complete" && event.stepId === "step-prepare") && run.events?.some((event) => event.type === "skill.step.intent" && event.step?.id === "step-wait");
  }, "Durable run should show completed first click and pending wait intent before suspension.");
  assert.equal(await target.locator("body").getAttribute("data-finish-writes"), "0");
  pass("Replay durably journals the completed write before entering a pending wait step");

  const closedTargetId = await terminateServiceWorker(context, target, extensionId);
  report.closedServiceWorkerTargetId = closedTargetId;
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" })).catch(() => null);
  worker = await waitForLiveWorker(context, extensionId);
  await waitUntil(async () => {
    const run = (await storedRuns(worker)).find((item) => item.skillRef?.id === approved.id);
    return run?.status === "paused" && run.error?.code === "SKILL_WORKER_RESTARTED";
  }, "Interrupted Skill run should become durably paused after worker restart.");

  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  assert.equal(await target.locator("body").getAttribute("data-prepare-writes"), "1", "Worker restart must not replay the already completed write.");
  assert.equal(await target.locator("body").getAttribute("data-finish-writes"), "0", "Worker restart must not continue to later write steps automatically.");
  assert.equal(await target.locator("#done").isVisible(), false);
  const paused = (await storedRuns(worker)).find((item) => item.skillRef?.id === approved.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.error.code, "SKILL_WORKER_RESTARTED");
  assert.equal(paused.events.filter((event) => event.type === "skill.step.intent" && event.step?.id === "step-prepare").length, 1);
  assert.equal(paused.events.filter((event) => event.type === "skill.step.complete" && event.stepId === "step-prepare").length, 1);
  assert.equal(paused.events.some((event) => event.type === "skill.step.intent" && event.step?.id === "step-finish"), false);
  pass("MV3 restart pauses the exact durable replay without duplicate writes or automatic continuation");

  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false);
  await panel.screenshot({ path: join(artifactDir, "replay-resilience.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.runId = paused.id;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Skill replay service-worker resilience smoke checks passed.");
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

async function storedRuns(worker) { return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillRuns.v1"))["browsercrew.skillRuns.v1"] || []); }
function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function waitForLiveWorker(browserContext, extensionId, timeout = timeoutMs) {
  let liveWorker = null;
  await waitUntil(async () => {
    for (const candidate of browserContext.serviceWorkers()) {
      let same = false;
      try { same = new URL(candidate.url()).host === extensionId; } catch {}
      if (!same) continue;
      try { await candidate.evaluate(() => true); liveWorker = candidate; return true; } catch {}
    }
    return false;
  }, "BrowserCrew service worker should become live again after restart.", timeout);
  return liveWorker;
}

async function terminateServiceWorker(browserContext, page, extensionId) {
  const session = await browserContext.newCDPSession(page);
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find((item) => item.type === "service_worker" && item.url.startsWith(`chrome-extension://${extensionId}/`));
    assert.ok(target?.targetId, "Could not find the active BrowserCrew extension service-worker CDP target.");
    const result = await session.send("Target.closeTarget", { targetId: target.targetId });
    assert.equal(result?.success, true);
    await waitUntil(async () => {
      const after = await session.send("Target.getTargets");
      return !after.targetInfos.some((item) => item.targetId === target.targetId);
    }, "Closed BrowserCrew service-worker target should disappear before recovery is tested.", 10_000);
    return target.targetId;
  } finally { await session.detach().catch(() => {}); }
}

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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Replay Resilience</title></head><body data-prepare-writes="0" data-finish-writes="0"><main><h1>Replay resilience</h1><button id="prepare" type="button">Prepare</button><button id="finish" type="button">Finish preview</button><p id="done" hidden>Done</p></main><script>document.querySelector('#prepare').addEventListener('click',()=>{document.body.dataset.prepareWrites=String(Number(document.body.dataset.prepareWrites||'0')+1)});document.querySelector('#finish').addEventListener('click',()=>{document.body.dataset.finishWrites=String(Number(document.body.dataset.finishWrites||'0')+1);document.querySelector('#done').hidden=false})</script></body></html>`;
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
