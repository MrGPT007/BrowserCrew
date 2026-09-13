import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-dispatch-runtime-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-dispatch-runtime-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const report = { schemaVersion: 1, kind: "browsercrew.schedule_dispatch_runtime_smoke", startedAt: new Date().toISOString(), checks: [] };
const timeoutMs = 20_000;
let context;
const fixture = await startFixtureServer();

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareTestExtension(extensionDir, fixture.origin);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const target = await context.newPage();
  const reviewedUrl = `${fixture.origin}/orders`;
  await target.goto(reviewedUrl);

  const prepared = await panel.evaluate(async ({ origin, reviewedUrl }) => {
    const preparedMod = await import(chrome.runtime.getURL("src/schedule-prepared-metadata.js"));
    const grantMod = await import(chrome.runtime.getURL("src/schedule-grants-contract.js"));
    const createdMs = Date.now() - 60_000;
    const now = new Date(createdMs).toISOString();
    const expiresAt = new Date(createdMs + 7 * 24 * 60 * 60_000).toISOString();
    const when = Date.now() + 24 * 60 * 60_000;
    const skill = {
      schemaVersion: 1,
      id: "composition-skill",
      version: "1.0.0",
      status: "approved",
      title: "Composition proof",
      description: "Proof that production schedule resolvers compose without activating scheduling.",
      inputs: {},
      allowedOrigins: [origin],
      allowedResources: [],
      actionClasses: ["read"],
      dataDestinations: [],
      providerRequirements: { capabilities: [] },
      budgets: { maxSteps: 2, maxMinutes: 5 },
      steps: [{ id: "step-01", kind: "verify", purpose: "Verify the fixture page.", origin, expect: { visibleText: "Resolver Composition Ready" } }],
      completionCriteria: [{ claim: "The fixture is ready.", verification: "Require Resolver Composition Ready to be visible." }],
      recovery: { retryWrites: false, reconcileUnknownWrites: true },
      provenance: { source: "schedule_dispatch_runtime_smoke", createdAt: now },
      writePolicy: { approvalRequired: true, noBlindRetry: true },
      verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
      createdAt: now,
      updatedAt: now,
      compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
    };
    const metadata = preparedMod.createPreparedScheduleMetadata({ skill, pageUrl: reviewedUrl, reviewedAt: now });
    let schedule = {
      schemaVersion: 1,
      id: "composition-schedule",
      name: "Composition schedule",
      enabled: false,
      skillRef: { id: skill.id, version: skill.version },
      providerRef: "composition-provider",
      recurrence: { kind: "once", when },
      timezone: "UTC",
      missedRunPolicy: "skip",
      concurrencyPolicy: "skip_if_running",
      budgets: { maxSteps: 2, maxMinutes: 5 },
      grantRefs: [],
      startResource: metadata.startResource,
      authorityPlan: metadata.authorityPlan,
      createdAt: now,
      updatedAt: now,
      nextRunAt: null
    };
    const grant = grantMod.createScheduleGrant({
      id: "schedule-grant:composition",
      schedule,
      skill,
      createdAt: now,
      expiresAt
    });
    schedule = { ...schedule, grantRefs: [grant.id] };
    await chrome.storage.local.set({
      "browsercrew.connections.v1": [{
        id: "composition-provider",
        schemaVersion: 1,
        name: "Composition provider",
        kind: "openai",
        model: "composition-model",
        baseUrl: "https://api.example.test/v1",
        status: "connected",
        capabilities: [],
        lastTestedAt: now,
        createdAt: now,
        updatedAt: now
      }],
      "browsercrew.scheduleGrants.v1": [grant]
    });
    return { skill, schedule, grantId: grant.id };
  }, { origin: fixture.origin, reviewedUrl });

  const ready = await panel.evaluate(async ({ schedule, skill }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-dispatch-runtime.js"));
    return mod.inspectProductionScheduleReadiness({ schedule, skill });
  }, prepared);
  assert.equal(ready.ready, true);
  assert.equal(ready.grantsValid, true);
  assert.equal(ready.providerAvailable, true);
  assert.equal(ready.resourceFresh, true);
  assert.equal(ready.resource.url, reviewedUrl);
  pass("Production composition resolves the exact provider, active durable grant, and exact reviewed page without scheduler boot");

  const preflight = await panel.evaluate(async ({ schedule, skill }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-dispatch-runtime.js"));
    const dispatch = mod.createProductionScheduleSkillDispatcher();
    return dispatch({ mode: "preflight", schedule, skill });
  }, prepared);
  assert.deepEqual(preflight, { grantsValid: true, providerAvailable: true, resourceFresh: true, blockers: [] });
  pass("Composed dispatcher preflight is ready while remaining non-executing");

  await panel.evaluate(async () => {
    const data = await chrome.storage.local.get("browsercrew.connections.v1");
    const connections = data["browsercrew.connections.v1"] || [];
    connections[0] = { ...connections[0], status: "failed", updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ "browsercrew.connections.v1": connections });
  });
  const providerBlocked = await panel.evaluate(async ({ schedule, skill }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-dispatch-runtime.js"));
    return mod.inspectProductionScheduleReadiness({ schedule, skill });
  }, prepared);
  assert.equal(providerBlocked.ready, false);
  assert.equal(providerBlocked.providerAvailable, false);
  assert.ok(providerBlocked.blockers.some((item) => item.code === "SCHEDULE_PROVIDER_UNAVAILABLE"));
  pass("Composition fails closed when the exact named provider is no longer connected");

  await panel.evaluate(async () => {
    const data = await chrome.storage.local.get("browsercrew.connections.v1");
    const connections = data["browsercrew.connections.v1"] || [];
    connections[0] = { ...connections[0], status: "connected", updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ "browsercrew.connections.v1": connections });
  });
  await target.close();
  const resourceBlocked = await panel.evaluate(async ({ schedule, skill }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-dispatch-runtime.js"));
    return mod.inspectProductionScheduleReadiness({ schedule, skill });
  }, prepared);
  assert.equal(resourceBlocked.ready, false);
  assert.equal(resourceBlocked.resourceFresh, false);
  assert.ok(resourceBlocked.blockers.some((item) => item.code === "SCHEDULE_RESOURCE_STALE"));
  pass("Composition fails closed when the exact reviewed page can no longer be re-resolved");

  const durable = await panel.evaluate(async () => chrome.storage.local.get(["browsercrew.scheduleRuns.v1", "browsercrew.skillRuns.v1"]));
  assert.equal((durable["browsercrew.scheduleRuns.v1"] || []).length, 0);
  assert.equal((durable["browsercrew.skillRuns.v1"] || []).length, 0);
  pass("Readiness and preflight composition create no schedule or Skill run receipt");

  const production = await panel.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    return { alarms: (manifest.permissions || []).includes("alarms") };
  });
  assert.equal(production.alarms, false);
  pass("Production extension remains without alarms permission during composition proof");

  await panel.screenshot({ path: join(artifactDir, "schedule-dispatch-runtime.png"), fullPage: true });
  report.ok = true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew production schedule dispatch composition installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.ok = false;
  report.completedAt = new Date().toISOString();
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareTestExtension(target, origin) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(relative.split(/[/\\]/)[0]);
  } });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function startFixtureServer() {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><h1>Resolver Composition Ready</h1></body></html>");
    });
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) });
    });
  });
}
