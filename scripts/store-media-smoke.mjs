import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "store-media");
const screenshotPath = join(artifactDir, "browsercrew-workspace-1280x800.png");
const timeoutMs = 30_000;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const fixture = await startFixtureServer();
const provider = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-store-media-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = {
  kind: "browsercrew.store_media_evidence",
  schemaVersion: 1,
  release: "v0.2",
  candidateSha: await resolveCandidateSha(),
  startedAt: new Date().toISOString(),
  checks: []
};

try {
  await prepareTestExtension(extensionDir, [fixture.origin, provider.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(serviceWorker.url()).host;
  report.extensionId = extensionId;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.locator("#modelInput").waitFor({ state: "visible", timeout: timeoutMs });
  await configureLocalProvider(panel, provider.origin);
  await panel.locator("#aiSetupCloseButton").click();
  await panel.locator("#aiSetupBackdrop").waitFor({ state: "hidden", timeout: timeoutMs });
  pass("Installed extension connected through the progressive Connect AI popup and returned to Chat");

  const pages = [];
  for (const slug of ["atlas", "beacon", "cedar"]) {
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/${slug}.html`);
    pages.push(page);
  }

  await panel.getByRole("tab", { name: "Workspace" }).click();
  const compareMode = panel.getByRole("radio", { name: /Compare pages/ });
  await compareMode.waitFor({ state: "visible", timeout: timeoutMs });
  await compareMode.click();
  await panel.locator("#compareJobCard").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#refreshCompareTabsButton").click();

  for (const title of ["Atlas Packaging", "Beacon Supply Co.", "Cedar Wholesale"]) {
    const choice = panel.locator("#compareTabList [data-compare-tab-id]", { hasText: title });
    await choice.waitFor({ state: "visible", timeout: timeoutMs });
    await choice.click();
  }
  await panel.locator("#compareCriteriaInput").fill("Price\nMinimum order\nLead time\nShipping");
  pass("Store screenshot state uses the real Workspace compare UI with three user-selected pages");

  await panel.bringToFront();
  await panel.setViewportSize({ width: 1280, height: 800 });
  await panel.screenshot({ path: screenshotPath, type: "png", fullPage: false });

  const dimensions = await pngDimensions(screenshotPath);
  assert.deepEqual(dimensions, { width: 1280, height: 800 }, "Store screenshot must be exactly 1280x800.");
  const fileInfo = await stat(screenshotPath);
  assert.ok(fileInfo.size > 10_000, "Store screenshot must contain a non-trivial rendered UI image.");
  pass("Generated a real installed-extension PNG at the Chrome Web Store preferred 1280x800 size", {
    file: "browsercrew-workspace-1280x800.png",
    width: dimensions.width,
    height: dimensions.height,
    bytes: fileInfo.size
  });

  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.media = [{
    id: "screenshot_1280x800",
    file: "browsercrew-workspace-1280x800.png",
    mimeType: "image/png",
    width: 1280,
    height: 800,
    source: "installed_extension_workspace_compare_setup"
  }];
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Chrome Web Store media smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await provider.close();
  await fixture.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name, details = null) {
  report.checks.push({ name, details, at: new Date().toISOString() });
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function configureLocalProvider(panel, providerOrigin) {
  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#connectionNameInput").fill("Store preview AI");
  await panel.locator("#modelInput").fill("browsercrew-store-preview");
  await panel.locator("#serverInput").fill(`${providerOrigin}/v1`);
  await panel.locator("#saveConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  assert.match(await panel.locator("#aiStatus").innerText(), /Connected/i);
}

async function startFixtureServer() {
  const pages = {
    "/atlas.html": ["Atlas Packaging", "$1.20 per box", "100 units", "5 business days"],
    "/beacon.html": ["Beacon Supply Co.", "$1.05 per box", "250 units", "3 business days"],
    "/cedar.html": ["Cedar Wholesale", "$1.10 per box", "150 units", "7 business days"]
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const data = pages[url.pathname];
    if (!data) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    const [title, price, minimum, lead] = data;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>Price: ${price}</p><p>Minimum order: ${minimum}</p><p>Lead time: ${lead}</p><p>Shipping: Standard ground</p></main></body></html>`);
  });
  return listen(server);
}

async function startProviderServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }
    await readBody(request);
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({
      id: "browsercrew-store-preview",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "browsercrew-store-preview",
      choices: [{ index: 0, message: { role: "assistant", content: "BrowserCrew connection works" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
  return listen(server);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({ origin, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function waitForText(locator, text) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function pngDimensions(path) {
  const buffer = await readFile(path);
  assert.ok(buffer.length >= 24, "PNG file is too short.");
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "Store media must be a PNG.");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR", "PNG must begin with an IHDR chunk.");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function resolveCandidateSha() {
  const explicit = String(process.env.BROWSERCREW_CANDIDATE_SHA || "").trim();
  if (/^[a-f0-9]{40}$/i.test(explicit)) return explicit.toLowerCase();

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(await readFile(eventPath, "utf8"));
      const eventSha = event?.pull_request?.head?.sha || event?.after;
      if (/^[a-f0-9]{40}$/i.test(eventSha || "")) return String(eventSha).toLowerCase();
    } catch {}
  }

  const githubSha = String(process.env.GITHUB_SHA || "").trim();
  if (/^[a-f0-9]{40}$/i.test(githubSha)) return githubSha.toLowerCase();

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const sha = stdout.trim();
  assert.match(sha, /^[a-f0-9]{40}$/i, "Store media evidence must resolve an exact candidate SHA.");
  return sha.toLowerCase();
}