import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "invoice-smoke");
const timeoutMs = 40_000;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const slowBus = createSignalBus();
const requestCounts = new Map();
const fixtureServer = await startFixtureServer(slowBus, requestCounts);
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-invoice-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), fixtureOrigin: fixtureServer.origin, checks: [] };

try {
  await prepareTestExtension(extensionDir, [fixtureServer.origin]);
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
  await panel.getByRole("tab", { name: "Workspace" }).click();

  const portalPage = await context.newPage();
  await portalPage.goto(`${fixtureServer.origin}/invoice-portal.html`);
  await selectActivePageFromPanel(panel, portalPage, "Northstar Office invoice portal");
  pass("User selected the exact invoice portal page");

  await openInvoiceMode(panel);
  await panel.locator("#loadInvoicesButton").click();
  await panel.locator("#invoiceChoiceList").waitFor({ state: "visible", timeout: timeoutMs });
  const accountText = await panel.locator("#invoiceAccountBox").innerText();
  assert.match(accountText, /Northstar Office LLC/);
  assert.match(accountText, /ACCT-7788/);
  assert.equal(await panel.locator('#invoiceChoiceList input[data-invoice-id]').count(), 4);
  pass("W5 confirmed account identity and exposed four bounded invoice records");

  await panel.locator('input[data-invoice-id="INV-2026-001"]').check();
  await panel.locator('input[data-invoice-id="INV-2026-003"]').check();
  await panel.locator("#runInvoiceButton").click();
  await panel.locator("#invoiceResultCard").waitFor({ state: "visible", timeout: timeoutMs });

  const normalTask = await findTask(panel, (task) => task.kind === "invoice_collection" && task.selectedInvoices?.some((item) => item.id === "INV-2026-001"));
  assert.ok(normalTask, "Normal W5 task was not found in durable storage.");
  assert.equal(normalTask.status, "completed");
  assert.equal(normalTask.result?.selectedCount, 2);
  assert.equal(normalTask.result?.verifiedCount, 2);
  assert.equal(normalTask.result?.entries?.length, 2);
  for (const entry of normalTask.result.entries) {
    assert.equal(entry.verified, true, `${entry.invoiceId} was not verified.`);
    assert.equal(entry.state, "complete", `${entry.invoiceId} did not reach Chrome complete state.`);
    assert.ok(entry.bytesReceived > 0, `${entry.invoiceId} did not record received bytes.`);
    assert.ok(entry.filename?.includes("BrowserCrew/Invoices") || entry.filename?.includes("BrowserCrew\\Invoices"), `${entry.invoiceId} was not stored under the BrowserCrew invoice folder.`);
    assert.ok(entry.finalUrl === entry.downloadUrl, `${entry.invoiceId} final URL does not match its selected source URL.`);
    assert.match(entry.verificationMethod || "", /Chrome download complete/);
  }
  assert.equal(requestCounts.get("INV-2026-001") || 0, 1);
  assert.equal(requestCounts.get("INV-2026-003") || 0, 1);
  assert.equal(requestCounts.get("INV-2026-002") || 0, 0, "Unselected INV-2026-002 must not be requested.");
  assert.equal(requestCounts.get("INV-2026-004") || 0, 0, "Unselected INV-2026-004 must not be requested in the normal job.");
  pass("W5 downloaded only the two selected invoices and verified Chrome completion, URL, existence, and bytes");

  const manifestDownloadPromise = panel.waitForEvent("download", { timeout: timeoutMs });
  await panel.locator("#downloadInvoiceManifestButton").click();
  const manifestDownload = await manifestDownloadPromise;
  const manifestPath = await manifestDownload.path();
  assert.ok(manifestPath, "Manifest JSON download did not produce a file.");
  const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifestJson.kind, "browsercrew.invoice_manifest");
  assert.equal(manifestJson.account?.id, "ACCT-7788");
  assert.equal(manifestJson.entries?.length, 2);
  assert.deepEqual(manifestJson.entries.map((entry) => entry.invoiceId).sort(), ["INV-2026-001", "INV-2026-003"]);
  pass("W5 exported a JSON manifest linking verified files to invoice records and source URLs");

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), "Northstar Office LLC");
  pass("Completed W5 collection remained inspectable in local History");

  const crashPortal = await context.newPage();
  await crashPortal.goto(`${fixtureServer.origin}/invoice-portal.html?crash=1`);
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePageFromPanel(panel, crashPortal, "Northstar Office invoice portal");
  await openInvoiceMode(panel);
  await panel.locator("#loadInvoicesButton").click();
  await panel.locator("#invoiceChoiceList").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator('input[data-invoice-id="INV-2026-004"]').check();

  const slowSignal = withTimeout(slowBus.wait(), 15_000, "Timed out waiting for the slow invoice download request.");
  await panel.locator("#runInvoiceButton").click();
  await slowSignal;

  const cdp = await context.newCDPSession(panel);
  const targets = await cdp.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find((info) => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
  assert.ok(workerTarget?.targetId, "Could not find the BrowserCrew service worker for W5 recovery proof.");
  await cdp.send("Target.closeTarget", { targetId: workerTarget.targetId });
  await cdp.detach();

  await crashPortal.waitForTimeout(2200);
  let recoveredTask;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
    recoveredTask = response?.tasks?.find((task) => task.kind === "invoice_collection" && task.selectedInvoices?.some((item) => item.id === "INV-2026-004"));
    if (recoveredTask && !["running", "recovering"].includes(recoveredTask.status)) break;
    await panel.waitForTimeout(250);
  }
  assert.ok(recoveredTask, "Recovered W5 task was not found in durable storage.");
  assert.equal(recoveredTask.status, "completed", `Expected recovered W5 task to complete, got ${recoveredTask.status}.`);
  assert.equal(recoveredTask.result?.recovered, true, "Recovered W5 result must disclose recovery evidence.");
  assert.equal(recoveredTask.result?.verifiedCount, 1);
  assert.equal(recoveredTask.result?.entries?.[0]?.invoiceId, "INV-2026-004");
  assert.equal(recoveredTask.result?.entries?.[0]?.verified, true);
  assert.equal(requestCounts.get("INV-2026-004") || 0, 1, "The interrupted invoice must be requested exactly once.");

  await panel.waitForTimeout(800);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
  await panel.waitForTimeout(300);
  assert.equal(requestCounts.get("INV-2026-004") || 0, 1, "W5 recovery must inspect the existing Chrome download instead of starting a duplicate.");
  pass("W5 service-worker recovery reconciled the existing Chrome download and did not request a duplicate", {
    status: recoveredTask.status,
    checkpoint: recoveredTask.checkpoint,
    requests: requestCounts.get("INV-2026-004") || 0
  });

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), "1 selected invoice");
  pass("Recovered W5 collection remained visible in local History");

  await panel.screenshot({ path: join(artifactDir, "invoice-history.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.requestCounts = Object.fromEntries(requestCounts);
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew W5 installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.requestCounts = Object.fromEntries(requestCounts);
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixtureServer.close();
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

async function selectActivePageFromPanel(panel, targetPage, expectedTitle) {
  await targetPage.bringToFront();
  await panel.evaluate(() => document.querySelector("#selectTabButton")?.click());
  await waitForText(panel.locator("#selectedTabSummary"), expectedTitle);
  assert.equal(await panel.locator("#pageStatus").getAttribute("data-state"), "ok");
}

async function openInvoiceMode(panel) {
  await panel.bringToFront();
  const mode = panel.getByRole("radio", { name: /Collect invoices/ });
  await mode.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await mode.getAttribute("aria-checked")) !== "true") await mode.click();
  await panel.locator("#invoiceJobCard").waitFor({ state: "visible", timeout: timeoutMs });
}

async function findTask(panel, predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
    const task = response?.tasks?.find(predicate);
    if (task) return task;
    await panel.waitForTimeout(150);
  }
  return null;
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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

async function startFixtureServer(slowBus, counts) {
  const portalHtml = await readFile(join(repoRoot, "tests", "fixtures", "invoice-portal.html"), "utf8");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/invoice-portal.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(portalHtml);
        return;
      }
      const match = url.pathname.match(/^\/invoices\/(INV-2026-00[1-4])\.pdf$/);
      if (!match) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      const invoiceId = match[1];
      counts.set(invoiceId, (counts.get(invoiceId) || 0) + 1);
      const pdf = Buffer.from(`%PDF-1.4\n% BrowserCrew controlled invoice ${invoiceId}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`, "utf8");
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoiceId}.pdf"`,
        "Content-Length": pdf.length,
        "Cache-Control": "no-store"
      });
      if (url.searchParams.get("slow") === "1") {
        response.write(pdf.subarray(0, Math.max(1, Math.floor(pdf.length / 2))));
        slowBus.signal();
        await new Promise((resolve) => setTimeout(resolve, 1600));
        response.end(pdf.subarray(Math.max(1, Math.floor(pdf.length / 2))));
      } else {
        response.end(pdf);
      }
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error?.message || "Fixture server error");
    }
  });
  return listen(server);
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
