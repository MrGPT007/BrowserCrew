import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "w2-w4-w5-adversarial");
const timeoutMs = 35_000;
const report = { startedAt: new Date().toISOString(), checks: [] };
const providerModel = "browsercrew-final-adversarial";

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const foreign = await startForeignServer();
const app = await startAppServer(foreign.origin);
const provider = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-w2-w4-w5-adversarial-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;

try {
  await prepareTestExtension(extensionDir, [app.origin, foreign.origin, provider.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;
  report.appOrigin = app.origin;
  report.foreignOrigin = foreign.origin;
  report.providerOrigin = provider.origin;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // W2-03: cross-origin pagination must stop before navigation.
  const crossDirectory = await context.newPage();
  await crossDirectory.goto(`${app.origin}/w2-cross.html`);
  const crossDirectoryTab = await tabResource(panel, crossDirectory);
  const crossDirectoryResult = await runDirectory(panel, crossDirectoryTab, 3, provider.origin);
  assert.equal(crossDirectoryResult?.ok, false);
  assert.equal(crossDirectoryResult?.task?.status, "failed");
  assert.equal(crossDirectoryResult?.task?.error?.code, "DIRECTORY_LEFT_SITE");
  assert.equal(foreign.state.directoryHits, 0, "W2 must not navigate to the cross-origin Next page.");
  assert.equal(crossDirectory.url(), `${app.origin}/w2-cross.html`);
  pass("W2-03 blocked cross-origin pagination before navigating to another origin", {
    error: crossDirectoryResult.task.error,
    foreignDirectoryHits: foreign.state.directoryHits
  });

  // W2-04: configured page limit must stop traversal and disclose the boundary.
  const boundedDirectory = await context.newPage();
  await boundedDirectory.goto(`${app.origin}/w2-limit-1.html`);
  const boundedTab = await tabResource(panel, boundedDirectory);
  const boundedResult = await runDirectory(panel, boundedTab, 2, provider.origin);
  assert.equal(boundedResult?.ok, true);
  assert.equal(boundedResult?.task?.status, "completed");
  assert.equal(boundedResult?.task?.result?.pageCount, 2);
  assert.equal(boundedResult?.task?.result?.pageLimit, 2);
  assert.equal(boundedResult?.task?.result?.pageLimitReached, true);
  assert.equal(boundedResult?.task?.result?.evidence?.pageLimitReached, true);
  assert.equal(boundedResult?.task?.result?.sourceUrls?.length, 2);
  assert.equal(app.state.w2Page3Hits, 0, "W2 must not load page 3 after the configured page cap.");
  assert.equal(boundedDirectory.url(), `${app.origin}/w2-limit-2.html`);
  pass("W2-04 stopped at the configured page limit and disclosed pageLimitReached", {
    pageCount: boundedResult.task.result.pageCount,
    pageLimit: boundedResult.task.result.pageLimit,
    pageLimitReached: boundedResult.task.result.pageLimitReached,
    page3Hits: app.state.w2Page3Hits
  });

  // W4-02: selected record URL changes after preview.
  const wrongRecord = await context.newPage();
  await wrongRecord.goto(`${app.origin}/record-a.html`);
  const wrongRecordTab = await tabResource(panel, wrongRecord);
  const wrongPreview = await previewRecord(panel, wrongRecordTab, "Owner: Jordan Patel", provider.origin);
  assert.equal(wrongPreview?.ok, true);
  const wrongBaselineSaves = app.state.recordSaves;
  await wrongRecord.goto(`${app.origin}/record-b.html`);
  const wrongCommit = await commitRecord(panel, wrongPreview.task.id, wrongPreview.task.recordPlan.changeHash);
  assert.equal(wrongCommit?.ok, false);
  assert.equal(wrongCommit?.error?.code, "PAGE_CHANGED");
  await delay(150);
  assert.equal(app.state.recordSaves, wrongBaselineSaves, "W4 wrong-resource rejection must dispatch zero saves.");
  pass("W4-02 blocked commit after the selected record URL changed and performed zero saves", {
    error: wrongCommit.error,
    saves: app.state.recordSaves - wrongBaselineSaves
  });

  // W4-03: approved before-value changes after preview.
  const staleRecord = await context.newPage();
  await staleRecord.goto(`${app.origin}/record-stale.html`);
  const staleRecordTab = await tabResource(panel, staleRecord);
  const stalePreview = await previewRecord(panel, staleRecordTab, "Owner: Priya Sharma", provider.origin);
  assert.equal(stalePreview?.ok, true);
  const staleBaselineSaves = app.state.recordSaves;
  await staleRecord.locator("#owner").fill("Changed outside BrowserCrew");
  const staleCommit = await commitRecord(panel, stalePreview.task.id, stalePreview.task.recordPlan.changeHash);
  assert.equal(staleCommit?.ok, false);
  assert.equal(staleCommit?.error?.code, "RECORD_CHANGED");
  assert.equal(staleCommit?.task?.status, "awaiting_user");
  assert.equal(await staleRecord.locator("#owner").inputValue(), "Changed outside BrowserCrew");
  await delay(150);
  assert.equal(app.state.recordSaves, staleBaselineSaves, "W4 stale-before rejection must dispatch zero saves.");
  pass("W4-03 blocked a stale before-value and performed zero saves", {
    error: staleCommit.error,
    saves: app.state.recordSaves - staleBaselineSaves
  });

  // W4-05: Save is dispatched once, values stick, but independent receipt verification does not advance.
  const unknownRecord = await context.newPage();
  await unknownRecord.goto(`${app.origin}/record-unverified.html`);
  const unknownTab = await tabResource(panel, unknownRecord);
  const unknownPreview = await previewRecord(panel, unknownTab, "Owner: Casey Morgan", provider.origin);
  assert.equal(unknownPreview?.ok, true);
  const unknownBaselineSaves = app.state.recordSaves;
  const unknownCommit = await commitRecord(panel, unknownPreview.task.id, unknownPreview.task.recordPlan.changeHash);
  assert.equal(unknownCommit?.ok, false);
  assert.equal(unknownCommit?.error?.code, "RECORD_SAVE_UNVERIFIED");
  assert.equal(unknownCommit?.task?.status, "partially_completed");
  assert.equal(unknownCommit?.task?.checkpoint, "record_save_unverified");
  assert.equal(unknownCommit?.task?.result?.evidence?.saveReceipt?.verified, false);
  assert.equal(await unknownRecord.locator("#owner").inputValue(), "Casey Morgan");
  await waitUntil(() => app.state.recordSaves === unknownBaselineSaves + 1, 3000, () => JSON.stringify(app.state));
  await delay(500);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TASKS" }).catch(() => null));
  await delay(250);
  assert.equal(app.state.recordSaves, unknownBaselineSaves + 1, "W4 must never replay an unverified Save automatically.");
  pass("W4-05 marked the Save outcome unverified and did not replay Save", {
    status: unknownCommit.task.status,
    checkpoint: unknownCommit.task.checkpoint,
    error: unknownCommit.error,
    saves: app.state.recordSaves - unknownBaselineSaves
  });

  // W5-02: cross-origin PDFs are excluded from the approved invoice set and never dispatched.
  const crossInvoice = await context.newPage();
  await crossInvoice.goto(`${app.origin}/invoice-cross.html`);
  const crossInvoiceTab = await tabResource(panel, crossInvoice);
  const crossList = await listInvoices(panel, crossInvoiceTab);
  assert.equal(crossList?.ok, true);
  assert.ok(crossList.portal.invoices.some((invoice) => invoice.id === "SAFE-001"));
  assert.equal(crossList.portal.invoices.some((invoice) => invoice.id === "CROSS-001"), false);
  const crossRun = await runInvoices(panel, crossInvoiceTab, ["CROSS-001"]);
  assert.equal(crossRun?.type, "INVOICE_ERROR");
  assert.equal(crossRun?.error?.code, "INVOICE_SELECTION_CHANGED");
  assert.equal(foreign.state.pdfHits, 0, "W5 must not dispatch a cross-origin PDF.");
  pass("W5-02 excluded a cross-origin invoice and dispatched zero cross-origin downloads", {
    listedInvoices: crossList.portal.invoices.map((invoice) => invoice.id),
    error: crossRun.error,
    foreignPdfHits: foreign.state.pdfHits
  });

  // W5-03: a browser-level interruption stays failed/unverified.
  const interruptedInvoice = await context.newPage();
  await interruptedInvoice.goto(`${app.origin}/invoice-interrupt.html`);
  const interruptedTab = await tabResource(panel, interruptedInvoice);
  const interruptedList = await listInvoices(panel, interruptedTab);
  assert.equal(interruptedList?.ok, true);
  assert.equal(interruptedList.portal.invoices.length, 1);
  const interruptedRunPromise = runInvoices(panel, interruptedTab, ["INT-001"]);
  const activeDownload = await waitForDownload(panel, `${app.origin}/pdf/interrupt.pdf`);
  await panel.evaluate((id) => chrome.downloads.cancel(id), activeDownload.id);
  const interruptedRun = await interruptedRunPromise;
  assert.equal(interruptedRun?.type, "INVOICE_DONE");
  assert.equal(interruptedRun?.ok, false);
  assert.equal(interruptedRun?.error?.code, "DOWNLOAD_INTERRUPTED");
  assert.equal(interruptedRun?.task?.status, "failed");
  assert.equal(interruptedRun?.task?.result?.verifiedCount, 0);
  assert.ok(interruptedRun?.task?.manifest?.every((entry) => entry.verified === false));
  pass("W5-03 preserved interrupted-download failure evidence without verified completion", {
    error: interruptedRun.error,
    status: interruptedRun.task.status,
    verifiedCount: interruptedRun.task.result.verifiedCount,
    manifest: interruptedRun.task.manifest
  });

  // W5-05: selected invoice disappears between listing and Run.
  const staleInvoice = await context.newPage();
  await staleInvoice.goto(`${app.origin}/invoice-stale.html`);
  const staleInvoiceTab = await tabResource(panel, staleInvoice);
  const staleList = await listInvoices(panel, staleInvoiceTab);
  assert.equal(staleList?.ok, true);
  assert.ok(staleList.portal.invoices.some((invoice) => invoice.id === "STALE-001"));
  const stalePdfBaseline = app.state.pdfHits;
  await staleInvoice.evaluate(() => document.querySelector('[data-invoice-id="STALE-001"]')?.remove());
  const staleInvoiceRun = await runInvoices(panel, staleInvoiceTab, ["STALE-001"]);
  assert.equal(staleInvoiceRun?.type, "INVOICE_ERROR");
  assert.equal(staleInvoiceRun?.error?.code, "INVOICE_SELECTION_CHANGED");
  await delay(150);
  assert.equal(app.state.pdfHits, stalePdfBaseline, "W5 stale selection must dispatch zero downloads.");
  pass("W5-05 blocked a stale invoice selection and dispatched zero downloads", {
    error: staleInvoiceRun.error,
    dispatchedDownloads: app.state.pdfHits - stalePdfBaseline
  });

  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.appState = { ...app.state };
  report.foreignState = { ...foreign.state };
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("BrowserCrew W2/W4/W5 adversarial installed-extension checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  report.appState = { ...app.state };
  report.foreignState = { ...foreign.state };
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await app.close();
  await foreign.close();
  await provider.close();
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
      return ![".git", "node_modules", "artifacts"].includes(relative.split(/[/\\]/)[0]);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function tabResource(panel, page) {
  const url = page.url();
  return panel.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url === expectedUrl);
    if (!tab?.id) throw new Error(`Could not resolve fixture tab: ${expectedUrl}`);
    return { id: tab.id, title: tab.title || "Untitled page", url: tab.url };
  }, url);
}

async function runDirectory(panel, tab, pageLimit, providerOrigin) {
  return portRequest(panel, "browsercrew-directory-extract", {
    type: "RUN_DIRECTORY_TASK",
    payload: {
      tab,
      columns: ["Company"],
      dedupeKey: "Company",
      pageLimit,
      settings: { kind: "lmstudio", model: providerModel, baseUrl: `${providerOrigin}/v1` },
      secret: ""
    }
  }, ["DIRECTORY_DONE"]);
}

async function previewRecord(panel, tab, details, providerOrigin) {
  return portRequest(panel, "browsercrew-record-update", {
    type: "PREVIEW_RECORD_TASK",
    payload: {
      tab,
      details,
      settings: { kind: "lmstudio", model: providerModel, baseUrl: `${providerOrigin}/v1` },
      secret: ""
    }
  });
}

async function commitRecord(panel, taskId, approvedChangeHash) {
  return portRequest(panel, "browsercrew-record-update", {
    type: "COMMIT_RECORD_TASK",
    taskId,
    approvedChangeHash
  });
}

async function listInvoices(panel, tab) {
  return portRequest(panel, "browsercrew-invoice-download", { type: "LIST_INVOICES", tab }, ["INVOICE_LIST", "INVOICE_ERROR"]);
}

async function runInvoices(panel, tab, invoiceIds) {
  return portRequest(panel, "browsercrew-invoice-download", {
    type: "RUN_INVOICE_TASK",
    payload: { tab, invoiceIds }
  }, ["INVOICE_DONE", "INVOICE_ERROR"]);
}

async function portRequest(panel, portName, message, expectedTypes = []) {
  return panel.evaluate(({ portName, message, expectedTypes }) => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: portName });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(value);
    };
    port.onMessage.addListener((response) => {
      if (!expectedTypes.length || expectedTypes.includes(response?.type)) finish(response);
    });
    port.onDisconnect.addListener(() => {
      if (!settled) finish({ ok: false, error: { code: "PORT_DISCONNECTED", message: "Runtime port disconnected." } });
    });
    port.postMessage(message);
  }), { portName, message, expectedTypes });
}

