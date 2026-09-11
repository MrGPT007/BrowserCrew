import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "record-smoke");
const timeoutMs = 35_000;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const signalBus = createSignalBus();
const fixtureServer = await startFixtureServer(signalBus);
const providerServer = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-record-"));
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
  pass("Installed extension connected to deterministic local provider for W4");

  const recordPage = await context.newPage();
  await recordPage.goto(`${fixtureServer.origin}/record.html`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePageFromPanel(panel, recordPage, "Supplier record SUP-1042");
  pass("User selected one exact record page before BrowserCrew planned a write");

  await runNormalRecordUpdate(panel, recordPage);
  pass("W4 previewed exact Before to After values and dispatched Save once after approval");

  const normalState = await recordPage.evaluate(() => ({
    status: document.querySelector("#status")?.value,
    owner: document.querySelector("#owner")?.value,
    notes: document.querySelector("#notes")?.value,
    saves: window.__browserCrewRecord?.saves,
    lastSaved: window.__browserCrewRecord?.lastSaved,
    receipt: document.querySelector("#saveReceipt")?.textContent
  }));
  assert.deepEqual({ status: normalState.status, owner: normalState.owner, notes: normalState.notes }, {
    status: "Paused",
    owner: "Priya Sharma",
    notes: "Review pricing in October."
  });
  assert.equal(normalState.saves, 1, "W4 normal approval must press Save exactly once.");
  assert.equal(normalState.lastSaved?.recordId, "SUP-1042");
  assert.match(normalState.receipt || "", /Saved SUP-1042 successfully/);
  assert.match(await panel.locator("#recordEvidenceBox").innerText(), /Saved SUP-1042 successfully/);
  pass("W4 verified the saved record with record identity, field values, and page save receipt");

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), "Priya Sharma");
  pass("Completed W4 record update remained inspectable in local History");

  const crashPage = await context.newPage();
  await crashPage.goto(`${fixtureServer.origin}/record.html?crash=1`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePageFromPanel(panel, crashPage, "Supplier record SUP-1042");
  await prepareRecordPreview(panel, [
    "Status: Archived",
    "Owner: Alex Rivera",
    "Notes: Contract ended."
  ].join("\n"));

  const saveSignal = withTimeout(signalBus.wait(), 12_000, "Timed out waiting for the W4 save action to reach the crash fixture.");
  await panel.locator("#approveRecordButton").click();
  await saveSignal;

  const cdp = await context.newCDPSession(panel);
  const targets = await cdp.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find((info) => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
  assert.ok(workerTarget?.targetId, "Could not find the BrowserCrew service worker for W4 recovery proof.");
  await cdp.send("Target.closeTarget", { targetId: workerTarget.targetId });
  await cdp.detach();

  await crashPage.waitForTimeout(1600);
  const afterInterruptedSave = await crashPage.evaluate(() => ({
    saves: window.__browserCrewRecord?.saves || 0,
    status: document.querySelector("#status")?.value || "",
    owner: document.querySelector("#owner")?.value || "",
    notes: document.querySelector("#notes")?.value || "",
    receipt: document.querySelector("#saveReceipt")?.textContent || ""
  }));
  assert.equal(afterInterruptedSave.saves, 1, "Interrupted W4 save should have been accepted exactly once by the fixture.");

  let recoveredTask;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
    recoveredTask = response?.tasks?.find((task) => task.kind === "record_update" && task.goal.includes("Alex Rivera"));
    if (recoveredTask && !["planning", "committing", "recovering"].includes(recoveredTask.status)) break;
    await panel.waitForTimeout(250);
  }
  assert.ok(recoveredTask, "W4 recovery task was not found in durable History.");
  assert.equal(recoveredTask.status, "completed", `Expected recovered W4 task to verify as completed, got ${recoveredTask.status}.`);
  assert.equal(recoveredTask.result?.evidence?.recovered, true, "Recovered W4 result must disclose recovery evidence.");

  const settledSaves = await crashPage.evaluate(() => window.__browserCrewRecord?.saves || 0);
  await panel.waitForTimeout(700);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
  await panel.waitForTimeout(300);
  const finalSaves = await crashPage.evaluate(() => window.__browserCrewRecord?.saves || 0);
  assert.equal(finalSaves, settledSaves, "W4 recovery must inspect the uncertain save instead of replaying it.");
  assert.equal(finalSaves, 1, "W4 recovery must never press Save twice.");
  pass("W4 service-worker recovery verified the uncertain save and did not replay it", {
    recoveryStatus: recoveredTask.status,
    checkpoint: recoveredTask.checkpoint,
    saves: finalSaves
  });

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), "Alex Rivera");
  pass("Recovered W4 task remained visible in local History");

  await panel.screenshot({ path: join(artifactDir, "record-history.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew W4 installed-extension smoke checks passed.");
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
  await panel.locator("#modelInput").fill("browsercrew-w4-smoke");
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

async function runNormalRecordUpdate(panel, recordPage) {
  await panel.bringToFront();
  const recordMode = panel.getByRole("radio", { name: /Update a record/ });
  await recordMode.waitFor({ state: "visible", timeout: timeoutMs });
  await recordMode.click();
  await panel.locator("#recordJobCard").waitFor({ state: "visible", timeout: timeoutMs });
  await prepareRecordPreview(panel, [
    "Status: Paused",
    "Owner: Priya Sharma",
    "Notes: Review pricing in October."
  ].join("\n"));

  const previewText = await panel.locator("#recordPreviewCard").innerText();
  for (const expected of ["Record SUP-1042", "Active", "Paused", "Maya Chen", "Priya Sharma", "Preferred lighting supplier.", "Review pricing in October."]) {
    assert.ok(previewText.includes(expected), `W4 preview is missing: ${expected}`);
  }
  assert.equal(await recordPage.evaluate(() => window.__browserCrewRecord?.saves || 0), 0, "Preview must not press Save.");

  await panel.locator("#approveRecordButton").click();
  await panel.locator("#recordResultCard").waitFor({ state: "visible", timeout: timeoutMs });
}

async function prepareRecordPreview(panel, details) {
  const recordMode = panel.getByRole("radio", { name: /Update a record/ });
  if ((await recordMode.getAttribute("aria-checked")) !== "true") await recordMode.click();
  await panel.locator("#recordJobCard").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#recordDetailsInput").fill(details);
  await panel.locator("#previewRecordButton").click();
  await panel.locator("#recordPreviewCard").waitFor({ state: "visible", timeout: timeoutMs });
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 350; attempt += 1) {
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
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/__record-save-signal") {
        signalBus.signal();
        response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        response.end();
        return;
      }
      if (url.pathname !== "/record.html") {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      let html = await readFile(join(repoRoot, "tests", "fixtures", "record.html"), "utf8");
      if (url.searchParams.get("crash") === "1") {
        const hook = `<script>document.addEventListener('submit',()=>{fetch('/__record-save-signal').catch(()=>{});const end=Date.now()+1200;while(Date.now()<end){}},{once:true,capture:true});</script>`;
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

      if (/existing web-app record/i.test(system)) {
        const details = between(user, "User-requested changes:\n", "\n\nEditable record fields:") || "";
        const fields = JSON.parse(user.split("\n\nEditable record fields:\n")[1] || "[]");
        const supplied = parseDetails(details);
        const changes = [];
        for (const field of fields) {
          const key = `${field.label || ""} ${field.name || ""}`.toLowerCase();
          if (/status/.test(key) && supplied.status) changes.push({ ref: field.ref, value: supplied.status });
          else if (/owner/.test(key) && supplied.owner) changes.push({ ref: field.ref, value: supplied.owner });
          else if (/notes?/.test(key) && supplied.notes) changes.push({ ref: field.ref, value: supplied.notes });
        }
        content = JSON.stringify({ changes, notes: "Mapped only values explicitly supplied by the user." });
      }

      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({
        id: `w4-smoke-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "browsercrew-w4-smoke",
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
    if (/status/.test(key)) result.status = value;
    else if (/owner/.test(key)) result.owner = value;
    else if (/notes?/.test(key)) result.notes = value;
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
