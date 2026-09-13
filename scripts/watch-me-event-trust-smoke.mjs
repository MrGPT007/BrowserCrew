import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "watch-me-resilience-smoke", "event-trust");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-watch-event-trust-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
const SYNTHETIC_VALUE = "PAGE_SCRIPT_CANARY_91";
let context;
const report = { schemaVersion: 1, kind: "browsercrew.watch_me_event_trust_smoke", startedAt: new Date().toISOString(), checks: [] };
const fixture = await startFixtureServer();

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

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/trust.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.locator("#watchMeStartButton").waitFor({ state: "visible", timeout: timeoutMs });

  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStartButton")?.click());
  await panel.locator("#watchMeRunning").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => (await watchState(worker))?.session?.status === "watching", "Watch session should be active before trust-boundary checks.");
  const baseline = (await watchState(worker))?.session?.events?.length || 0;

  await target.evaluate((syntheticValue) => {
    document.querySelector("#syntheticAction")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const field = document.querySelector("#syntheticField");
    if (field) {
      field.value = syntheticValue;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, SYNTHETIC_VALUE);
  await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  const afterSynthetic = await watchState(worker);
  assert.equal(afterSynthetic?.session?.events?.length || 0, baseline, "Page-authored synthetic click/change events must not enter the Watch Me session.");
  assert.equal(JSON.stringify(afterSynthetic).includes(SYNTHETIC_VALUE), false, "Synthetic page-authored values must never enter durable Watch Me state.");
  pass("Recorder rejected page-script synthetic visible click/change events before they reached durable recording state");

  await target.locator("#trustedAction").click();
  await target.locator("#trustedField").click();
  await target.locator("#trustedField").pressSequentially("user-entered-value");
  await target.locator("#trustedField").press("Tab");
  await waitUntil(async () => {
    const state = await watchState(worker);
    const events = state?.session?.events || [];
    return events.some((event) => event.kind === "click" && event.target?.label === "Trusted action")
      && events.some((event) => event.kind === "type" && event.target?.label === "Trusted field");
  }, "Trusted user click and keyboard change should still be recorded.");
  pass("Recorder continued to capture trusted user interactions after rejecting synthetic page events");

  await panel.locator("#watchMeCompletionText").fill("Trust test complete");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStopButton")?.click());
  await panel.locator("#watchMeDraftResult").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => (await storedSkills(worker)).some((skill) => skill.provenance?.source === "watch_me_demonstration" && skill.status === "draft"), "Trust-boundary recording should save an unapproved draft.");

  const storage = await worker.evaluate(async () => chrome.storage.local.get(null));
  const durable = JSON.stringify(storage);
  assert.equal(durable.includes("Synthetic action"), false, "Synthetic click target must not enter durable draft/history.");
  assert.equal(durable.includes("Synthetic field"), false, "Synthetic changed field must not enter durable draft/history.");
  assert.equal(durable.includes(SYNTHETIC_VALUE), false, "Synthetic page-authored value must not enter durable draft/history.");
  const draft = (await storedSkills(worker)).find((skill) => skill.provenance?.source === "watch_me_demonstration" && skill.status === "draft");
  assert.ok(draft);
  assert.equal(draft.approval, undefined);
  assert.equal(draft.steps.some((step) => step.kind === "click" && step.target?.label === "Trusted action"), true);
  assert.equal(draft.steps.some((step) => step.kind === "type" && step.target?.label === "Trusted field"), true);
  assert.equal(draft.steps.some((step) => /Synthetic/.test(String(step.target?.label || ""))), false);
  assert.equal(draft.steps.at(-1)?.kind, "verify");
  assert.equal(draft.steps.at(-1)?.expect?.visibleText, "Trust test complete");
  pass("Saved draft contains only trusted demonstrated actions plus the user-authored final verification");

  const permissions = await worker.evaluate(async () => chrome.permissions.getAll());
  assert.equal((permissions.permissions || []).includes("alarms"), false);
  await panel.screenshot({ path: join(artifactDir, "watch-me-event-trust.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.draftRef = { id: draft.id, version: draft.version };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Watch Me event-trust installed-extension smoke checks passed.");
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Watch Event Trust</title></head><body><main><h1>Event trust boundary</h1><button id="syntheticAction" type="button">Synthetic action</button><label for="syntheticField">Synthetic field</label><input id="syntheticField" name="syntheticField"><button id="trustedAction" type="button">Trusted action</button><label for="trustedField">Trusted field</label><input id="trustedField" name="trustedField"><p>Trust test complete</p></main></body></html>`;
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
