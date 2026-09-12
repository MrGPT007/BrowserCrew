import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["src/background.js", "src/workspace-stop-ui.js", "scripts/workspace-stop-smoke.mjs"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/background.js"]),
  execFileAsync(process.execPath, ["--check", "src/workspace-stop-ui.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/workspace-stop-smoke.mjs"])
]);

const worker = await readFile("src/background.js", "utf8");
for (const contract of [
  "const activeTaskRuns = new Map()",
  'case "STOP_TASK": return stopTask(message.taskId)',
  "activeTaskRuns.set(task.id, runtime)",
  "activeTaskRuns.delete(task.id)",
  "taskRuntime.providerController = controller",
  'throw coded("TASK_CANCELLED", "The job was stopped. BrowserCrew aborted its active AI request and will not start another step.")',
  "if (error?.name === \"AbortError\" && timedOut) throw coded(\"PROVIDER_TIMEOUT\""
]) if (!worker.includes(contract)) throw new Error(`REL-01 worker contract missing: ${contract}`);

const stopFunction = worker.slice(worker.indexOf("async function stopTask"), worker.indexOf("async function assertNotStopped"));
if (!(stopFunction.indexOf('transition(id, "cancelled", "cancelled")') >= 0 && stopFunction.indexOf('transition(id, "cancelled", "cancelled")') < stopFunction.indexOf("providerController?.abort()"))) {
  throw new Error("Workspace Stop must persist cancelled state before aborting the provider request.");
}
const pauseCase = 'case "PAUSE_TASK": return updateTaskControl(message.taskId, "paused")';
if (!worker.includes(pauseCase)) throw new Error("Workspace Pause must remain a non-aborting after-this-step control.");

const ui = await readFile("src/workspace-stop-ui.js", "utf8");
for (const contract of ["#stopButton", "#pauseButton", '"GET_TASKS"', '"STOP_TASK"', '"PAUSE_TASK"', "stopImmediatePropagation"]) {
  if (!ui.includes(contract)) throw new Error(`Workspace control UI contract missing: ${contract}`);
}
if (ui.includes("AbortController") || ui.includes(".abort()")) throw new Error("The side panel must not own provider AbortControllers.");

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./workspace-stop-ui.js"')) throw new Error("The side panel must load the Workspace Stop bridge.");

const smoke = await readFile("scripts/workspace-stop-smoke.mjs", "utf8");
for (const proof of [
  "Stop closed the in-flight provider request",
  "Pause let the current provider step finish",
  "provider.intent",
  "provider.complete",
  "TASK_CANCELLED"
]) if (!smoke.includes(proof)) throw new Error(`REL-01 browser proof missing: ${proof}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["workspace-stop-check"] !== "node scripts/workspace-stop-check.mjs") throw new Error("workspace-stop-check script is not wired.");
if (pkg.scripts?.["workspace-stop-smoke"] !== "node scripts/workspace-stop-smoke.mjs") throw new Error("workspace-stop-smoke script is not wired.");
if (!String(pkg.scripts?.check || "").includes("workspace-stop-check.mjs")) throw new Error("npm run check must include REL-01 contracts.");
const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run workspace-stop-smoke")) throw new Error("Quality CI must run the REL-01 installed-extension smoke test.");

console.log("BrowserCrew REL-01 Workspace Stop contracts passed.");
