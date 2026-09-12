import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const files = [
  "src/directory-extract.js",
  "src/record-write.js",
  "src/invoice-download.js",
  "scripts/w2-w4-w5-adversarial-smoke.mjs",
  "scripts/release-matrix-smoke.mjs",
  "scripts/previous-stable-runner.mjs",
  ".github/workflows/quality.yml",
  "package.json"
];
for (const file of files) await access(file);
await execFileAsync(process.execPath, ["--check", "scripts/w2-w4-w5-adversarial-smoke.mjs"]);

const directory = await readFile("src/directory-extract.js", "utf8");
for (const phrase of [
  "const MAX_DIRECTORY_PAGES = 10",
  "Math.min(MAX_DIRECTORY_PAGES",
  "DIRECTORY_LEFT_SITE",
  "pageLimitReached = true",
  "pageLimitReached"
]) if (!directory.includes(phrase)) throw new Error(`W2 safety contract missing: ${phrase}`);

const record = await readFile("src/record-write.js", "utf8");
for (const phrase of [
  "before.recordId !== task.recordPlan.recordId",
  "before.recordFingerprint !== task.recordPlan.recordFingerprint",
  "field.currentValue !== change.before",
  "RECORD_SAVE_UNVERIFIED",
  "record_save_unverified",
  "verifyRecordSaveReceipt",
  "It will not press Save again automatically"
]) if (!record.includes(phrase)) throw new Error(`W4 safety contract missing: ${phrase}`);

const invoice = await readFile("src/invoice-download.js", "utf8");
for (const phrase of [
  "INVOICE_CROSS_ORIGIN",
  "INVOICE_SELECTION_CHANGED",
  "DOWNLOAD_INTERRUPTED",
  "verified: false",
  "bytesReceived > 0",
  "It will not start a duplicate automatically"
]) if (!invoice.includes(phrase)) throw new Error(`W5 safety contract missing: ${phrase}`);

const smoke = await readFile("scripts/w2-w4-w5-adversarial-smoke.mjs", "utf8");
const scenarioChecks = {
  "W2-03": "blocked cross-origin pagination before navigating to another origin",
  "W2-04": "stopped at the configured page limit and disclosed pageLimitReached",
  "W4-02": "blocked commit after the selected record URL changed and performed zero saves",
  "W4-03": "blocked a stale before-value and performed zero saves",
  "W4-05": "marked the Save outcome unverified and did not replay Save",
  "W5-02": "excluded a cross-origin invoice and dispatched zero cross-origin downloads",
  "W5-03": "preserved interrupted-download failure evidence without verified completion",
  "W5-05": "blocked a stale invoice selection and dispatched zero downloads"
};
for (const [id, check] of Object.entries(scenarioChecks)) {
  if (!smoke.includes(`${id} ${check}`)) throw new Error(`Adversarial smoke must contain named machine evidence for ${id}.`);
}
for (const phrase of [
  'channel: "chromium",',
  "foreign.state.directoryHits, 0",
  "w2Page3Hits, 0",
  "RECORD_SAVE_UNVERIFIED",
  "record_save_unverified",
  "foreign.state.pdfHits, 0",
  "DOWNLOAD_INTERRUPTED",
  "INVOICE_SELECTION_CHANGED"
]) if (!smoke.includes(phrase)) throw new Error(`Adversarial smoke proof contract missing: ${phrase}`);

const releaseMatrix = await readFile("scripts/release-matrix-smoke.mjs", "utf8");
for (const id of Object.keys(scenarioChecks)) {
  const marker = `"${id}": { suite: "w2-w4-w5-adversarial"`;
  if (!releaseMatrix.includes(marker)) throw new Error(`Release matrix must map ${id} to executable W2/W4/W5 adversarial evidence.`);
}
if (releaseMatrix.includes('suite: "planned"')) throw new Error("All 25 release scenarios now require executable evidence; no planned scorer entries may remain.");
if (!releaseMatrix.includes('"w2-w4-w5-adversarial": [process.execPath')) throw new Error("Release matrix must execute the W2/W4/W5 adversarial suite for every scoring attempt.");

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!previousStable.includes('"w2-w4-w5-adversarial-smoke.mjs"')) throw new Error("Chrome 152 replay must include the W2/W4/W5 adversarial suite.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run w2-w4-w5-adversarial-smoke")) throw new Error("Current-stable CI must run the W2/W4/W5 adversarial suite.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["w2-w4-w5-adversarial-check"] !== "node scripts/w2-w4-w5-adversarial-check.mjs") throw new Error("w2-w4-w5-adversarial-check must stay wired.");
if (pkg.scripts?.["w2-w4-w5-adversarial-smoke"] !== "node scripts/w2-w4-w5-adversarial-smoke.mjs") throw new Error("w2-w4-w5-adversarial-smoke must stay wired.");
if (!String(pkg.scripts?.check || "").includes("w2-w4-w5-adversarial-check.mjs")) throw new Error("npm run check must enforce W2/W4/W5 adversarial contracts.");

console.log("BrowserCrew V02-B01 W2/W4/W5 adversarial contracts passed.");
