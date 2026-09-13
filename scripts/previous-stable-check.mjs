import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const targets = [
  "package-smoke.mjs",
  "browser-smoke.mjs",
  "w1-w3-adversarial-smoke.mjs",
  "w2-w4-w5-adversarial-smoke.mjs",
  "directory-smoke.mjs",
  "record-smoke.mjs",
  "invoice-smoke.mjs",
  "chat-smoke.mjs",
  "connections-smoke.mjs",
  "attachments-smoke.mjs",
  "tools-smoke.mjs",
  "anthropic-smoke.mjs",
  "accessibility-smoke.mjs",
  "mcp-smoke.mjs",
  "c5-smoke.mjs",
  "workspace-stop-smoke.mjs",
  "watch-me-smoke.mjs",
  "watch-me-resilience-smoke.mjs",
  "watch-me-event-trust-smoke.mjs",
  "skill-draft-review-smoke.mjs",
  "skill-library-lifecycle-smoke.mjs",
  "skill-version-compare-smoke.mjs",
  "skill-portable-smoke.mjs",
  "skill-run-ui-smoke.mjs",
  "skill-completion-check-smoke.mjs",
  "skill-replay-resilience-smoke.mjs",
  "schedule-review-smoke.mjs",
  "schedule-setup-smoke.mjs",
  "schedule-binding-smoke.mjs",
  "schedule-control-smoke.mjs"
];

for (const file of ["scripts/previous-stable-runner.mjs", "scripts/schedule-control-worker-bootstrap.js", ".github/workflows/quality.yml", "docs/RELEASE-EVIDENCE-v0.2.md"]) await access(file);
await execFileAsync(process.execPath, ["--check", "scripts/previous-stable-runner.mjs"]);
await execFileAsync(process.execPath, ["--check", "scripts/schedule-control-smoke.mjs"]);
await execFileAsync(process.execPath, ["--check", "scripts/schedule-binding-smoke.mjs"]);
await execFileAsync(process.execPath, ["--check", "scripts/schedule-control-worker-bootstrap.js"]);

const scheduleControlBootstrap = await readFile("scripts/schedule-control-worker-bootstrap.js", "utf8");
for (const phrase of [
  'bootSchedulesRuntime',
  'reviewMissedScheduleRun',
  'runTask',
  '__browsercrewScheduleControlBoot',
  '__browsercrewScheduleControlStart',
  '__browsercrewScheduleControlFinish'
]) if (!scheduleControlBootstrap.includes(phrase)) throw new Error(`Schedule control worker bootstrap contract missing: ${phrase}`);
if (scheduleControlBootstrap.includes("import(")) throw new Error("Service-worker schedule control bootstrap must use static module imports; dynamic import() is forbidden in ServiceWorkerGlobalScope.");

const runner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
for (const phrase of [
  'BROWSERCREW_BROWSER_EXECUTABLE',
  '152.0.7977.75',
  'browsercrew.previous_stable_chrome_receipt',
  'assert.equal(observedVersion, expectedVersion',
  ...targets
]) if (!runner.includes(phrase)) throw new Error(`Previous-stable runner contract missing: ${phrase}`);

