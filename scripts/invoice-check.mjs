import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const required = [
  "src/invoice-download.js",
  "src/invoice-ui.js",
  "scripts/invoice-smoke.mjs",
  "tests/fixtures/invoice-portal.html"
];

for (const file of required) await access(file);
for (const file of ["src/invoice-download.js", "src/invoice-ui.js", "scripts/invoice-smoke.mjs"]) {
  await execFileAsync(process.execPath, ["--check", file]);
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (!manifest.permissions?.includes("downloads")) throw new Error("W5 requires Chrome's downloads permission so completion can be verified instead of trusting a filename.");
for (const forbidden of ["cookies", "nativeMessaging", "debugger"]) {
  if (manifest.permissions?.includes(forbidden)) throw new Error(`W5 must not widen unrelated privileged permission: ${forbidden}`);
}

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./invoice-download.js"')) throw new Error("Service worker must load the W5 invoice download engine.");

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./invoice-ui.js"')) throw new Error("Workspace must load the W5 invoice UI.");

const engine = await readFile("src/invoice-download.js", "utf8");
for (const contract of [
  "MAX_INVOICES = 20",
  "invoice_collection",
  "invoice_download.intent",
  "invoice_download.dispatched",
  "chrome.downloads.download",
  "chrome.downloads.search",
  "chrome.downloads.onChanged",
  "reconcilePendingInvoiceTasks",
  "invoice_outcome_unknown",
  "BrowserCrew/Invoices/",
  "Chrome download complete + exact source URL + file exists + bytes received",
  "download.origin !== portal.origin",
  "bytesReceived > 0"
]) {
  if (!engine.includes(contract)) throw new Error(`Missing W5 invoice contract: ${contract}`);
}
for (const forbidden of ["chrome.cookies", "document.cookie", "eval(", "new Function("]) {
  if (engine.includes(forbidden)) throw new Error(`W5 invoice engine must not contain: ${forbidden}`);
}
const dispatchCalls = engine.match(/chrome\.downloads\.download\(/g) || [];
if (dispatchCalls.length !== 1) throw new Error("W5 must have one narrowly scoped Chrome download dispatch primitive.");

const ui = await readFile("src/invoice-ui.js", "utf8");
for (const contract of [
  'data-job-mode="invoice"',
  "Collect invoices",
  "Show invoices from this page",
  "Download selected invoices",
  "BrowserCrew/Invoices",
  "This does not edit the account, pay an invoice, or contact anyone",
  "A filename alone is never treated as proof"
]) {
  if (!ui.includes(contract)) throw new Error(`Missing Grandma-proof W5 UI contract: ${contract}`);
}

const fixture = await readFile("tests/fixtures/invoice-portal.html", "utf8");
for (const contract of [
  "data-browsercrew-invoice-portal",
  'data-account-id="ACCT-7788"',
  'data-account-label="Northstar Office LLC"',
  "data-browsercrew-invoice-download",
  "INV-2026-001",
  "INV-2026-004",
  "?slow=1"
]) {
  if (!fixture.includes(contract)) throw new Error(`Missing W5 controlled fixture proof: ${contract}`);
}
const invoiceRows = fixture.match(/data-browsercrew-invoice data-invoice-id=/g) || [];
if (invoiceRows.length !== 4) throw new Error("W5 controlled portal must expose exactly four invoice records for selection tests.");

const permissionsDoc = await readFile("docs/PERMISSIONS.md", "utf8");
for (const disclosure of ["`downloads`", "filenames alone", "positive received bytes", "will not automatically create a duplicate"]) {
  if (!permissionsDoc.includes(disclosure)) throw new Error(`W5 downloads permission disclosure is incomplete: ${disclosure}`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (!String(pkg.scripts?.check || "").includes("invoice-check.mjs")) throw new Error("npm check must include W5 invoice contracts.");
if (pkg.scripts?.["invoice-smoke"] !== "node scripts/invoice-smoke.mjs") throw new Error("W5 installed-extension smoke script must stay wired in package.json.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run invoice-smoke")) throw new Error("Quality CI must execute the W5 installed-extension smoke test.");

const smoke = await readFile("scripts/invoice-smoke.mjs", "utf8");
for (const proof of [
  "downloaded only the two selected invoices",
  "Unselected INV-2026-002 must not be requested",
  "browsercrew.invoice_manifest",
  "Target.closeTarget",
  "W5 recovery must inspect the existing Chrome download instead of starting a duplicate",
  "requestCounts.get(\"INV-2026-004\") || 0, 1"
]) {
  if (!smoke.includes(proof)) throw new Error(`Missing W5 browser proof: ${proof}`);
}

console.log("BrowserCrew W5 invoice-download checks passed.");
