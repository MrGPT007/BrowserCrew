import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "privacy-sinks-smoke");
const timeoutMs = 40_000;
const CANARY = Object.freeze({
  providerSecret: "BC_SINK_PROVIDER_SECRET_f31c82",
  providerError: "BC_SINK_PROVIDER_ERROR_8bc441",
  w2Password: "BC_SINK_W2_PASSWORD_1d0e74",
  w2Hidden: "BC_SINK_W2_HIDDEN_57a8c2",
  w2Script: "BC_SINK_W2_SCRIPT_d9f110",
  w5Password: "BC_SINK_W5_PASSWORD_09ce27",
  w5Hidden: "BC_SINK_W5_HIDDEN_42b31d",
  w5Script: "BC_SINK_W5_SCRIPT_772f6a"
});
const forbidden = Object.values(CANARY);
const report = { startedAt: new Date().toISOString(), checks: [] };

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const fixture = await startFixtureServer();
const provider = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-privacy-sinks-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;

try {
  await prepareTestExtension(extensionDir, [fixture.origin, provider.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await configureProvider(panel, provider.origin);

  const directoryPage = await context.newPage();
  await directoryPage.goto(`${fixture.origin}/directory-1.html`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePage(panel, directoryPage, "Privacy Directory — Page 1");
  await panel.getByRole("radio", { name: /Extract a directory/ }).click();
  await panel.locator("#directoryJobCard").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#directoryColumnsInput").fill("Company\nCity\nNotes");
  await panel.locator("#directoryDedupeKey").selectOption({ label: "Company" });
  await panel.locator("#directoryPageLimit").fill("2");
  await panel.locator("#runDirectoryButton").click();
  await panel.locator("#directoryResultCard").waitFor({ state: "visible", timeout: timeoutMs });

  const modelBodies = provider.requests.map((item) => item.body).join("\n");
  assert.match(modelBodies, /Visible Alpha/);
  assert.match(modelBodies, /Visible Beta/);
  for (const canary of [CANARY.w2Password, CANARY.w2Hidden, CANARY.w2Script]) {
    assert.equal(modelBodies.includes(canary), false, "W2 sent a hidden privacy canary to the selected model.");
  }

  const csvDownload = await downloadFrom(panel, "#downloadDirectoryCsvButton");
  const csv = await readFile(await requiredPath(csvDownload, "W2 CSV"), "utf8");
  const jsonDownload = await downloadFrom(panel, "#downloadDirectoryJsonButton");
  const jsonText = await readFile(await requiredPath(jsonDownload, "W2 JSON"), "utf8");
  const json = JSON.parse(jsonText);
  assert.equal(json.kind, "browsercrew.directory_export");
  assert.equal(json.rows.length, 2);
  assert.ok(csv.includes("Visible Alpha") && csv.includes("Visible Beta"));
  assert.ok(jsonText.includes("Visible Alpha") && jsonText.includes("Visible Beta"));
  assertNoCanaries(csv, "W2 CSV export");
  assertNoCanaries(jsonText, "W2 JSON export");
  pass("W2 model context and CSV/JSON exports excluded hidden, script, password, provider, and error canaries");

  const portalPage = await context.newPage();
  await portalPage.goto(`${fixture.origin}/invoice-portal.html`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePage(panel, portalPage, "Privacy invoice portal");
  await panel.getByRole("radio", { name: /Collect invoices/ }).click();
  await panel.locator("#invoiceJobCard").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#loadInvoicesButton").click();
  await panel.locator("#invoiceChoiceList").waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await panel.locator("#invoiceAccountBox").innerText(), /Privacy Office LLC/);
  await panel.locator('input[data-invoice-id="INV-PRIV-001"]').check();
  await panel.locator("#runInvoiceButton").click();
  await panel.locator("#invoiceResultCard").waitFor({ state: "visible", timeout: timeoutMs });

  const invoiceTask = await waitForTask(panel, (task) => task.kind === "invoice_collection" && task.status === "completed");
  assert.equal(invoiceTask.result?.verifiedCount, 1);
  assertNoCanaries(JSON.stringify(invoiceTask), "W5 durable invoice task");
  const invoiceEntry = invoiceTask.result?.entries?.[0];
  assert.ok(invoiceEntry?.filename && invoiceEntry?.finalUrl);
  assertNoCanaries(JSON.stringify({ filename: invoiceEntry.filename, finalUrl: invoiceEntry.finalUrl, downloadUrl: invoiceEntry.downloadUrl }), "W5 Chrome download metadata");

  const manifestDownload = await downloadFrom(panel, "#downloadInvoiceManifestButton");
  const manifestText = await readFile(await requiredPath(manifestDownload, "W5 manifest"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.kind, "browsercrew.invoice_manifest");
  assert.equal(manifest.account?.id, "ACCT-PRIV-1");
  assert.equal(manifest.entries?.length, 1);
  assertNoCanaries(manifestText, "W5 manifest export");
  pass("W5 durable state, verified download metadata, and manifest excluded unrelated portal privacy canaries");

  const errorPage = await context.newPage();
  await errorPage.goto(`${fixture.origin}/provider-error.html`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await panel.getByRole("radio", { name: /Read information/ }).click();
  await selectActivePage(panel, errorPage, "Provider error privacy fixture");
  const errorGoal = "Trigger provider error privacy check.";
  await panel.locator("#goalInput").fill(errorGoal);
  await panel.locator("#runButton").click();
  const failedTask = await waitForTask(panel, (task) => task.goal === errorGoal && task.status === "failed");
  assert.equal(failedTask.error?.code, "PROVIDER_ERROR");
  assert.match(failedTask.error?.message || "", /HTTP 503/);
  assertNoCanaries(JSON.stringify(failedTask), "failed task after provider error");
  const visibleUi = await panel.locator("body").innerText();
  assertNoCanaries(visibleUi, "visible UI after provider error");
  pass("Hostile provider error text was replaced with BrowserCrew-owned safe copy before UI or durable history");

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), errorGoal);
  const historyText = await panel.locator("#historyList").innerText();
  assertNoCanaries(historyText, "History");

  const storage = await panel.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null)
  }));
  const localText = JSON.stringify(storage.local);
  assertNoCanaries(localText, "chrome.storage.local");
  assert.equal(JSON.stringify(storage.session).includes(CANARY.providerSecret), true, "Provider credential should remain available only in session storage during the session.");
  assert.ok(provider.requests.every((request) => request.authorization === `Bearer ${CANARY.providerSecret}`));
  pass("All durable local storage and History excluded seeded sink canaries while the provider credential remained session-only");

  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const artifactText = await readFile(join(artifactDir, "report.json"), "utf8");
  assertNoCanaries(artifactText, "privacy sink evidence artifact");
  console.log("BrowserCrew v0.2 privacy sink smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: "Privacy sink smoke failed; inspect the named assertion without serializing canary values." };
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await provider.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

function assertNoCanaries(text, sink) {
  for (const canary of forbidden) assert.equal(String(text).includes(canary), false, `${sink} contains a seeded privacy canary.`);
}

async function downloadFrom(panel, selector) {
  const pending = panel.waitForEvent("download", { timeout: timeoutMs });
  await panel.locator(selector).click();
  return pending;
}

async function requiredPath(download, label) {
  const path = await download.path();
  assert.ok(path, `${label} did not produce a browser-backed file.`);
  return path;
}

async function configureProvider(panel, origin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /OpenAI API/ }).click();
  await panel.locator("#modelInput").fill("browsercrew-privacy-sinks");
  await panel.locator("#serverInput").fill(`${origin}/v1`);
  await panel.locator("#apiKeyInput").fill(CANARY.providerSecret);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
}

