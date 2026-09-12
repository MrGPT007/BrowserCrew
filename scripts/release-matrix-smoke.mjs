import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "release-matrix");
const sourceReportDir = join(artifactDir, "source-reports");
const catalogPath = join(repoRoot, "tests", "scenarios", "v0.2.json");
const receiptsPath = join(artifactDir, "release-matrix-receipts.jsonl");
const summaryPath = join(artifactDir, "release-matrix-summary.json");
const TOTAL_REQUIRED = 75;
const OVERALL_PASS_THRESHOLD = 68;
const WORKFLOW_PASS_THRESHOLD = 12;

// Release rule: failed attempts remain in the denominator. Missing implementation is a failed attempt, never a skip/pass.
const scenarioMap = {
  "W1-01": { suite: "browser-smoke", report: "browser-smoke/report.json", check: "W1 compared five controlled supplier pages" },
  "W1-02": { suite: "browser-smoke", report: "browser-smoke/report.json", check: "missing-data reporting" },
  "W1-03": { suite: "planned", reason: "stale-resource scenario has no executable release test yet" },
  "W1-04": { suite: "planned", reason: "hostile-page-content scenario has no executable release test yet" },
  "W1-05": { suite: "planned", reason: "provider-failure scenario has no executable release test yet" },
  "W2-01": { suite: "directory-smoke", report: "directory-smoke/report.json", check: "followed same-site Next links" },
  "W2-02": { suite: "directory-smoke", report: "directory-smoke/report.json", check: "explained exact and conflicting duplicates" },
  "W2-03": { suite: "planned", reason: "cross-origin-pagination scenario has no executable release test yet" },
  "W2-04": { suite: "planned", reason: "bounded-limit scenario has no executable release test yet" },
  "W2-05": { suite: "directory-smoke", report: "directory-smoke/report.json", check: "neutralized spreadsheet formula injection" },
  "W3-01": { suite: "browser-smoke", report: "browser-smoke/report.json", check: "previewed and filled approved fields" },
  "W3-02": { suite: "planned", reason: "scope-escalation scenario has no executable release test yet" },
  "W3-03": { suite: "planned", reason: "stale-approval scenario has no executable release test yet" },
  "W3-04": { suite: "browser-smoke", report: "browser-smoke/report.json", check: "recovery did not replay an uncertain write" },
  "W3-05": { suite: "planned", reason: "hostile-page-content form scenario has no executable release test yet" },
  "W4-01": { suite: "record-smoke", report: "record-smoke/report.json", check: "previewed exact Before to After values" },
  "W4-02": { suite: "planned", reason: "wrong-resource scenario has no executable release test yet" },
  "W4-03": { suite: "planned", reason: "stale-before-value scenario has no executable release test yet" },
  "W4-04": { suite: "record-smoke", report: "record-smoke/report.json", check: "recovery verified the uncertain save" },
  "W4-05": { suite: "planned", reason: "unknown-outcome scenario has no executable release test yet" },
  "W5-01": { suite: "invoice-smoke", report: "invoice-smoke/report.json", check: "downloaded only the two selected invoices" },
  "W5-02": { suite: "planned", reason: "cross-origin-download scenario has no executable release test yet" },
  "W5-03": { suite: "planned", reason: "download-interruption scenario has no executable release test yet" },
  "W5-04": { suite: "invoice-smoke", report: "invoice-smoke/report.json", check: "recovery reconciled the existing Chrome download" },
  "W5-05": { suite: "planned", reason: "stale-resource invoice scenario has no executable release test yet" }
};

const suiteCommands = {
  "browser-smoke": [process.execPath, [join(repoRoot, "scripts", "browser-smoke.mjs")]],
  "directory-smoke": [process.execPath, [join(repoRoot, "scripts", "directory-smoke.mjs")]],
  "record-smoke": [process.execPath, [join(repoRoot, "scripts", "record-smoke.mjs")]],
  "invoice-smoke": [process.execPath, [join(repoRoot, "scripts", "invoice-smoke.mjs")]]
};

await rm(artifactDir, { recursive: true, force: true });
await mkdir(sourceReportDir, { recursive: true });
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
assert.equal(catalog.requiredScenarioCount, 25);
assert.equal(catalog.requiredRunsPerScenario, 3);
assert.equal(catalog.scenarios.length, 25);
assert.deepEqual(new Set(catalog.scenarios.map((item) => item.id)), new Set(Object.keys(scenarioMap)), "Runner map must exactly match the catalog.");

const candidateSha = await resolveCandidateSha();
const browserIdentity = await resolveBrowserIdentity();
const catalogSnapshot = JSON.parse(JSON.stringify(catalog));
await writeFile(join(artifactDir, "catalog-snapshot.json"), `${JSON.stringify(catalogSnapshot, null, 2)}\n`);
const receipts = [];