async function waitForDownload(panel, url) {
  let latest = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    latest = await panel.evaluate(async (expectedUrl) => {
      const items = await chrome.downloads.search({ limit: 100, orderBy: ["-startTime"] });
      return items.find((item) => item.url === expectedUrl || item.finalUrl === expectedUrl) || null;
    }, url);
    if (latest?.state === "in_progress") return latest;
    await panel.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for in-progress download: ${url} :: ${JSON.stringify(latest)}`);
}

async function waitUntil(predicate, timeout, describe) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for condition. State: ${describe()}`);
}

async function startForeignServer() {
  const state = { directoryHits: 0, pdfHits: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/w2-foreign.html") {
      state.directoryHits += 1;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(directoryHtml("Foreign Directory", "Should Never Load", null));
      return;
    }
    if (url.pathname === "/foreign.pdf") {
      state.pdfHits += 1;
      const pdf = minimalPdf("CROSS-001");
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(pdf.length) });
      response.end(pdf);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const bound = await listen(server);
  return { ...bound, state };
}

async function startAppServer(foreignOrigin) {
  const state = { w2Page3Hits: 0, recordSaves: 0, pdfHits: 0, interruptPdfHits: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__record-save") {
      state.recordSaves += 1;
      response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      response.end();
      return;
    }
    if (url.pathname === "/w2-cross.html") {
      return html(response, directoryHtml("Cross Origin Directory", "Cross Alpha", `${foreignOrigin}/w2-foreign.html`));
    }
    if (url.pathname === "/w2-limit-1.html") {
      return html(response, directoryHtml("Bounded Directory 1", "Limit One", "/w2-limit-2.html"));
    }
    if (url.pathname === "/w2-limit-2.html") {
      return html(response, directoryHtml("Bounded Directory 2", "Limit Two", "/w2-limit-3.html"));
    }
    if (url.pathname === "/w2-limit-3.html") {
      state.w2Page3Hits += 1;
      return html(response, directoryHtml("Bounded Directory 3", "Limit Three", null));
    }
    if (url.pathname === "/record-a.html") return html(response, recordHtml("REC-A", "normal"));
    if (url.pathname === "/record-b.html") return html(response, recordHtml("REC-B", "normal"));
    if (url.pathname === "/record-stale.html") return html(response, recordHtml("REC-STALE", "normal"));
    if (url.pathname === "/record-unverified.html") return html(response, recordHtml("REC-UNKNOWN", "unverified"));
    if (url.pathname === "/invoice-cross.html") {
      return html(response, invoicePortalHtml("ACCT-CROSS", [
        invoice("SAFE-001", "/pdf/safe-001.pdf"),
        invoice("CROSS-001", `${foreignOrigin}/foreign.pdf`)
      ]));
    }
    if (url.pathname === "/invoice-interrupt.html") {
      return html(response, invoicePortalHtml("ACCT-INT", [invoice("INT-001", "/pdf/interrupt.pdf")]));
    }
    if (url.pathname === "/invoice-stale.html") {
      return html(response, invoicePortalHtml("ACCT-STALE", [invoice("STALE-001", "/pdf/stale-001.pdf")]));
    }
    if (url.pathname.startsWith("/pdf/")) {
      state.pdfHits += 1;
      if (url.pathname === "/pdf/interrupt.pdf") {
        state.interruptPdfHits += 1;
        const first = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Length": String(first.length + 1024 * 1024)
        });
        response.write(first);
        const timer = setTimeout(() => {
          if (!response.destroyed) response.end(Buffer.alloc(1024 * 1024));
        }, 15_000);
        response.on("close", () => clearTimeout(timer));
        return;
      }
      const pdf = minimalPdf(url.pathname);
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(pdf.length) });
      response.end(pdf);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const bound = await listen(server);
  return { ...bound, state };
}

