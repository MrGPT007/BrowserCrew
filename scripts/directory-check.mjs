import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const required = [
  "src/directory-extract.js",
  "src/directory-ui.js",
  "scripts/directory-smoke.mjs",
  "tests/fixtures/directory-page-1.html",
  "tests/fixtures/directory-page-2.html",
  "tests/fixtures/directory-page-3.html"
];

for (const file of required) await access(file);
for (const file of ["src/directory-extract.js", "src/directory-ui.js", "scripts/directory-smoke.mjs"]) {
  await execFileAsync(process.execPath, ["--check", file]);
}

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./directory-extract.js"')) {
  throw new Error("Service worker must load the W2 directory extraction engine.");
}

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./directory-ui.js"')) {
  throw new Error("Side panel must load the W2 directory workspace UI.");
}

const engine = await readFile("src/directory-extract.js", "utf8");
for (const contract of [
  "MAX_DIRECTORY_PAGES = 10",
  "MAX_DIRECTORY_COLUMNS = 12",
  "directory_extract",
  "DIRECTORY_CANCELLED",
  "pageLimitReached",
  "sourceUrls",
  "explainAndDedupeRows",
  "verificationMethod"
]) {
  if (!engine.includes(contract)) throw new Error(`Missing W2 directory contract: ${contract}`);
}
for (const forbidden of [".submit(", "requestSubmit(", "dispatchEvent(", "chrome.cookies", "document.cookie", "chrome.downloads"]) {
  if (engine.includes(forbidden)) throw new Error(`W2 read-only engine must not contain: ${forbidden}`);
}

const ui = await readFile("src/directory-ui.js", "utf8");
for (const contract of [
  'data-job-mode="directory"',
  "Extract this directory",
  "Download safe CSV",
  "Download JSON",
  "neutralizeSpreadsheetCell",
  "_source_url",
  "_duplicate_status"
]) {
  if (!ui.includes(contract)) throw new Error(`Missing W2 directory UI/export contract: ${contract}`);
}
if (!ui.includes('/^[\\t\\r ]*[=+\\-@]/')) {
  throw new Error("CSV export must neutralize common spreadsheet formula prefixes.");
}

const page1 = await readFile("tests/fixtures/directory-page-1.html", "utf8");
const page2 = await readFile("tests/fixtures/directory-page-2.html", "utf8");
const page3 = await readFile("tests/fixtures/directory-page-3.html", "utf8");
if (!page1.includes('rel="next"') || !page2.includes('rel="next"') || page3.includes('rel="next"')) {
  throw new Error("Directory fixtures must exercise bounded same-site pagination across exactly three pages.");
}
if (!page1.includes("=2+3") || !page2.includes("@priority") || !page3.includes("+SUM(1,1)")) {
  throw new Error("Directory fixtures must exercise spreadsheet formula-injection neutralization.");
}
if (!page1.includes("Alpha Components") || !page2.includes("Alpha Components")) {
  throw new Error("Directory fixtures must contain an exact duplicate.");
}
if (!page1.includes("+91 120 555 0103") || !page3.includes("+91 120 555 9999")) {
  throw new Error("Directory fixtures must contain a conflicting duplicate.");
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (!String(pkg.scripts?.check || "").includes("directory-check.mjs")) throw new Error("npm check must include W2 contracts.");
if (!pkg.scripts?.["directory-smoke"]) throw new Error("W2 must have an installed-extension smoke script.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run directory-smoke")) throw new Error("Quality CI must execute the installed-extension W2 smoke test.");
if (!workflow.includes("path: artifacts")) throw new Error("Quality CI must upload W2 browser evidence together with other smoke artifacts.");

console.log("BrowserCrew W2 directory checks passed.");