async function selectActivePage(panel, page, expectedTitle) {
  await page.bringToFront();
  await panel.bringToFront();
  await panel.evaluate(() => document.querySelector("#selectTabButton")?.click());
  await waitForText(panel.locator("#selectedTabSummary"), expectedTitle);
}

async function waitForTask(panel, predicate) {
  let latest = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
    const tasks = response?.tasks || [];
    latest = tasks[0] || null;
    const task = tasks.find(predicate);
    if (task) return task;
    await panel.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for expected durable task state: ${latest?.status || "none"}`);
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for expected UI text.");
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "node_modules", "artifacts"].includes(relative.split(/[/\\]/)[0]);
  }});
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer() {
  const directory1 = `<!doctype html><html><head><title>Privacy Directory — Page 1</title></head><body><main>
    <h1>Privacy Directory</h1><article><h2>Visible Alpha</h2><p>City: Delhi</p><p>Notes: Public one</p></article>
    <input type="password" value="${CANARY.w2Password}"><div hidden>${CANARY.w2Hidden}</div><script>window.__private=${JSON.stringify(CANARY.w2Script)}</script>
    <nav><a rel="next" href="/directory-2.html">Next</a></nav>
  </main></body></html>`;
  const directory2 = `<!doctype html><html><head><title>Privacy Directory — Page 2</title></head><body><main>
    <h1>Privacy Directory</h1><article><h2>Visible Beta</h2><p>City: Pune</p><p>Notes: Public two</p></article>
  </main></body></html>`;
  const portal = `<!doctype html><html><head><title>Privacy invoice portal</title></head><body>
    <main data-browsercrew-invoice-portal data-account-id="ACCT-PRIV-1" data-account-label="Privacy Office LLC">
      <h1>Invoices</h1><p>Account: Privacy Office LLC · ACCT-PRIV-1</p>
      <input type="password" value="${CANARY.w5Password}"><div hidden>${CANARY.w5Hidden}</div><script>window.__portalPrivate=${JSON.stringify(CANARY.w5Script)}</script>
      <table><tbody><tr data-browsercrew-invoice data-invoice-id="INV-PRIV-001" data-invoice-label="Invoice INV-PRIV-001" data-invoice-date="2026-09-01" data-invoice-amount="$42.00">
        <td>INV-PRIV-001</td><td>September 1, 2026</td><td>$42.00</td><td><a data-browsercrew-invoice-download href="/invoices/INV-PRIV-001.pdf">Download PDF</a></td>
      </tr></tbody></table>
    </main>
  </body></html>`;
  const providerError = `<!doctype html><html><head><title>Provider error privacy fixture</title></head><body><main><h1>Visible error fixture</h1><p>Public value: safe</p></main></body></html>`;

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/directory-1.html") return html(response, directory1);
    if (url.pathname === "/directory-2.html") return html(response, directory2);
    if (url.pathname === "/invoice-portal.html") return html(response, portal);
    if (url.pathname === "/provider-error.html") return html(response, providerError);
    if (url.pathname === "/invoices/INV-PRIV-001.pdf") {
      const bytes = Buffer.from("%PDF-1.4\n% BrowserCrew privacy fixture\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "utf8");
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(bytes.length), "Cache-Control": "no-store" });
      response.end(bytes);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  });
  return listen(server, {});
}

async function startProviderServer() {
  const state = { requests: [] };
  const rowsByTitle = {
    "Privacy Directory — Page 1": [{ Company: "Visible Alpha", City: "Delhi", Notes: "Public one" }],
    "Privacy Directory — Page 2": [{ Company: "Visible Beta", City: "Pune", Notes: "Public two" }]
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }

    const raw = await readBody(request);
    state.requests.push({ authorization: String(request.headers.authorization || ""), body: raw });
    const body = JSON.parse(raw);
    const system = String(body.messages?.find((message) => message.role === "system")?.content || "");
    const user = String(body.messages?.find((message) => message.role === "user")?.content || "");

    if (user.includes("Trigger provider error privacy check.")) {
      response.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({ error: { message: `${CANARY.providerError} ${CANARY.providerSecret}` } }));
      return;
    }

    let content = "BrowserCrew connection works";
    if (/structured directory rows/i.test(system)) {
      const schemaText = between(user, "Declared columns:\n", "\n\nPage title:");
      const schema = JSON.parse(schemaText || "[]");
      const title = between(user, "Page title: ", "\nPage address:") || "";
      const sourceRows = rowsByTitle[title] || [];
      content = JSON.stringify({ rows: sourceRows.map((row) => ({ values: Object.fromEntries(schema.map((column) => [column.ref, row[column.label] ?? null])) })) });
    }

    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({
      id: `privacy-sink-${Date.now()}`, object: "chat.completion", model: body.model || "browsercrew-privacy-sinks",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }));
  });
  return listen(server, state);
}

function html(response, body) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
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

function listen(server, state) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        ...state,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