async function startProviderServer() {
  const directoryRows = {
    "Cross Origin Directory": [{ Company: "Cross Alpha" }],
    "Bounded Directory 1": [{ Company: "Limit One" }],
    "Bounded Directory 2": [{ Company: "Limit Two" }],
    "Bounded Directory 3": [{ Company: "Limit Three" }]
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
        const rows = directoryRows[title] || [];
        content = JSON.stringify({
          rows: rows.map((row) => ({
            values: Object.fromEntries(schema.map((column) => [column.ref, row[column.label] ?? null]))
          }))
        });
      } else if (/existing web-app record/i.test(system)) {
        const details = between(user, "User-requested changes:\n", "\n\nEditable record fields:") || "";
        const fields = JSON.parse(user.split("\n\nEditable record fields:\n")[1] || "[]");
        const supplied = parseDetails(details);
        const changes = [];
        for (const field of fields) {
          const key = `${field.label || ""} ${field.name || ""}`.toLowerCase();
          if (/owner/.test(key) && supplied.owner) changes.push({ ref: field.ref, value: supplied.owner });
          else if (/status/.test(key) && supplied.status) changes.push({ ref: field.ref, value: supplied.status });
          else if (/notes?/.test(key) && supplied.notes) changes.push({ ref: field.ref, value: supplied.notes });
        }
        content = JSON.stringify({ changes, notes: "Mapped only explicit fixture details." });
      }

      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({
        id: `final-adversarial-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || providerModel,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: error?.message || "Provider fixture failed" } }));
    }
  });
  return listen(server);
}

function directoryHtml(title, company, nextUrl) {
  const next = nextUrl ? `<nav><a rel="next" href="${escapeHtml(nextUrl)}">Next</a></nav>` : "";
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><article><h2>${escapeHtml(company)}</h2><p>Company: ${escapeHtml(company)}</p></article>${next}</main></body></html>`;
}

function recordHtml(recordId, mode) {
  return `<!doctype html><html><head><title>Record ${escapeHtml(recordId)}</title></head><body><main>
<form id="recordForm" data-browsercrew-record-id="${escapeHtml(recordId)}">
<label>Status<select id="status" name="status"><option selected>Active</option><option>Paused</option><option>Archived</option></select></label>
<label>Owner<input id="owner" name="owner" value="Maya Chen"></label>
<label>Notes<textarea id="notes" name="notes">Existing note.</textarea></label>
<button type="submit" data-browsercrew-record-save>Save changes</button>
</form>
<output id="receipt" data-browsercrew-record-receipt data-save-count="0">No saved changes yet</output>
</main><script>
window.__recordMode=${JSON.stringify(mode)};
document.querySelector("#recordForm").addEventListener("submit",(event)=>{
  event.preventDefault();
  fetch("/__record-save").catch(()=>{});
  if(window.__recordMode==="normal"){
    const receipt=document.querySelector("#receipt");
    const count=Number(receipt.dataset.saveCount||"0")+1;
    receipt.dataset.saveCount=String(count);
    receipt.textContent="Saved ${escapeJs(recordId)} successfully · save "+count;
  }
});
</script></body></html>`;
}

function invoicePortalHtml(accountId, invoices) {
  const rows = invoices.map((item) => `<div data-browsercrew-invoice data-invoice-id="${escapeHtml(item.id)}" data-invoice-label="Invoice ${escapeHtml(item.id)}" data-invoice-date="2026-09-01" data-invoice-amount="$10.00"><span>${escapeHtml(item.id)}</span><a data-browsercrew-invoice-download href="${escapeHtml(item.href)}">Download PDF</a></div>`).join("");
  return `<!doctype html><html><head><title>Invoice portal ${escapeHtml(accountId)}</title></head><body><main data-browsercrew-invoice-portal data-account-id="${escapeHtml(accountId)}" data-account-label="${escapeHtml(accountId)}">${rows}</main></body></html>`;
}

function invoice(id, href) { return { id, href }; }

function minimalPdf(label) {
  return Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}

function parseDetails(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1].trim().toLowerCase()] = match[2].trim();
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

function html(response, body) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeJs(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
