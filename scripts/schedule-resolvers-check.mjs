import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createScheduleProviderResolver, createScheduleResourceResolver } from "../src/schedule-resolvers.js";

const execFileAsync = promisify(execFile);
for (const file of ["src/schedule-resolvers.js", "scripts/schedule-resolvers-smoke.mjs"]) await execFileAsync(process.execPath, ["--check", file]);

const connections = [
  { id: "provider-a", kind: "openai", model: "model-a", baseUrl: "https://api.example.test/v1", status: "connected", capabilities: ["structured_output"], lastTestedAt: "2026-09-13T05:00:00.000Z" },
  { id: "provider-b", kind: "openai", model: "model-b", baseUrl: "https://api.example.test/v1", status: "failed", capabilities: ["structured_output"] }
];
const resolveProvider = createScheduleProviderResolver({ readConnections: async () => structuredClone(connections) });
const provider = await resolveProvider("provider-a");
assert.deepEqual(provider, {
  id: "provider-a",
  available: true,
  capabilities: ["structured_output"],
  kind: "openai",
  model: "model-a",
  lastTestedAt: "2026-09-13T05:00:00.000Z"
});
assert.equal(JSON.stringify(provider).includes("baseUrl"), false, "Schedule provider readiness must not expose endpoint details it does not need.");
assert.equal((await resolveProvider("provider-b")).available, false);
await assert.rejects(() => resolveProvider("missing"), (error) => error?.code === "SCHEDULE_PROVIDER_UNAVAILABLE");

const skill = { allowedOrigins: ["https://example.test"], allowedResources: [] };
const schedule = { startResource: { kind: "exact_url", url: "https://example.test/orders", expectedResources: [] } };
let permissionChecks = [];
const resolveResource = createScheduleResourceResolver({
  containsOriginPermission: async (pattern) => { permissionChecks.push(pattern); return true; },
  listTabs: async () => [{ id: 42, url: "https://example.test/orders", title: "Orders" }, { id: 41, url: "https://example.test/other", title: "Other" }]
});
assert.deepEqual(await resolveResource({ schedule, skill }), {
  fresh: true,
  tabId: 42,
  url: "https://example.test/orders",
  resources: [],
  title: "Orders"
});
assert.deepEqual(permissionChecks, ["https://example.test/*"]);

const noPermission = createScheduleResourceResolver({ containsOriginPermission: async () => false, listTabs: async () => [{ id: 42, url: schedule.startResource.url }] });
await assert.rejects(() => noPermission({ schedule, skill }), (error) => error?.code === "SCHEDULE_SITE_PERMISSION_REQUIRED");
const missingTab = createScheduleResourceResolver({ containsOriginPermission: async () => true, listTabs: async () => [] });
await assert.rejects(() => missingTab({ schedule, skill }), (error) => error?.code === "SCHEDULE_RESOURCE_STALE");
const ambiguous = createScheduleResourceResolver({ containsOriginPermission: async () => true, listTabs: async () => [{ id: 1, url: schedule.startResource.url }, { id: 2, url: schedule.startResource.url }] });
await assert.rejects(() => ambiguous({ schedule, skill }), (error) => error?.code === "SCHEDULE_RESOURCE_AMBIGUOUS");
const wrongOrigin = createScheduleResourceResolver({ containsOriginPermission: async () => true, listTabs: async () => [{ id: 1, url: schedule.startResource.url }] });
await assert.rejects(() => wrongOrigin({ schedule, skill: { ...skill, allowedOrigins: ["https://other.test"] } }), (error) => error?.code === "SCHEDULE_RESOURCE_OUT_OF_SCOPE");

const resourceSkill = { allowedOrigins: ["https://example.test"], allowedResources: ["resource:orders"] };
const resourceSchedule = { startResource: { kind: "exact_url", url: "https://example.test/orders", expectedResources: ["resource:orders"] } };
const noResourceVerifier = createScheduleResourceResolver({ containsOriginPermission: async () => true, listTabs: async () => [{ id: 9, url: resourceSchedule.startResource.url }] });
await assert.rejects(() => noResourceVerifier({ schedule: resourceSchedule, skill: resourceSkill }), (error) => error?.code === "SCHEDULE_RESOURCE_ID_RESOLVER_REQUIRED");
const verifiedResource = createScheduleResourceResolver({
  containsOriginPermission: async () => true,
  listTabs: async () => [{ id: 9, url: resourceSchedule.startResource.url, title: "Orders" }],
  resolveResourceIds: async ({ expectedResources }) => [...expectedResources]
});
assert.deepEqual((await verifiedResource({ schedule: resourceSchedule, skill: resourceSkill })).resources, ["resource:orders"]);

const source = await readFile("src/schedule-resolvers.js", "utf8");
for (const phrase of [
  'const CONNECTIONS_KEY = "browsercrew.connections.v1"',
  "profile.status === \"connected\"",
  "chrome.permissions.contains",
  "chrome.tabs.query({})",
  "tab?.url === reviewedUrl",
  "SCHEDULE_RESOURCE_AMBIGUOUS",
  "SCHEDULE_RESOURCE_ID_RESOLVER_REQUIRED"
]) assert.ok(source.includes(phrase), `Schedule resolver contract missing: ${phrase}`);
for (const forbidden of ["GET_ACTIVE_TAB", "active: true", "chrome.storage.session", "connectionSecrets", "providerSecret", "baseUrl: profile.baseUrl"]) {
  assert.equal(source.includes(forbidden), false, `Schedule resolver must not use active-tab, endpoint, or secret state: ${forbidden}`);
}

const smoke = await readFile("scripts/schedule-resolvers-smoke.mjs", "utf8");
for (const phrase of [
  'channel: "chromium",',
  "no endpoint/secret state",
  "not active-tab state",
  "SCHEDULE_RESOURCE_AMBIGUOUS",
  "SCHEDULE_RESOURCE_ID_RESOLVER_REQUIRED",
  "creates no authority and no task or schedule run receipt"
]) assert.ok(smoke.includes(phrase), `Schedule resolver installed-extension proof missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["schedule-resolvers-check"], "node scripts/schedule-resolvers-check.mjs");
assert.equal(pkg.scripts?.["schedule-resolvers-smoke"], "node scripts/schedule-resolvers-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("schedule-resolvers-check.mjs"), "npm run check must include schedule resolver contracts.");

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousStable.includes('"schedule-resolvers-smoke.mjs"'), "Chrome 152 matrix must include schedule resolver coverage.");
const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of ["npm run schedule-resolvers-smoke", "name: schedule-resolvers-evidence", "path: artifacts/schedule-resolvers-smoke"]) {
  assert.ok(workflow.includes(phrase), `Current Chrome resolver evidence gate missing: ${phrase}`);
}

const serviceWorker = await readFile("src/service-worker.js", "utf8");
for (const forbidden of ["schedule-resolvers", "schedule-dispatcher", "bootSchedulesRuntime"]) {
  assert.equal(serviceWorker.includes(forbidden), false, `Pre-activation service worker must not wire ${forbidden}.`);
}
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Resolver primitives must not widen the active v0.2 manifest.");
assert.equal(Object.prototype.hasOwnProperty.call(manifest, "host_permissions"), false, "Resolver browser proof may use test-only host permission; production manifest must stay optional-site-access only.");

console.log("BrowserCrew pre-activation schedule provider/resource resolver contracts passed.");