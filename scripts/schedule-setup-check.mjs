import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
await execFileAsync(process.execPath, ["--check", "src/schedule-setup-ui.js"]);

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

const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.ok(serviceWorker.includes('import "./schedules-runtime.js"'), "Schedule record runtime must stay available for prepared drafts.");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Prepared schedule setup must not boot scheduler dispatch.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Prepared schedule setup must not add alarms permission to the v0.2 manifest.");

console.log("BrowserCrew prepared schedule setup boundary checks passed.");
