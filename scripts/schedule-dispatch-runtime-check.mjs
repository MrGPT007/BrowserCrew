import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/schedule-dispatch-runtime.js",
  "src/schedule-dispatcher.js",
  "src/schedule-resolvers.js",
  "src/schedule-grants-runtime.js",
  "scripts/schedule-dispatch-runtime-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

globalThis.chrome = {
  runtime: { onConnect: { addListener() {} } },
  storage: { local: { async get() { return {}; }, async set() {} } },
  permissions: { async contains() { return false; } },
  tabs: { async query() { return []; } }
};
const composition = await import(`../src/schedule-dispatch-runtime.js?check=${Date.now()}`);
const resolvers = composition.createProductionScheduleExecutionResolvers();
assert.equal(typeof resolvers.resolveProvider, "function");
assert.equal(typeof resolvers.resolveGrant, "function");
assert.equal(typeof resolvers.resolveResource, "function");
assert.equal(typeof composition.createProductionScheduleSkillDispatcher(), "function");
assert.equal(typeof composition.inspectProductionScheduleReadiness, "function");
assert.equal(Object.isFrozen(resolvers), true, "Production schedule resolver bundle should be immutable after composition.");

const source = await readFile("src/schedule-dispatch-runtime.js", "utf8");
for (const phrase of [
  'createScheduleSkillDispatcher, inspectScheduleSkillReadiness',
  'resolveActiveScheduleGrant',
  'createScheduleProviderResolver, createScheduleResourceResolver',
  'createProductionScheduleExecutionResolvers({ resolveResourceIds = null } = {})',
  'resolveGrant: resolveActiveScheduleGrant',
  'createScheduleResourceResolver({ resolveResourceIds })'
]) assert.ok(source.includes(phrase), `Schedule dispatch composition missing: ${phrase}`);
for (const forbidden of ["bootSchedulesRuntime", "chrome.alarms", "setScheduleEnabled", "active: true", "GET_ACTIVE_TAB", "providerSecret", "connectionSecrets"]) {
  assert.equal(source.includes(forbidden), false, `Pre-activation schedule composition must not activate or widen authority: ${forbidden}`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["schedule-dispatch-runtime-check"], "node scripts/schedule-dispatch-runtime-check.mjs");
assert.equal(pkg.scripts?.["schedule-dispatch-runtime-smoke"], "node scripts/schedule-dispatch-runtime-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("node scripts/schedule-dispatch-runtime-check.mjs"), "npm run check must include production schedule composition contracts.");

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousStable.includes('"schedule-dispatch-runtime-smoke.mjs"'), "Chrome 152 matrix must include production schedule composition smoke coverage.");
const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run schedule-dispatch-runtime-smoke",
  "schedule-dispatch-runtime-evidence",
  "artifacts/schedule-dispatch-runtime-smoke"
]) assert.ok(workflow.includes(phrase), `Current-Chrome schedule composition evidence wiring missing: ${phrase}`);

const serviceWorker = await readFile("src/service-worker.js", "utf8");
for (const forbidden of ["schedule-dispatch-runtime.js", "createProductionScheduleSkillDispatcher", "bootSchedulesRuntime"]) {
  assert.equal(serviceWorker.includes(forbidden), false, `Production service worker must remain pre-activation: ${forbidden}`);
}
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "v0.2 production manifest must not gain alarms while composition is pre-activation.");

const smoke = await readFile("scripts/schedule-dispatch-runtime-smoke.mjs", "utf8");
for (const phrase of [
  'channel: "chromium",',
  'createProductionScheduleSkillDispatcher()',
  'mode: "preflight"',
  'browsercrew.scheduleRuns.v1',
  'browsercrew.skillRuns.v1',
  'assert.equal(production.alarms, false)'
]) assert.ok(smoke.includes(phrase), `Schedule composition browser proof missing: ${phrase}`);
assert.equal(smoke.includes('"2026-09-13T06:00:00.000Z"'), false, "Composition smoke must not use a future fixed grant creation timestamp.");
assert.ok(smoke.includes("Date.now() - 60_000"), "Composition smoke must create an already-valid grant relative to the test clock.");

console.log("BrowserCrew pre-activation production schedule dispatch composition contracts passed.");
