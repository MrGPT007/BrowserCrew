import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  assertPreparedScheduleMetadataForSkill,
  createPreparedScheduleMetadata,
  preparedScheduleNeedsBinding,
  validatePreparedScheduleMetadata
} from "../src/schedule-prepared-metadata.js";

const execFileAsync = promisify(execFile);
const reviewedAt = "2026-09-13T05:00:00.000Z";
const skill = {
  id: "prepared-binding-skill",
  version: "1.3.0",
  status: "approved",
  allowedOrigins: ["https://example.test"],
  allowedResources: ["catalog:suppliers"],
  actionClasses: ["read", "page_write_prepare"],
  providerRequirements: { capabilities: ["structured_output"] },
  dataDestinations: ["local_download"],
  budgets: { maxSteps: 8, maxMinutes: 6 }
};
const scheduleBase = {
  schemaVersion: 1,
  id: "prepared-binding-daily",
  enabled: false,
  skillRef: { id: skill.id, version: skill.version },
  grantRefs: []
};

const legacy = validatePreparedScheduleMetadata(scheduleBase);
assert.deepEqual(legacy, { ok: true, legacy: true, bindingReady: false, errors: [] });
assert.equal(preparedScheduleNeedsBinding(scheduleBase), true);
assert.throws(() => assertPreparedScheduleMetadataForSkill(scheduleBase, skill), (error) => error?.code === "SCHEDULE_BINDING_REQUIRED");

const metadata = createPreparedScheduleMetadata({ skill, pageUrl: "https://example.test/suppliers", reviewedAt });
const prepared = { ...scheduleBase, ...metadata };
assert.equal(metadata.startResource.url, "https://example.test/suppliers");
assert.equal(metadata.startResource.origin, "https://example.test");
assert.deepEqual(metadata.startResource.expectedResources, ["catalog:suppliers"]);
assert.equal(Object.prototype.hasOwnProperty.call(metadata.startResource, "tabId"), false, "Prepared starting-page metadata must never persist a Chrome tab id.");
assert.equal(metadata.authorityPlan.status, "prepared_only");
assert.deepEqual(metadata.authorityPlan.skillRef, scheduleBase.skillRef);
assert.deepEqual(metadata.authorityPlan.origins, skill.allowedOrigins);
assert.deepEqual(metadata.authorityPlan.resources, skill.allowedResources);
assert.deepEqual(metadata.authorityPlan.actionClasses, skill.actionClasses);
assert.deepEqual(metadata.authorityPlan.providerCapabilities, skill.providerRequirements.capabilities);
assert.deepEqual(metadata.authorityPlan.dataDestinations, skill.dataDestinations);
for (const forbidden of ["scope", "expiresAt", "revoked", "active", "token", "secret", "grantId", "id", "authorization", "cookie", "headers", "apiKey", "password"]) {
  assert.equal(Object.prototype.hasOwnProperty.call(metadata.authorityPlan, forbidden), false, `Prepared permission plans must not contain private or executable field ${forbidden}.`);
}
assert.deepEqual(validatePreparedScheduleMetadata(prepared), { ok: true, legacy: false, bindingReady: true, errors: [] });
assert.equal(preparedScheduleNeedsBinding(prepared), false);
assert.equal(assertPreparedScheduleMetadataForSkill(prepared, skill), true);

for (const [url, code] of [
  ["chrome://settings", "SCHEDULE_START_PAGE_INVALID"],
  ["https://user:pass@example.test/suppliers", "SCHEDULE_START_PAGE_PRIVATE_URL"],
  ["https://example.test/suppliers?account=123", "SCHEDULE_START_PAGE_PRIVATE_URL"],
  ["https://example.test/suppliers#private", "SCHEDULE_START_PAGE_PRIVATE_URL"],
  ["https://other.test/suppliers", "SCHEDULE_START_PAGE_OUT_OF_SCOPE"]
]) {
  assert.throws(() => createPreparedScheduleMetadata({ skill, pageUrl: url, reviewedAt }), (error) => error?.code === code, `${url} must fail with ${code}.`);
}

const withTab = structuredClone(prepared);
withTab.startResource.tabId = 42;
assert.equal(validatePreparedScheduleMetadata(withTab).ok, false);
assert.throws(() => assertPreparedScheduleMetadataForSkill(withTab, skill), (error) => error?.code === "SCHEDULE_BINDING_INVALID");

const withCookie = structuredClone(prepared);
withCookie.startResource.cookie = "session=NEVER_STORE";
assert.equal(validatePreparedScheduleMetadata(withCookie).ok, false, "Prepared startResource must reject cookie/session material.");

const activePlan = structuredClone(prepared);
activePlan.authorityPlan.status = "active";
assert.equal(validatePreparedScheduleMetadata(activePlan).ok, false, "A prepared plan must never become executable authority by flipping status.");

