import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["src/schedule-setup-ui.js", "scripts/schedule-setup-smoke.mjs"]) {
  await execFileAsync(process.execPath, ["--check", file]);
}

const ui = await readFile("src/schedule-setup-ui.js", "utf8");
for (const phrase of [
  'const SCHEDULES_PORT = "browsercrew-schedules"',
  'const SKILLS_PORT = "browsercrew-skills"',
  'const CONNECTIONS_PORT = "browsercrew-connections"',
  'let scheduleRuns = []',
  'value="once">Once',
  'value="daily">Every day',
  'value="weekly">Every week',
  'value="interval">Custom interval',
  "Prepare a schedule",
  "Save prepared schedule",
  "Prepared schedules are saved but disabled.",
  'type: "saveDraft"',
  'type: "listRuns"',
  "enabled: false",
  "grantRefs:",
  "missedRunPolicy:",
  "concurrencyPolicy:",
  "providerRef,",
  "budgets:",
  "Edit prepared schedule",
  'type: "delete"',
  "does not turn the schedule on",
  "does not add Chrome's alarms permission",
  "let setupHydrationPromise = null",
  'setupButton.textContent = "Loading schedule setup…"',
  "hydrateScheduleSetup()",
  "const ready = await hydrateScheduleSetup()",
  'setupButton.textContent = "Retry schedule setup"',
  'setupButton.setAttribute("aria-busy", "true")',
  "Status:</strong> Prepared — not active in this build.",
  "Next run:</strong>",
  "Last run:</strong>",
  "Exact job:</strong>",
  "AI / model:</strong>",
  "Sites:</strong>",
  "Resources:</strong>",
  "Permission scope:</strong>",
  "Budget:</strong>",
  "Missed run:</strong>",
  "Overlap:</strong>",
  "BrowserCrew cannot wake a sleeping or offline browser or device.",
  '>Run now</button>',
  '>Pause</button>',
  "Run now and Pause are unavailable while background scheduling is intentionally locked for this build.",
  "receipt ${latestRun.id || \"unknown\"}"
]) assert.ok(ui.includes(phrase), `Prepared schedule UI contract missing: ${phrase}`);

const initialEnable = ui.indexOf('setupButton.textContent = "Prepare a schedule"');
const initialHydrate = ui.indexOf("hydrateScheduleSetup().catch");
assert.ok(initialEnable < 0 || initialEnable > initialHydrate, "Schedule setup must not advertise readiness before async Skills/Connections/Schedules hydration starts.");
assert.equal(ui.includes('type: "setEnabled"'), false, "Prepared schedule UI must not expose activation in the no-alarms slice.");
assert.equal(ui.includes("chrome.alarms"), false, "Prepared schedule UI must not access chrome.alarms directly.");
assert.equal(ui.includes("data-run-now-schedule"), false, "Prepared schedule Run now control must remain inert before scheduler activation.");
assert.equal(ui.includes("data-pause-schedule"), false, "Prepared schedule Pause control must remain inert before scheduler activation.");

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./schedule-setup-ui.js"'), "Side panel must load the prepared schedule setup UI.");

const runtime = await readFile("src/schedules-runtime.js", "utf8");
for (const phrase of [
  'case "saveDraft": return saveSchedule({ ...(message.schedule || {}), enabled: false })',
  'case "listRuns": return { ok: true, runs: await listScheduleRuns(message.scheduleId || null) }',
  "if (schedule.enabled) requireAlarmsApi()",
  "if (desired) requireAlarmsApi()",
  "if (chrome.alarms?.clear) await chrome.alarms.clear(alarmName(scheduleId))"
]) assert.ok(runtime.includes(phrase), `Prepared schedule runtime boundary missing: ${phrase}`);

const smoke = await readFile("scripts/schedule-setup-smoke.mjs", "utf8");
for (const phrase of [
  "Prepared schedule setup keeps the v0.2 manifest free of alarms permission",
  "Skills UI separates schedule preparation from inactive background scheduling",
  "Once, Daily, Weekly, and Custom presets persist as disabled exact-skill schedules with named AI and inherited budgets",
  "Prepared cards expose status, exact provider and Skill scope, safety limits, missed/overlap rules, and honest device availability while Run now and Pause stay unavailable",
  "Editing preserves identity and the prepared card reads immutable schedule-run history without activating the schedule",
  "Prepared schedule UI exposes no activation control before the alarms permission release",
  "Prepared schedules can be deleted without scheduler activation while historical run evidence remains durable",
  "schedule-run-history-1",
  "Deleting a prepared schedule must not erase its historical run receipt.",
  'channel: "chromium",'
]) assert.ok(smoke.includes(phrase), `Prepared schedule installed-extension proof missing: ${phrase}`);

const quality = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run schedule-setup-smoke",
  "name: schedule-setup-evidence",
  "path: artifacts/schedule-setup-smoke"
]) assert.ok(quality.includes(phrase), `Current-stable prepared schedule CI gate missing: ${phrase}`);

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousStable.includes('"schedule-setup-smoke.mjs"'), "Chrome 152 matrix must include prepared schedule setup smoke coverage.");

const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.ok(serviceWorker.includes('import "./schedules-runtime.js"'), "Schedule record runtime must stay available for prepared drafts.");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Prepared schedule setup must not boot scheduler dispatch.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Prepared schedule setup must not add alarms permission to the v0.2 manifest.");

console.log("BrowserCrew prepared schedule setup boundary and browser coverage checks passed.");
