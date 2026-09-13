import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-resolvers-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-resolvers-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const report = { schemaVersion: 1, kind: "browsercrew.schedule_resolvers_smoke", startedAt: new Date().toISOString(), checks: [] };
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

  await panel.evaluate(async (connection) => {
    await chrome.storage.local.set({ "browsercrew.connections.v1": [connection] });
  }, {
    id: "resolver-provider",
    schemaVersion: 1,
    name: "Resolver provider",
    kind: "openai",
    model: "resolver-model",
    baseUrl: "https://api.example.test/v1",
    status: "connected",
    capabilities: [],
    lastTestedAt: "2026-09-13T05:00:00.000Z",
    createdAt: "2026-09-13T05:00:00.000Z",
    updatedAt: "2026-09-13T05:00:00.000Z"
  });

  const provider = await panel.evaluate(async () => {
    const mod = await import(chrome.runtime.getURL("src/schedule-resolvers.js"));
    return mod.createScheduleProviderResolver()("resolver-provider");
  });
  assert.equal(provider.id, "resolver-provider");
  assert.equal(provider.available, true);
  assert.deepEqual(provider.capabilities, []);
  assert.equal(Object.prototype.hasOwnProperty.call(provider, "baseUrl"), false);
  assert.equal(JSON.stringify(provider).includes("secret"), false);
  pass("Named provider resolver returns only bounded durable metadata and no endpoint/secret state");

  const resolved = await panel.evaluate(async ({ reviewedUrl, origin }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-resolvers.js"));
    const resolver = mod.createScheduleResourceResolver();
    return resolver({
      schedule: { startResource: { kind: "exact_url", url: reviewedUrl, expectedResources: [] } },
      skill: { allowedOrigins: [origin], allowedResources: [] }
    });
  }, { reviewedUrl, origin: fixture.origin });
  assert.equal(resolved.url, reviewedUrl);
  assert.equal(resolved.fresh, true);
  assert.ok(Number.isInteger(resolved.tabId));
  pass("Resource resolver finds exactly the reviewed URL using existing Chrome site permission, not active-tab state");

  const duplicate = await context.newPage();
  await duplicate.goto(reviewedUrl);
  const ambiguousCode = await panel.evaluate(async ({ reviewedUrl, origin }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-resolvers.js"));
    try {
      await mod.createScheduleResourceResolver()({
        schedule: { startResource: { kind: "exact_url", url: reviewedUrl, expectedResources: [] } },
        skill: { allowedOrigins: [origin], allowedResources: [] }
      });
      return null;
    } catch (error) { return error?.code || null; }
  }, { reviewedUrl, origin: fixture.origin });
  assert.equal(ambiguousCode, "SCHEDULE_RESOURCE_AMBIGUOUS");
  await duplicate.close();
  pass("Multiple exact tab matches fail closed instead of choosing one blindly");

  const semanticCode = await panel.evaluate(async ({ reviewedUrl, origin }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-resolvers.js"));
    try {
      await mod.createScheduleResourceResolver()({
        schedule: { startResource: { kind: "exact_url", url: reviewedUrl, expectedResources: ["resource:orders"] } },
        skill: { allowedOrigins: [origin], allowedResources: ["resource:orders"] }
      });
      return null;
    } catch (error) { return error?.code || null; }
  }, { reviewedUrl, origin: fixture.origin });
  assert.equal(semanticCode, "SCHEDULE_RESOURCE_ID_RESOLVER_REQUIRED");
  pass("Semantic resource IDs are never copied from saved data when no real resource verifier exists");

  await target.close();
  const staleCode = await panel.evaluate(async ({ reviewedUrl, origin }) => {
    const mod = await import(chrome.runtime.getURL("src/schedule-resolvers.js"));
    try {
      await mod.createScheduleResourceResolver()({
        schedule: { startResource: { kind: "exact_url", url: reviewedUrl, expectedResources: [] } },
        skill: { allowedOrigins: [origin], allowedResources: [] }
      });
      return null;
    } catch (error) { return error?.code || null; }
  }, { reviewedUrl, origin: fixture.origin });
  assert.equal(staleCode, "SCHEDULE_RESOURCE_STALE");
  pass("Closed or missing reviewed page blocks resolution rather than falling back to another tab");

  const durable = await panel.evaluate(async () => chrome.storage.local.get(["browsercrew.scheduleRuns.v1", "browsercrew.skillRuns.v1", "browsercrew.scheduleGrants.v1"]));
  assert.equal((durable["browsercrew.scheduleRuns.v1"] || []).length, 0);
  assert.equal((durable["browsercrew.skillRuns.v1"] || []).length, 0);
  assert.equal((durable["browsercrew.scheduleGrants.v1"] || []).length, 0);
  pass("Resolver inspection creates no authority and no task or schedule run receipt");

  await panel.screenshot({ path: join(artifactDir, "schedule-resolvers.png"), fullPage: true });
  report.ok = true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew schedule provider/resource resolver installed-extension smoke checks passed.");
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
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><h1>Resolver Orders</h1><p>${req.url}</p></body></html>`);
    });
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) });
    });
  });
}
