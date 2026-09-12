import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const catalogPath = "tests/scenarios/v0.2.json";
const runnerPath = "scripts/release-matrix-smoke.mjs";
for (const file of [catalogPath, runnerPath, "docs/RELEASE-EVIDENCE-v0.2.md"]) await access(file);
await execFileAsync(process.execPath, ["--check", runnerPath]);

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
if (catalog.schemaVersion !== 1) throw new Error("v0.2 scenario catalog schemaVersion must remain 1.");
if (catalog.release !== "v0.2") throw new Error("Scenario catalog must target v0.2.");
if (catalog.requiredScenarioCount !== 25) throw new Error("V02-B01 must retain exactly 25 release scenarios.");
if (catalog.requiredRunsPerScenario !== 3) throw new Error("V02-B01 must retain exactly three scored attempts per scenario.");
if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length !== 25) throw new Error("Scenario catalog must contain exactly 25 entries.");

const ids = new Set();
const workflowCounts = new Map();
for (const scenario of catalog.scenarios) {
  if (!/^W[1-5]-0[1-5]$/.test(scenario.id || "")) throw new Error(`Invalid scenario id: ${scenario.id}`);
  if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
  ids.add(scenario.id);
  if (!/^W[1-5]$/.test(scenario.workflow || "")) throw new Error(`Invalid workflow for ${scenario.id}.`);
  workflowCounts.set(scenario.workflow, (workflowCounts.get(scenario.workflow) || 0) + 1);
  if (!scenario.title || !scenario.variation) throw new Error(`${scenario.id} must retain a title and variation.`);
}
for (const workflow of ["W1", "W2", "W3", "W4", "W5"]) {
  if (workflowCounts.get(workflow) !== 5) throw new Error(`${workflow} must retain exactly five release scenarios.`);
}

const runner = await readFile(runnerPath, "utf8");
for (const phrase of [
  "TOTAL_REQUIRED = 75",
  "OVERALL_PASS_THRESHOLD = 68",
  "WORKFLOW_PASS_THRESHOLD = 12",
  "requiredRunsPerScenario",
  "scenarioId",
  "attempt",
  "candidateSha",
  "browserIdentity",
  "providerIdentity",
  "completionChecks",
  "release-matrix-summary.json",
  "release-matrix-receipts.jsonl",
  "failed attempts remain in the denominator",
  "BROWSERCREW_CANDIDATE_SHA",
  "GITHUB_EVENT_PATH",
  "pull_request?.head?.sha",
  "event?.after",
  "exact 40-character candidate commit SHA"
]) if (!runner.includes(phrase)) throw new Error(`Release-matrix runner contract missing: ${phrase}`);
for (const id of ids) if (!runner.includes(`\"${id}\"`)) throw new Error(`Release-matrix runner must explicitly map ${id}.`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["release-matrix-check"] !== "node scripts/release-matrix-check.mjs") throw new Error("release-matrix-check must stay wired in package.json.");
if (pkg.scripts?.["release-matrix-smoke"] !== "node scripts/release-matrix-smoke.mjs") throw new Error("release-matrix-smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("release-matrix-check.mjs")) throw new Error("npm run check must enforce release-matrix contracts.");

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
if (!evidence.includes("68/75")) throw new Error("Release ledger must retain the 68/75 threshold.");
if (!evidence.includes("12/15")) throw new Error("Release ledger must retain the per-workflow 12/15 threshold.");
if (!evidence.includes("V02-B01")) throw new Error("Release ledger must retain V02-B01 until real 75-run evidence exists.");

console.log("BrowserCrew V02-B01 release matrix contracts passed.");
