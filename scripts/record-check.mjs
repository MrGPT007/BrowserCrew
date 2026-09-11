import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const required = [
  "src/record-write.js",
  "src/record-ui.js",
  "scripts/record-smoke.mjs",
  "tests/fixtures/record.html"
];

for (const file of required) await access(file);
for (const file of ["src/record-write.js", "src/record-ui.js", "scripts/record-smoke.mjs"]) {
  await execFileAsync(process.execPath, ["--check", file]);
}

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./record-write.js"')) throw new Error("Service worker must load the W4 record update engine.");

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./record-ui.js"')) throw new Error("Side panel must load the W4 record update UI.");

const engine = await readFile("src/record-write.js", "utf8");
for (const contract of [
  "record_update",
  "record_save.intent",
  "record_save.dispatched",
  "approvedChangeHash",
  "reconcilePendingRecordWrites",
  "record_outcome_unknown",
  "RECORD_VALUE_NOT_SUPPLIED",
  "verificationMethod: \"Record identity + field values + page save receipt\""
]) {
  if (!engine.includes(contract)) throw new Error(`Missing W4 record contract: ${contract}`);
}
for (const forbidden of ["requestSubmit(", ".submit(", "chrome.cookies", "document.cookie"]) {
  if (engine.includes(forbidden)) throw new Error(`W4 record writer must not contain: ${forbidden}`);
}
const saveClicks = engine.match(/saveButton\.click\(\)/g) || [];
if (saveClicks.length !== 1) throw new Error("W4 must contain exactly one narrowly scoped Save click primitive.");

const ui = await readFile("src/record-ui.js", "utf8");
for (const contract of [
  'data-job-mode="record"',
  "Update a record",
  "Preview record update",
  "Approve and save this record",
  "press Save once",
  "will not automatically press Save again"
]) {
  if (!ui.includes(contract)) throw new Error(`Missing W4 record UI contract: ${contract}`);
}

const fixture = await readFile("tests/fixtures/record.html", "utf8");
for (const contract of [
  'data-browsercrew-record-id="SUP-1042"',
  "data-browsercrew-record-save",
  "data-browsercrew-record-receipt",
  'data-save-count="0"',
  "saves: 0"
]) {
  if (!fixture.includes(contract)) throw new Error(`Missing W4 record fixture proof: ${contract}`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (!String(pkg.scripts?.check || "").includes("record-check.mjs")) throw new Error("npm check must include W4 contracts.");
if (pkg.scripts?.["record-smoke"] !== "node scripts/record-smoke.mjs") throw new Error("W4 installed-extension smoke script must stay wired in package.json.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run record-smoke")) throw new Error("Quality CI must execute the W4 installed-extension smoke test.");

const smoke = await readFile("scripts/record-smoke.mjs", "utf8");
for (const proof of [
  "W4 previewed exact Before to After values",
  "W4 normal approval must press Save exactly once",
  "Target.closeTarget",
  "W4 recovery must inspect the uncertain save instead of replaying it",
  "W4 recovery must never press Save twice"
]) {
  if (!smoke.includes(proof)) throw new Error(`Missing W4 browser proof: ${proof}`);
}

console.log("BrowserCrew W4 record-update checks passed.");