const withApiKey = structuredClone(prepared);
withApiKey.authorityPlan.apiKey = "NEVER_STORE";
assert.equal(validatePreparedScheduleMetadata(withApiKey).ok, false, "Prepared authority plan must reject credential material.");

const staleResources = structuredClone(prepared);
staleResources.authorityPlan.resources = [];
assert.throws(() => assertPreparedScheduleMetadataForSkill(staleResources, skill), (error) => error?.code === "SCHEDULE_AUTHORITY_PLAN_MISMATCH");

const staleStartResources = structuredClone(prepared);
staleStartResources.startResource.expectedResources = [];
assert.throws(() => assertPreparedScheduleMetadataForSkill(staleStartResources, skill), (error) => error?.code === "SCHEDULE_BINDING_RESOURCE_MISMATCH");

const mismatchedReview = structuredClone(prepared);
mismatchedReview.authorityPlan.reviewedAt = "2026-09-13T05:00:01.000Z";
assert.throws(() => assertPreparedScheduleMetadataForSkill(mismatchedReview, skill), (error) => error?.code === "SCHEDULE_BINDING_REVIEW_MISMATCH");

for (const file of [
  "src/schedule-prepared-metadata.js",
  "src/schedule-binding-ui.js",
  "src/schedule-dispatcher.js",
  "src/schedules-runtime.js",
  "scripts/schedule-binding-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const runtimeSource = await readFile("src/schedules-runtime.js", "utf8");
for (const phrase of [
  'case "setPreparedBinding": return setPreparedScheduleBinding(message.scheduleId, message.pageUrl)',
  "createPreparedScheduleMetadata",
  "assertPreparedScheduleMetadataForSkill",
  "SCHEDULE_BINDING_PREPARED_ONLY",
  "SCHEDULE_BINDING_ACTIVE_GRANT_PRESENT",
  "delete schedule.startResource",
  "delete schedule.authorityPlan",
  "preservePreparedMetadata(schedule, existingSnapshot, skillResult.skill)",
  "assertScheduleTargetUnchanged(current, existingSnapshot)",
  "schedule.startResource = structuredClone(existing.startResource)",
  "schedule.authorityPlan = structuredClone(existing.authorityPlan)"
]) assert.ok(runtimeSource.includes(phrase), `Prepared schedule runtime binding contract missing: ${phrase}`);

const bindingUi = await readFile("src/schedule-binding-ui.js", "utf8");
for (const phrase of [
  "assertPreparedScheduleMetadataForSkill",
  "Prepared-only requirements — this is not permission to run.",
  "No permission grant exists. Reviewing this page cannot run the schedule.",
  'type: "setPreparedBinding"',
  "Do not include query parameters",
  "no executable grant"
]) assert.ok(bindingUi.includes(phrase), `Prepared schedule binding UI contract missing: ${phrase}`);
for (const forbidden of ["GET_ACTIVE_TAB", "chrome.tabs.query", "tabId:"]) {
  assert.equal(bindingUi.includes(forbidden), false, `Prepared binding UI must require an explicit URL rather than guessing/persisting a tab: ${forbidden}`);
}

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./schedule-binding-ui.js"'), "The Skills surface must load the prepared schedule binding review UI.");

const smoke = await readFile("scripts/schedule-binding-smoke.mjs", "utf8");
for (const phrase of [
  "Legacy prepared schedule stays readable but visibly non-activation-ready",
  "Starting-page review rejects private/session URL data and out-of-scope websites",
  "Canonical starting page persists exact non-secret resource metadata and an inert permission plan only",
  "Ordinary prepared-schedule edits preserve reviewed binding without creating authority",
  "Binding review leaves activation, Run now, and Pause locked",
  'channel: "chromium",'
]) assert.ok(smoke.includes(phrase), `Prepared binding browser proof missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["schedule-prepared-metadata-check"], "node scripts/schedule-prepared-metadata-check.mjs");
assert.equal(pkg.scripts?.["schedule-binding-smoke"], "node scripts/schedule-binding-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("schedule-prepared-metadata-check.mjs"));
const setupSmoke = String(pkg.scripts?.["schedule-setup-smoke"] || "");
assert.ok(setupSmoke.includes("node scripts/schedule-setup-smoke.mjs") && setupSmoke.includes("node scripts/schedule-binding-smoke.mjs"), "Current Chrome prepared-schedule gate must include both setup and binding proof.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Prepared starting-page review must not activate scheduling.");
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Prepared starting-page review must not boot the scheduler.");
assert.equal(serviceWorker.includes("schedule-dispatcher"), false, "Prepared starting-page review must not wire the future dispatcher into production boot.");

console.log("BrowserCrew prepared schedule starting-resource and inert authority-plan contracts passed.");
