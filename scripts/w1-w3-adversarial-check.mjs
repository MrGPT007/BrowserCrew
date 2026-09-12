import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const files = [
  "src/compare-ui.js",
  "src/compare-read.js",
  "src/form-write.js",
  "scripts/w1-w3-adversarial-smoke.mjs",
  "scripts/release-matrix-smoke.mjs",
  "scripts/previous-stable-runner.mjs",
  ".github/workflows/quality.yml",
  "package.json"
];
for (const file of files) await access(file);
for (const file of ["src/compare-ui.js", "src/compare-read.js", "src/form-write.js", "scripts/w1-w3-adversarial-smoke.mjs"]) {
  await execFileAsync(process.execPath, ["--check", file]);
}

const compareUi = await readFile("src/compare-ui.js", "utf8");
for (const phrase of ["selectedResources", "selectedTabs.map(({ id, title, url })", "RUN_COMPARE_TASK"]) {
  if (!compareUi.includes(phrase)) throw new Error(`W1 UI resource identity contract missing: ${phrase}`);
}

const compareRead = await readFile("src/compare-read.js", "utf8");
for (const phrase of [
  "normalizeSelectedResources",
  "current.url !== selected.url",
  "COMPARE_TAB_CHANGED",
  "UNTRUSTED PAGE DATA START",
  "candidateBoundToCriterion",
  "Verified against captured page text near the requested criterion"
]) if (!compareRead.includes(phrase)) throw new Error(`W1 runtime hardening missing: ${phrase}`);
if (compareRead.includes("const tabIds = Array.isArray(payload?.tabIds)")) throw new Error("W1 runtime must not reconstruct authorization from current tab IDs alone.");

const formWrite = await readFile("src/form-write.js", "utf8");
for (const phrase of [
  "valueGroundedInUserDetails",
  "normalizeGroundingText",
  "rejectedUngrounded",
  "without inventing information",
  "UNTRUSTED FORM METADATA START",
  "formFingerprint !== task.formPlan.formFingerprint",
  "field.currentValue !== change.before"
]) if (!formWrite.includes(phrase)) throw new Error(`W3 runtime hardening missing: ${phrase}`);

const smoke = await readFile("scripts/w1-w3-adversarial-smoke.mjs", "utf8");
for (const id of ["W1-03", "W1-04", "W1-05", "W3-02", "W3-03", "W3-05"]) {
  if (!smoke.includes(id)) throw new Error(`Adversarial smoke must contain named machine evidence for ${id}.`);
}
for (const phrase of [
  'channel: "chromium",',
  "COMPARE_TAB_CHANGED",
  "PROVIDER_ERROR",
  "rejectedUngrounded",
  "FORM_CHANGED",
  "submits, 0"
]) if (!smoke.includes(phrase)) throw new Error(`Adversarial smoke contract missing: ${phrase}`);

const releaseMatrix = await readFile("scripts/release-matrix-smoke.mjs", "utf8");
for (const id of ["W1-03", "W1-04", "W1-05", "W3-02", "W3-03", "W3-05"]) {
  const marker = `\"${id}\": { suite: \"w1-w3-adversarial\"`;
  if (!releaseMatrix.includes(marker)) throw new Error(`Release matrix must map ${id} to executable adversarial evidence.`);
}
for (const id of ["W2-03", "W2-04", "W4-02", "W4-03", "W4-05", "W5-02", "W5-03", "W5-05"]) {
  const marker = `\"${id}\": { suite: \"planned\"`;
  if (!releaseMatrix.includes(marker)) throw new Error(`Release matrix must keep ${id} as a hard planned failure until its executable test exists.`);
}

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!previousStable.includes('"w1-w3-adversarial-smoke.mjs"')) throw new Error("Chrome 152 replay must include the W1/W3 adversarial suite.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run w1-w3-adversarial-smoke")) throw new Error("Current-stable CI must run the W1/W3 adversarial suite.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["w1-w3-adversarial-check"] !== "node scripts/w1-w3-adversarial-check.mjs") throw new Error("w1-w3-adversarial-check must stay wired.");
if (pkg.scripts?.["w1-w3-adversarial-smoke"] !== "node scripts/w1-w3-adversarial-smoke.mjs") throw new Error("w1-w3-adversarial-smoke must stay wired.");
if (!String(pkg.scripts?.check || "").includes("w1-w3-adversarial-check.mjs")) throw new Error("npm run check must enforce W1/W3 adversarial contracts.");

console.log("BrowserCrew V02-B01 W1/W3 adversarial contracts passed.");
