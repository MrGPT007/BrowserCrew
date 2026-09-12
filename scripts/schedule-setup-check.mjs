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
  'value="once">Once',
  'value="daily">Every day',
  'value="weekly">Every week',
  'value="interval">Custom interval',
  "Prepare a schedule",
  "Save prepared schedule",
  "Prepared schedules are saved but disabled.",
  'type: "saveDraft"',
  "enabled: false",
  "grantRefs:",
  "missedRunPolicy:",
  "concurrencyPolicy:",
  "providerRef,",
  "budgets:",
  "Edit prepared schedule",
  'type: "delete"',
  "does not turn the schedule on",
  "does not add Chrome's alarms permission"
]) assert.ok(ui.includes(phrase), `Prepared schedule UI contract missing: ${phrase}`);

assert.equal(ui.includes('type: "setEnabled"'), false, "Prepared schedule UI must not expose activation in the no-alarms slice.");
assert.equal(ui.includes("chrome.alarms"), false, "Prepared schedule UI must not access chrome.alarms directly.");

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./schedule-setup-ui.js"'), "Side panel must load the prepared schedule setup UI.");

const runtime = await readFile("src/schedules-runtime.js", "utf8");
for (const phrase of [
  'case "saveDraft": return saveSchedule({ ...(message.schedule || {}), enabled: false })',
  "if (schedule.enabled) requireAlarmsApi()",
  "if (desired) requireAlarmsApi()",
  "if (chrome.alarms?.clear) await chrome.alarms.clear(alarmName(scheduleId))"
]) assert.ok(runtime.includes(phrase), `Prepared schedule runtime boundary missing: ${phrase}`);

const smoke = await readFile("scripts/schedule-setup-smoke.mjs", "utf8");
for (const phrase of [
  "Prepared schedule setup keeps the v0.2 manifest free of alarms permission",
  "Skills UI separates schedule preparation from inactive background scheduling",
  "Once, Daily, Weekly, and Custom presets persist as disabled exact-skill schedules with named AI and inherited budgets",
  "Editing a prepared schedule preserves identity while keeping it disabled",
  "Prepared schedule UI exposes no activation control before the alarms permission release",
  "Prepared schedules can be deleted without scheduler activation or alarms permission",
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