for (const target of targets) {
  const source = await readFile(`scripts/${target}`, "utf8");
  if (!source.includes('channel: "chromium",')) throw new Error(`${target} must retain the controlled Playwright Chromium launch marker so V02-B06 can redirect it to Chrome 152.`);
}

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "previous-stable-chrome:",
  "152.0.7977.75",
  "chrome-for-testing-public/152.0.7977.75/linux64/chrome-linux64.zip",
  "BROWSERCREW_BROWSER_EXECUTABLE",
  "BROWSERCREW_EXPECT_BROWSER_VERSION",
  "npm run previous-stable-smoke",
  "previous-stable-chrome-evidence",
  "npm run w1-w3-adversarial-smoke",
  "npm run watch-me-smoke",
  "watch-me-evidence",
  "npm run watch-me-resilience-smoke",
  "watch-me-resilience-evidence",
  "npm run skill-draft-review-smoke",
  "skill-draft-review-evidence",
  "npm run skill-library-lifecycle-smoke",
  "skill-library-lifecycle-evidence",
  "npm run skill-portable-smoke",
  "skill-portable-evidence",
  "npm run skill-run-ui-smoke",
  "skill-run-ui-evidence",
  "npm run schedule-review-smoke",
  "schedule-review-evidence",
  "npm run schedule-setup-smoke",
  "schedule-setup-evidence",
  "npm run schedule-control-smoke",
  "schedule-control-evidence"
]) if (!workflow.includes(phrase)) throw new Error(`Quality workflow previous-stable contract missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["previous-stable-check"] !== "node scripts/previous-stable-check.mjs") throw new Error("previous-stable-check script must stay wired.");
if (pkg.scripts?.["previous-stable-smoke"] !== "node scripts/previous-stable-runner.mjs") throw new Error("previous-stable-smoke script must stay wired.");
if (pkg.scripts?.["watch-me-smoke"] !== "node scripts/watch-me-smoke.mjs") throw new Error("watch-me-smoke must stay wired for current and previous-stable browser coverage.");
const watchResilienceSmoke = String(pkg.scripts?.["watch-me-resilience-smoke"] || "");
if (!watchResilienceSmoke.includes("node scripts/watch-me-resilience-smoke.mjs") || !watchResilienceSmoke.includes("node scripts/watch-me-event-trust-smoke.mjs")) throw new Error("watch-me-resilience-smoke must keep restart and hostile page-event trust coverage together on current Chrome.");
if (pkg.scripts?.["watch-me-event-trust-smoke"] !== "node scripts/watch-me-event-trust-smoke.mjs") throw new Error("watch-me-event-trust-smoke must stay directly runnable for Chrome 152 coverage.");
if (pkg.scripts?.["skill-draft-review-smoke"] !== "node scripts/skill-draft-review-smoke.mjs") throw new Error("skill-draft-review-smoke must stay wired for current and previous-stable browser coverage.");
const lifecycleSmoke = String(pkg.scripts?.["skill-library-lifecycle-smoke"] || "");
if (!lifecycleSmoke.includes("node scripts/skill-library-lifecycle-smoke.mjs") || !lifecycleSmoke.includes("node scripts/skill-version-compare-smoke.mjs")) throw new Error("skill-library-lifecycle-smoke must keep lifecycle and exact-version Compare coverage together on current Chrome.");
if (pkg.scripts?.["skill-version-compare-smoke"] !== "node scripts/skill-version-compare-smoke.mjs") throw new Error("skill-version-compare-smoke must stay directly runnable for Chrome 152 coverage.");
if (pkg.scripts?.["skill-portable-smoke"] !== "node scripts/skill-portable-smoke.mjs") throw new Error("skill-portable-smoke must stay wired for current and previous-stable browser coverage.");
const runUiSmoke = String(pkg.scripts?.["skill-run-ui-smoke"] || "");
if (!runUiSmoke.includes("node scripts/skill-run-ui-smoke.mjs") || !runUiSmoke.includes("node scripts/skill-completion-check-smoke.mjs") || !runUiSmoke.includes("node scripts/skill-replay-resilience-smoke.mjs")) throw new Error("skill-run-ui-smoke must keep approved/draft Test/Run, bounded completion-check, and replay-restart coverage together on current Chrome.");
if (pkg.scripts?.["skill-completion-check-smoke"] !== "node scripts/skill-completion-check-smoke.mjs") throw new Error("skill-completion-check-smoke must stay directly runnable for Chrome 152 coverage.");
if (pkg.scripts?.["skill-replay-resilience-smoke"] !== "node scripts/skill-replay-resilience-smoke.mjs") throw new Error("skill-replay-resilience-smoke must stay directly runnable for Chrome 152 coverage.");
if (pkg.scripts?.["schedule-review-smoke"] !== "node scripts/schedule-review-smoke.mjs") throw new Error("schedule-review-smoke must stay directly runnable for current and Chrome 152 coverage.");
const setupSmoke = String(pkg.scripts?.["schedule-setup-smoke"] || "");
if (!setupSmoke.includes("node scripts/schedule-setup-smoke.mjs") || !setupSmoke.includes("node scripts/schedule-binding-smoke.mjs")) throw new Error("schedule-setup-smoke must keep prepared setup and starting-page binding coverage together on current Chrome.");
if (pkg.scripts?.["schedule-binding-smoke"] !== "node scripts/schedule-binding-smoke.mjs") throw new Error("schedule-binding-smoke must stay directly runnable for Chrome 152 coverage.");
if (pkg.scripts?.["schedule-control-smoke"] !== "node scripts/schedule-control-smoke.mjs") throw new Error("schedule-control-smoke must stay directly runnable for current and Chrome 152 coverage.");
if (!String(pkg.scripts?.check || "").includes("previous-stable-check.mjs")) throw new Error("npm run check must include previous-stable contracts.");

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
for (const phrase of [
  "Browser compatibility | **Passed**",
  "PR #39",
  "c2f84ad2fe2ac15199a2bb878c83a1bae76e95ba",
  "34706114178",
  "92ddd0546caedfdf8bc09b14c6d50e87c0ca432c",
  "34706787383",
  "10302206254",
  "sha256:ffbbceca201a968f030511395c94753c17401448e5f438aced458472fce0a879"
]) if (!evidence.includes(phrase)) throw new Error(`Resolved V02-B06 release evidence missing: ${phrase}`);

console.log("BrowserCrew V02-B06 previous-stable Chrome contracts passed.");