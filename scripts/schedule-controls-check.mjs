import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const files = [
  "src/schedule-controls-runtime.js",
  "src/schedule-controls-ui.js",
  "src/schedule-run-history-mutation.js",
  "src/service-worker.js",
  "src/sidepanel.js",
  "scripts/schedule-lifecycle-smoke.mjs",
  "scripts/schedule-control-worker-bootstrap.js",
  "scripts/schedule-control-run-history-race-check.mjs",
  "scripts/previous-stable-runner.mjs",
  ".github/workflows/quality.yml",
  "package.json",
  "manifest.json"
];
for (const file of files) await access(file);
for (const file of ["src/schedule-controls-runtime.js", "src/schedule-controls-ui.js", "src/schedule-run-history-mutation.js", "scripts/schedule-lifecycle-smoke.mjs", "scripts/schedule-control-worker-bootstrap.js", "scripts/schedule-control-run-history-race-check.mjs"]) {
  await execFileAsync(process.execPath, ["--check", file]);
}
await execFileAsync(process.execPath, ["scripts/schedule-control-run-history-race-check.mjs"]);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if ((manifest.permissions || []).includes("alarms")) throw new Error("Pre-activation schedule controls must not add alarms to the production manifest.");

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./schedule-controls-runtime.js"')) throw new Error("Service worker must load the inert schedule control port.");
if (worker.includes("bootSchedulesRuntime")) throw new Error("Pre-activation service worker must not boot the scheduler.");

const panel = await readFile("src/sidepanel.js", "utf8");
if (!panel.includes('import "./schedule-controls-ui.js"')) throw new Error("Sidepanel must load schedule lifecycle controls.");

const runtime = await readFile("src/schedule-controls-runtime.js", "utf8");
for (const phrase of [
  'case "runNow"',
  'case "pause"',
  'case "enable"',
  'SCHEDULE_RUNTIME_LOCKED',
  'SCHEDULE_ALARM_MISSING',
  'SCHEDULE_PAUSED',
  'trigger: "manual"',
  'reviewMissedScheduleRun(receipt.id, "run_once", schedule)',
  'removeManualReceipt(receipt.id)',
  'from "./schedule-run-history-mutation.js"',
  'await withScheduleRunHistoryMutation(async () =>',
  'return withScheduleRunHistoryMutation(async () =>'
]) if (!runtime.includes(phrase)) throw new Error(`Schedule control runtime contract missing: ${phrase}`);

const sharedHistory = await readFile("src/schedule-run-history-mutation.js", "utf8");
for (const phrase of [
  "let scheduleRunHistoryMutation = null",
  "export async function withScheduleRunHistoryMutation(work)",
  "const previous = scheduleRunHistoryMutation || Promise.resolve()",
  "if (scheduleRunHistoryMutation === current) scheduleRunHistoryMutation = null"
]) if (!sharedHistory.includes(phrase)) throw new Error(`Shared schedule run-history mutation contract missing: ${phrase}`);

const ui = await readFile("src/schedule-controls-ui.js", "utf8");
for (const phrase of [
  "capability.schedulerBooted === true",
  "Turn on schedule",
  "Run now",
  "Pause schedule",
  "data-active-schedule",
  "same reviewed schedule authority"
]) if (!ui.includes(phrase)) throw new Error(`Schedule lifecycle UI contract missing: ${phrase}`);

const smoke = await readFile("scripts/schedule-lifecycle-smoke.mjs", "utf8");
for (const phrase of [
  'channel: "chromium",',
  "productionManifest.permissions",
  "__browsercrewScheduleControlBoot",
  'type: "runNow"',
  'type: "pause"',
  "Manual Run now must not shift the next recurring alarm",
  "Pause must clear the exact Chrome alarm",
  "Blocked Run now must not create a second receipt"
]) if (!smoke.includes(phrase)) throw new Error(`Schedule lifecycle smoke contract missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["schedule-controls-check"] !== "node scripts/schedule-controls-check.mjs") throw new Error("schedule-controls-check must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("schedule-controls-check.mjs")) throw new Error("npm run check must enforce schedule control contracts.");
if (pkg.scripts?.["schedule-control-smoke"] !== "node scripts/schedule-control-smoke.mjs") throw new Error("Existing schedule-control-smoke must stay directly runnable.");
if (pkg.scripts?.["schedule-lifecycle-smoke"] !== "node scripts/schedule-lifecycle-smoke.mjs") throw new Error("Schedule lifecycle smoke must stay directly runnable.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run schedule-lifecycle-smoke",
  "schedule-lifecycle-evidence",
  "artifacts/schedule-lifecycle-smoke"
]) if (!workflow.includes(phrase)) throw new Error(`Current Chrome schedule lifecycle evidence contract missing: ${phrase}`);

const previous = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!previous.includes('"schedule-lifecycle-smoke.mjs"')) throw new Error("Pinned Chrome 152 matrix must include schedule lifecycle controls.");

console.log("BrowserCrew pre-activation schedule lifecycle control contracts passed.");
