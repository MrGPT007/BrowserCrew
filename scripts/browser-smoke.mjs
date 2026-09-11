import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "browser-smoke");
const timeoutMs = 30_000;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const signalBus = createSignalBus();
const fixtureServer = await startFixtureServer(signalBus);
const providerServer = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-smoke-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), fixtureOrigin: fixtureServer.origin, providerOrigin: providerServer.origin, checks: [] };

try {
  await prepareTestExtension(extensionDir, [fixtureServer.origin, providerServer.origin]);

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
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
  await panel.locator("#modelInput").waitFor({ state: "visible", timeout: timeoutMs });
  await assertNoPageErrors(panel, "initial side panel load");
  pass("Installed MV3 extension and side panel loaded", { extensionId });

  await configureLocalProvider(panel, providerServer.origin);
  pass("Local OpenAI-compatible provider connection succeeded");

  const supplierPages = [];
  for (const name of ["a", "b", "c", "d", "e"]) {
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/supplier-${name}.html`);
    supplierPages.push(page);
  }
  await runSupplierComparison(panel);
  pass("W1 compared five controlled supplier pages with verified values and missing-data reporting");

  const formPage = await context.newPage();
  await formPage.goto(`${fixtureServer.origin}/form.html`);
  await selectActivePageFromPanel(panel, formPage, "Business inquiry fixture");
  await runNormalFormWorkflow(panel, formPage);
  pass("W3 previewed and filled approved fields without submitting the form");

  await panel.close();
  const reopenedPanel = await context.newPage();
  await reopenedPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await reopenedPanel.getByRole("tab", { name: "History" }).click();
  await reopenedPanel.locator("#historyList").waitFor({ state: "visible", timeout: timeoutMs });
  await waitForText(reopenedPanel.locator("#historyList"), "Priya Sharma");
  pass("Completed W3 task survived side-panel closure and remained inspectable in History");

  const crashPage = await context.newPage();
  await crashPage.goto(`${fixtureServer.origin}/form.html?crash=1`);
  await reopenedPanel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePageFromPanel(reopenedPanel, crashPage, "Business inquiry fixture");
  const crashResult = await runCrashRecoveryScenario(reopenedPanel, crashPage, extensionId, signalBus);
  pass("Controlled write recovery did not replay an uncertain write", crashResult);

  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  await reopenedPanel.screenshot({ path: join(artifactDir, "final-sidepanel.png"), fullPage: true });
  console.log("BrowserCrew installed-extension smoke checks passed.");
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
  await panel.locator("#modelInput").fill("browsercrew-smoke");
  await panel.locator("#serverInput").fill(`${providerOrigin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  assert.match(await panel.locator("#aiStatus").innerText(), /Connected/i);
}

async function runSupplierComparison(panel) {
  await panel.getByRole("tab", { name: "Workspace" }).click();
  const compareMode = panel.getByRole("radio", { name: /Compare pages/ });
  await compareMode.waitFor({ state: "visible", timeout: timeoutMs });
  await compareMode.click();
  await panel.locator("#compareJobCard").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#refreshCompareTabsButton").click();

  for (const title of ["Atlas Packaging", "Beacon Supply Co.", "Cedar Wholesale", "Delta Cartons", "Evergreen Mailers"]) {
    const choice = panel.locator("#compareTabList [data-compare-tab-id]", { hasText: title });
    await choice.waitFor({ state: "visible", timeout: timeoutMs });
    await choice.click();
  }
  await panel.locator("#compareCriteriaInput").fill("Price\nMinimum order\nLead time\nShipping");
  await panel.locator("#runCompareButton").click();
  await panel.locator("#compareResultCard").waitFor({ state: "visible", timeout: timeoutMs });

  const table = panel.locator(".compare-table");
  assert.equal(await table.locator("tbody tr").count(), 5, "Comparison table should contain five supplier rows.");
  const text = await table.innerText();
  for (const expected of ["Atlas Packaging", "$1.20 per box", "100 units", "5 business days", "Beacon Supply Co.", "$1.05 per box", "Delta Cartons", "$0.92 per box"]) {
    assert.ok(text.includes(expected), `Comparison table is missing expected value: ${expected}`);
  }
  assert.ok(text.includes("Not found"), "Comparison table should expose missing values instead of inventing them.");
  const evidence = await panel.locator("#compareEvidenceBox").innerText();
  assert.match(evidence, /missing or unverified/i);
  assert.equal(await table.locator("a").count(), 5, "Every supplier row should link back to its source page.");
}

async function selectActivePageFromPanel(panel, targetPage, expectedTitle) {
  await targetPage.bringToFront();
  await panel.evaluate(() => document.querySelector("#selectTabButton")?.click());
  await waitForText(panel.locator("#selectedTabSummary"), expectedTitle);
  assert.equal(await panel.locator("#pageStatus").getAttribute("data-state"), "ok");
}

async function runNormalFormWorkflow(panel, formPage) {
  await panel.getByRole("radio", { name: /Prepare a form/ }).click();
  await panel.locator("#formDetailsInput").fill([
    "Name: Priya Sharma",
    "Email: priya@example.com",
    "Message: Please send your wholesale pricing."
  ].join("\n"));
  await panel.locator("#previewFormButton").click();
  await panel.locator("#formPreviewCard").waitFor({ state: "visible", timeout: timeoutMs });
  const preview = await panel.locator("#formChangeList").innerText();
  assert.match(preview, /Priya Sharma/);
  assert.match(preview, /priya@example\.com/);
  assert.match(preview, /wholesale pricing/i);
  await panel.locator("#approveFormButton").click();
  await panel.locator("#formResultCard").waitFor({ state: "visible", timeout: timeoutMs });

  const state = await formPage.evaluate(() => ({
    name: document.querySelector("#name")?.value,
    email: document.querySelector("#email")?.value,
    message: document.querySelector("#message")?.value,
    fixture: window.__browserCrewFixture
  }));
  assert.deepEqual({ name: state.name, email: state.email, message: state.message }, {
    name: "Priya Sharma",
    email: "priya@example.com",
    message: "Please send your wholesale pricing."
  });
  assert.equal(state.fixture?.submits, 0, "Controlled form fill must not submit the fixture.");
  assert.ok((state.fixture?.inputEvents || 0) >= 3, "Expected input events from approved field writes.");
  assert.match(await panel.locator("#formEvidenceBox").innerText(), /Not submitted/i);
}

async function runCrashRecoveryScenario(panel, formPage, extensionId, signalBus) {
  await panel.getByRole("radio", { name: /Prepare a form/ }).click();
  await panel.locator("#formDetailsInput").fill([
    "Name: Alex Rivera",
    "Email: alex@example.com",
    "Message: Please send partnership information."
  ].join("\n"));
  await panel.locator("#previewFormButton").click();
  await panel.locator("#formPreviewCard").waitFor({ state: "visible", timeout: timeoutMs });

  const inputSignal = withTimeout(signalBus.wait(), 10_000, "Timed out waiting for the controlled write to reach the crash fixture.");
  await panel.locator("#approveFormButton").click();
  await inputSignal;

  const cdp = await panel.context().newCDPSession(panel);
  const targets = await cdp.send("Target.getTargets");
  const target = targets.targetInfos.find((info) => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
  assert.ok(target?.targetId, "Could not find the BrowserCrew service-worker target to exercise recovery.");
  await cdp.send("Target.closeTarget", { targetId: target.targetId });
  await cdp.detach();

  await formPage.waitForTimeout(1400);
  const beforeRestart = await formPage.evaluate(() => ({
    inputs: window.__browserCrewFixture?.inputEvents || 0,
    submits: window.__browserCrewFixture?.submits || 0,
    name: document.querySelector("#name")?.value || "",
    email: document.querySelector("#email")?.value || "",
    message: document.querySelector("#message")?.value || ""
  }));
  assert.equal(beforeRestart.submits, 0, "The uncertain write must not submit the form before recovery.");

  let recoveredTask;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
    recoveredTask = response?.tasks?.find((task) => task.kind === "form_fill" && task.goal.includes("Alex Rivera"));
    if (recoveredTask && !["planning", "running", "committing"].includes(recoveredTask.status)) break;
    await panel.waitForTimeout(250);
  }
  assert.ok(recoveredTask, "Recovered form task was not found in durable storage.");
  assert.ok(["completed", "paused", "awaiting_user", "partially_completed"].includes(recoveredTask.status), `Unexpected recovery state: ${recoveredTask.status}`);

  const settledInputs = await formPage.evaluate(() => window.__browserCrewFixture?.inputEvents || 0);
  await panel.waitForTimeout(700);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
  await panel.waitForTimeout(300);
  const afterRecovery = await formPage.evaluate(() => ({ inputs: window.__browserCrewFixture?.inputEvents || 0, submits: window.__browserCrewFixture?.submits || 0 }));
  assert.equal(afterRecovery.submits, 0, "Recovery must never submit the form.");
  assert.equal(afterRecovery.inputs, settledInputs, "Recovery must inspect the uncertain write instead of replaying it.");

  return {
    recoveryStatus: recoveredTask.status,
    checkpoint: recoveredTask.checkpoint,
    inputEventsBeforeWorkerRestart: beforeRestart.inputs,
    inputEventsAfterRecovery: afterRecovery.inputs,
    submits: afterRecovery.submits
  };
}

async function assertNoPageErrors(page, label) {
  const errors = [];
  const listener = (error) => errors.push(error.message);
  page.on("pageerror", listener);
  await page.waitForTimeout(250);
  page.off("pageerror", listener);
  assert.deepEqual(errors, [], `${label} emitted page errors: ${errors.join(" | ")}`);
}

async function waitForText(locator, text) {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

function createSignalBus() {
  const waiting = [];
  let pending = 0;
  return {
    signal() {
      const resolve = waiting.shift();
      if (resolve) resolve(); else pending += 1;
    },
    wait() {
      if (pending > 0) { pending -= 1; return Promise.resolve(); }
      return new Promise((resolve) => waiting.push(resolve));
    }
  };
}

async function startFixtureServer(signalBus) {
  const fixtures = new Set(["form.html", "supplier-a.html", "supplier-b.html", "supplier-c.html", "supplier-d.html", "supplier-e.html"]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/__input-signal") {
        signalBus.signal();
        response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        response.end();
        return;
      }
      const name = url.pathname.replace(/^\//, "");
      if (!fixtures.has(name)) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      let html = await readFile(join(repoRoot, "tests", "fixtures", name), "utf8");
      if (name === "form.html" && url.searchParams.get("crash") === "1") {
        const hook = `<script>document.addEventListener('input',()=>{fetch('/__input-signal').catch(()=>{});const end=Date.now()+1200;while(Date.now()<end){}},{once:true,capture:true});</script>`;
        html = html.replace("</body>", `${hook}</body>`);
      }
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
  const supplierValues = {
    "Atlas Packaging": { "Price": "$1.20 per box", "Minimum order": "100 units", "Lead time": "5 business days", "Shipping": "Free shipping over $500" },
    "Beacon Supply Co.": { "Price": "$1.05 per box", "Minimum order": "250 units", "Lead time": "3 business days", "Shipping": "Calculated at checkout" },
    "Cedar Wholesale": { "Price": "$1.45 per box", "Minimum order": "50 units", "Lead time": "10 business days", "Shipping": null },
    "Delta Cartons": { "Price": "$0.92 per box", "Minimum order": "500 units", "Lead time": "7 business days", "Shipping": "Freight quote required" },
    "Evergreen Mailers": { "Price": "$1.30 per box", "Minimum order": "150 units", "Lead time": null, "Shipping": "Flat rate $35" }
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

      if (/comparison facts/i.test(system)) {
        const schemaText = between(user, "Comparison criteria:\n", "\n\nPage title:");
        const criteria = JSON.parse(schemaText || "[]");
        const title = between(user, "Page title: ", "\nPage address:") || "";
        const values = supplierValues[title] || {};
        content = JSON.stringify({ values: criteria.map((criterion) => ({ criterionRef: criterion.ref, value: values[criterion.label] ?? null })) });
      } else if (/safe web-form fields/i.test(system)) {
        const details = between(user, "User-provided details:\n", "\n\nForm fields:") || "";
        const schema = JSON.parse(user.split("\n\nForm fields:\n")[1] || "[]");
        const supplied = parseDetails(details);
        const changes = [];
        for (const field of schema) {
          const key = `${field.label || ""} ${field.name || ""}`.toLowerCase();
          if (/name/.test(key) && supplied.name) changes.push({ ref: field.ref, value: supplied.name });
          else if (/email/.test(key) && supplied.email) changes.push({ ref: field.ref, value: supplied.email });
          else if (/message/.test(key) && supplied.message) changes.push({ ref: field.ref, value: supplied.message });
          else if (/reason|topic/.test(key) && supplied.reason) changes.push({ ref: field.ref, value: supplied.reason.toLowerCase() });
        }
        content = JSON.stringify({ changes, notes: "Mapped only user-provided fixture details." });
      }

      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({
        id: `smoke-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "browsercrew-smoke",
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

function parseDetails(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (/name/.test(key)) result.name = value;
    else if (/email/.test(key)) result.email = value;
    else if (/message/.test(key)) result.message = value;
    else if (/reason|topic/.test(key)) result.reason = value;
  }
  return result;
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
