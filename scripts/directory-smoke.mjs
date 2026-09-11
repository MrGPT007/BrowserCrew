import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "directory-smoke");
const timeoutMs = 35_000;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const fixtureServer = await startFixtureServer();
const providerServer = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-directory-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = {
  startedAt: new Date().toISOString(),
  fixtureOrigin: fixtureServer.origin,
  providerOrigin: providerServer.origin,
  checks: []
};

try {
  await prepareTestExtension(extensionDir, [fixtureServer.origin, providerServer.origin]);

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
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
  await configureLocalProvider(panel, providerServer.origin);
  pass("Installed extension connected to deterministic local provider");

  const directoryPage = await context.newPage();
  await directoryPage.goto(`${fixtureServer.origin}/directory-page-1.html`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePageFromPanel(panel, directoryPage, "Regional Supplier Directory");
  pass("User-selected page 1 became the bounded W2 starting resource");

  await panel.bringToFront();
  const directoryMode = panel.getByRole("radio", { name: /Extract a directory/ });
  await directoryMode.waitFor({ state: "visible", timeout: timeoutMs });
  await directoryMode.click();
  await panel.locator("#directoryJobCard").waitFor({ state: "visible", timeout: timeoutMs });

  await panel.locator("#directoryColumnsInput").fill("Company\nCity\nPhone\nNotes");
  await panel.locator("#directoryDedupeKey").selectOption({ label: "Company" });
  await panel.locator("#directoryPageLimit").fill("3");
  await panel.locator("#runDirectoryButton").click();
  await panel.locator("#directoryResultCard").waitFor({ state: "visible", timeout: timeoutMs });

  const table = panel.locator("#directoryTableWrap .compare-table");
  assert.equal(await table.locator("tbody tr").count(), 7, "W2 should export seven rows after removing one exact duplicate and keeping one conflicting duplicate.");
  const tableText = await table.innerText();
  for (const expected of [
    "Alpha Components", "Beacon Labs", "Cedar Works", "Delta Machines", "Echo Textiles", "Forge Systems",
    "=2+3", "@priority", "+SUM(1,1)", "+91 120 555 9999"
  ]) {
    assert.ok(tableText.includes(expected), `Directory result is missing expected verified text: ${expected}`);
  }
  assert.match(tableText, /Conflict with earlier Company: Phone/i);
  assert.equal(directoryPage.url(), `${fixtureServer.origin}/directory-page-3.html`, "The selected tab should stop on page 3.");
  pass("W2 followed same-site Next links across exactly three bounded pages");

  const summary = await panel.locator("#directorySummaryBox").innerText();
  assert.match(summary, /7 export rows from 3 pages/i);
  assert.match(summary, /2 duplicates explained/i);
  const duplicateText = await panel.locator("#directoryDuplicateBox").innerText();
  assert.match(duplicateText, /Exact duplicate removed/i);
  assert.match(duplicateText, /Both rows were kept for review/i);
  pass("W2 explained exact and conflicting duplicates without silently dropping conflicting data");

  const csvPromise = panel.waitForEvent("download", { timeout: timeoutMs });
  await panel.locator("#downloadDirectoryCsvButton").click();
  const csvDownload = await csvPromise;
  const csvPath = await csvDownload.path();
  assert.ok(csvPath, "CSV download should produce a browser-backed file.");
  const csv = await readFile(csvPath, "utf8");
  assert.ok(csv.includes('"_source_url"'), "CSV must keep source URL references.");
  assert.ok(csv.includes('"_source_page"'), "CSV must keep source page references.");
  assert.ok(csv.includes('"_duplicate_status"'), "CSV must keep duplicate status.");
  assert.ok(csv.includes(`"'=2+3"`), "CSV must neutralize leading '=' spreadsheet formulas.");
  assert.ok(csv.includes(`"'@priority"`), "CSV must neutralize leading '@' spreadsheet formulas.");
  assert.ok(csv.includes(`"'+SUM(1,1)"`), "CSV must neutralize leading '+' spreadsheet formulas.");
  assert.ok(!csv.includes(`"=2+3"`), "Unsafe formula text must not remain unprefixed in CSV.");
  pass("CSV export retained provenance and neutralized spreadsheet formula injection");

  const jsonPromise = panel.waitForEvent("download", { timeout: timeoutMs });
  await panel.locator("#downloadDirectoryJsonButton").click();
  const jsonDownload = await jsonPromise;
  const jsonPath = await jsonDownload.path();
  assert.ok(jsonPath, "JSON download should produce a browser-backed file.");
  const json = JSON.parse(await readFile(jsonPath, "utf8"));
  assert.equal(json.kind, "browsercrew.directory_export");
  assert.equal(json.rows.length, 7);
  assert.equal(json.duplicates.length, 2);
  assert.ok(json.rows.some((row) => row.values?.Notes === "=2+3"), "JSON should retain the original verified text.");
  assert.equal(json.sourceUrls.length, 3);
  pass("JSON export retained schema, rows, duplicates, and source references");

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), "Extract a paginated directory");
  pass("Completed W2 task remained inspectable in local History");

  await panel.screenshot({ path: join(artifactDir, "directory-result.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew W2 installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixtureServer.close();
  await providerServer.close();
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
  await panel.locator("#modelInput").fill("browsercrew-w2-smoke");
  await panel.locator("#serverInput").fill(`${providerOrigin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  assert.match(await panel.locator("#aiStatus").innerText(), /Connected/i);
}

async function selectActivePageFromPanel(panel, targetPage, expectedTitle) {
  await targetPage.bringToFront();
  await panel.evaluate(() => document.querySelector("#selectTabButton")?.click());
  await waitForText(panel.locator("#selectedTabSummary"), expectedTitle);
  assert.equal(await panel.locator("#pageStatus").getAttribute("data-state"), "ok");
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 350; attempt += 1) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function startFixtureServer() {
  const fixtures = new Set([
    "directory-page-1.html",
    "directory-page-2.html",
    "directory-page-3.html"
  ]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const name = url.pathname.replace(/^\//, "");
      if (!fixtures.has(name)) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      const html = await readFile(join(repoRoot, "tests", "fixtures", name), "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error?.message || "Fixture server error");
    }
  });
  return listen(server);
}

async function startProviderServer() {
  const pages = {
    "Regional Supplier Directory — Page 1": [
      { Company: "Alpha Components", City: "Gurugram", Phone: "+91 124 555 0101", Notes: "Preferred" },
      { Company: "Beacon Labs", City: "Delhi", Phone: "+91 11 555 0102", Notes: "=2+3" },
      { Company: "Cedar Works", City: "Noida", Phone: "+91 120 555 0103", Notes: "Standard" }
    ],
    "Regional Supplier Directory — Page 2": [
      { Company: "Alpha Components", City: "Gurugram", Phone: "+91 124 555 0101", Notes: "Preferred" },
      { Company: "Delta Machines", City: "Faridabad", Phone: "+91 129 555 0104", Notes: "Fast shipping" },
      { Company: "Echo Textiles", City: "Jaipur", Phone: "+91 141 555 0105", Notes: "@priority" }
    ],
    "Regional Supplier Directory — Page 3": [
      { Company: "Cedar Works", City: "Noida", Phone: "+91 120 555 9999", Notes: "Standard" },
      { Company: "Forge Systems", City: "Pune", Phone: "+91 20 555 0106", Notes: "+SUM(1,1)" }
    ]
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }

    try {
      const body = JSON.parse(await readBody(request));
      const system = String(body.messages?.find((message) => message.role === "system")?.content || "");
      const user = String(body.messages?.find((message) => message.role === "user")?.content || "");
      let content = "BrowserCrew connection works";

      if (/structured directory rows/i.test(system)) {
        const schemaText = between(user, "Declared columns:\n", "\n\nPage title:");
        const schema = JSON.parse(schemaText || "[]");
        const title = between(user, "Page title: ", "\nPage address:") || "";
        const sourceRows = pages[title] || [];
        content = JSON.stringify({
          rows: sourceRows.map((row) => ({
            values: Object.fromEntries(schema.map((column) => [column.ref, row[column.label] ?? null]))
          }))
        });
      }

      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({
        id: `w2-smoke-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "browsercrew-w2-smoke",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: error?.message || "Provider stub failed" } }));
    }
  });
  return listen(server);
}

function between(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const valueStart = from + start.length;
  const to = text.indexOf(end, valueStart);
  return to < 0 ? text.slice(valueStart) : text.slice(valueStart, to);
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