for (let attempt = 1; attempt <= catalog.requiredRunsPerScenario; attempt += 1) {
  const suiteResults = new Map();
  for (const suite of Object.keys(suiteCommands)) suiteResults.set(suite, await runSuite(suite, attempt));

  for (const scenario of catalog.scenarios) {
    const mapping = scenarioMap[scenario.id];
    const startedAt = new Date().toISOString();
    let passed = false;
    let resultStatus = "failed";
    let completionChecks = [];
    let failureReason = null;
    let sourceEvidence = null;
    let providerIdentity = providerForScenario(scenario);

    if (mapping.suite === "planned") {
      failureReason = `missing_executable_scenario: ${mapping.reason}`;
    } else {
      const suiteResult = suiteResults.get(mapping.suite);
      sourceEvidence = suiteResult?.copiedReport || null;
      if (!suiteResult?.report) {
        failureReason = suiteResult?.error || `${mapping.suite} produced no readable report.`;
      } else {
        completionChecks = (suiteResult.report.checks || [])
          .filter((check) => String(check?.name || "").toLowerCase().includes(mapping.check.toLowerCase()))
          .map((check) => ({ name: check.name, details: check.details ?? null, at: check.at ?? null }));
        passed = suiteResult.exitOk === true && suiteResult.report.ok === true && completionChecks.length > 0;
        resultStatus = passed ? "passed" : "failed";
        if (!passed) failureReason = suiteResult.error || `Expected machine check not found: ${mapping.check}`;
      }
    }

    const receipt = {
      kind: "browsercrew.release_scenario_run",
      schemaVersion: 1,
      release: "v0.2",
      scenarioId: scenario.id,
      workflow: scenario.workflow,
      variation: scenario.variation,
      attempt,
      candidateSha,
      browserIdentity,
      providerIdentity,
      resultStatus,
      passed,
      startedAt,
      completedAt: new Date().toISOString(),
      completionChecks,
      sourceEvidence,
      failureReason
    };
    receipts.push(receipt);
    await appendFile(receiptsPath, `${JSON.stringify(receipt)}\n`);
  }
}

const workflowScores = Object.fromEntries(["W1", "W2", "W3", "W4", "W5"].map((workflow) => {
  const runs = receipts.filter((receipt) => receipt.workflow === workflow);
  return [workflow, { passed: runs.filter((run) => run.passed).length, total: runs.length, threshold: WORKFLOW_PASS_THRESHOLD }];
}));
const passed = receipts.filter((receipt) => receipt.passed).length;
const uniqueAttemptKeys = new Set(receipts.map((receipt) => `${receipt.scenarioId}:${receipt.attempt}`));
const structuralOk = receipts.length === TOTAL_REQUIRED && uniqueAttemptKeys.size === TOTAL_REQUIRED;
const scoreOk = passed >= OVERALL_PASS_THRESHOLD && Object.values(workflowScores).every((score) => score.passed >= WORKFLOW_PASS_THRESHOLD);
const summary = {
  kind: "browsercrew.release_matrix_summary",
  schemaVersion: 1,
  release: "v0.2",
  candidateSha,
  browserIdentity,
  generatedAt: new Date().toISOString(),
  requiredScenarioCount: catalog.requiredScenarioCount,
  requiredRunsPerScenario: catalog.requiredRunsPerScenario,
  requiredTotalRuns: TOTAL_REQUIRED,
  receivedTotalRuns: receipts.length,
  uniqueAttemptKeys: uniqueAttemptKeys.size,
  passed,
  failed: receipts.length - passed,
  overallThreshold: OVERALL_PASS_THRESHOLD,
  workflowThreshold: WORKFLOW_PASS_THRESHOLD,
  workflowScores,
  structuralOk,
  scoreOk,
  ok: structuralOk && scoreOk
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`BrowserCrew v0.2 release matrix: ${passed}/${receipts.length} passed.`);
for (const [workflow, score] of Object.entries(workflowScores)) console.log(`${workflow}: ${score.passed}/${score.total}`);
if (!summary.ok) {
  throw new Error(`V02-B01 release matrix is not green: ${passed}/${receipts.length}; required >=${OVERALL_PASS_THRESHOLD}/${TOTAL_REQUIRED} and each workflow >=${WORKFLOW_PASS_THRESHOLD}/15. See ${summaryPath}.`);
}

async function runSuite(suite, attempt) {
  const [command, args] = suiteCommands[suite];
  let exitOk = false;
  let error = null;
  try {
    const result = await execFileAsync(command, args, { cwd: repoRoot, env: process.env, maxBuffer: 32 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    exitOk = true;
  } catch (caught) {
    if (caught?.stdout) process.stdout.write(caught.stdout);
    if (caught?.stderr) process.stderr.write(caught.stderr);
    error = caught?.message || String(caught);
  }

  const reportRelative = Object.values(scenarioMap).find((mapping) => mapping.suite === suite)?.report;
  const reportPath = reportRelative ? join(repoRoot, "artifacts", reportRelative) : null;
  let report = null;
  let copiedReport = null;
  if (reportPath) {
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
      copiedReport = join("source-reports", `attempt-${attempt}-${suite}.json`);
      await copyFile(reportPath, join(artifactDir, copiedReport));
    } catch (caught) {
      error = error || `Could not read ${reportRelative}: ${caught?.message || caught}`;
    }
  }
  return { exitOk, error, report, copiedReport };
}

async function resolveCandidateSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function resolveBrowserIdentity() {
  const executablePath = chromium.executablePath();
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"]);
    return { executablePath, version: `${stdout || ""}${stderr || ""}`.trim() };
  } catch (error) {
    return { executablePath, version: "unavailable", error: error?.message || String(error) };
  }
}

function providerForScenario(scenario) {
  if (scenario.workflow === "W5") return { kind: "none", model: null, note: "W5 fixture is browser/download driven." };
  if (scenario.workflow === "W4") return { kind: "deterministic-openai-compatible-fixture", model: "browsercrew-w4-smoke" };
  if (scenario.workflow === "W2") return { kind: "deterministic-openai-compatible-fixture", model: "browsercrew-w2-smoke" };
  return { kind: "deterministic-openai-compatible-fixture", model: "browsercrew-smoke" };
}