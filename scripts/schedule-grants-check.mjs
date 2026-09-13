import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createPreparedScheduleMetadata } from "../src/schedule-prepared-metadata.js";
import {
  createScheduleGrant,
  validateScheduleGrant,
  assertScheduleGrantMatches,
  revokeScheduleGrant
} from "../src/schedule-grants-contract.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/schedule-grants-contract.js",
  "src/schedule-grants-runtime.js",
  "src/schedule-state-mutation.js",
  "src/schedule-grants-ui.js",
  "src/schedule-binding-ui.js",
  "src/schedules-runtime.js",
  "src/schedule-dispatcher.js",
  "scripts/schedule-grants-smoke.mjs",
  "scripts/schedule-grant-state-race-check.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const createdAt = "2026-09-13T06:00:00.000Z";
const expiresAt = "2026-10-13T06:00:00.000Z";
const skill = {
  id: "grant-skill",
  version: "2.0.0",
  status: "approved",
  allowedOrigins: ["https://example.test"],
  allowedResources: ["resource:orders"],
  actionClasses: ["read", "page_write_prepare"],
  providerRequirements: { capabilities: ["structured_output"] },
  dataDestinations: ["local_download"]
};
const metadata = createPreparedScheduleMetadata({ skill, pageUrl: "https://example.test/orders", reviewedAt: createdAt });
const schedule = {
  schemaVersion: 1,
  id: "grant-schedule",
  enabled: false,
  skillRef: { id: skill.id, version: skill.version },
  providerRef: "provider-a",
  grantRefs: [],
  ...metadata
};

const grant = createScheduleGrant({ id: "schedule-grant-1", schedule, skill, createdAt, expiresAt });
assert.equal(grant.scope, "schedule");
assert.equal(grant.status, "active");
assert.equal(grant.revoked, false);
assert.equal(grant.scheduleId, schedule.id);
assert.equal(grant.providerRef, schedule.providerRef);
assert.deepEqual(grant.skillRef, schedule.skillRef);
assert.deepEqual(grant.origins, skill.allowedOrigins);
assert.deepEqual(grant.resources, skill.allowedResources);
assert.deepEqual(grant.actionClasses, skill.actionClasses);
assert.deepEqual(grant.providerCapabilities, skill.providerRequirements.capabilities);
assert.deepEqual(grant.dataDestinations, skill.dataDestinations);
for (const forbidden of ["token", "secret", "apiKey", "password", "cookie", "authorization", "headers", "providerSecret", "inputValues", "runtimeInputs", "tabId"]) {
  assert.equal(Object.prototype.hasOwnProperty.call(grant, forbidden), false, `Schedule grant must not persist ${forbidden}.`);
}
assert.deepEqual(validateScheduleGrant(grant), { ok: true, errors: [] });
const referenced = { ...schedule, grantRefs: [grant.id] };
assert.equal(assertScheduleGrantMatches(referenced, skill, grant, { now: Date.parse(createdAt) + 1000 }), true);

assert.throws(() => createScheduleGrant({ id: "schedule-grant-2", schedule: { ...schedule, enabled: true }, skill, createdAt, expiresAt }), (error) => error?.code === "SCHEDULE_GRANT_PREPARED_ONLY");
assert.throws(() => createScheduleGrant({ id: "schedule-grant-2", schedule: referenced, skill, createdAt, expiresAt }), (error) => error?.code === "SCHEDULE_GRANT_ALREADY_REFERENCED");
assert.throws(() => createScheduleGrant({ id: "schedule-grant-2", schedule, skill, createdAt, expiresAt: createdAt }), (error) => error?.code === "SCHEDULE_GRANT_EXPIRY_INVALID");

const expired = { ...structuredClone(grant), expiresAt: "2026-09-13T06:00:01.000Z" };
assert.throws(() => assertScheduleGrantMatches(referenced, skill, expired, { now: Date.parse("2026-09-13T06:00:02.000Z") }), (error) => error?.code === "SCHEDULE_GRANT_EXPIRED");
const wrongSchedule = { ...structuredClone(grant), scheduleId: "other-schedule" };
assert.throws(() => assertScheduleGrantMatches(referenced, skill, wrongSchedule, { now: Date.parse(createdAt) + 1000 }), (error) => error?.code === "SCHEDULE_GRANT_SCHEDULE_MISMATCH");
const wrongProvider = { ...structuredClone(grant), providerRef: "provider-b" };
assert.throws(() => assertScheduleGrantMatches(referenced, skill, wrongProvider, { now: Date.parse(createdAt) + 1000 }), (error) => error?.code === "SCHEDULE_GRANT_PROVIDER_MISMATCH");
const unreferenced = { ...referenced, grantRefs: [] };
assert.throws(() => assertScheduleGrantMatches(unreferenced, skill, grant, { now: Date.parse(createdAt) + 1000 }), (error) => error?.code === "SCHEDULE_GRANT_REFERENCE_MISMATCH");
const changedPlan = structuredClone(referenced);
changedPlan.authorityPlan.resources = [];
assert.throws(() => assertScheduleGrantMatches(changedPlan, skill, grant, { now: Date.parse(createdAt) + 1000 }), (error) => ["SCHEDULE_AUTHORITY_PLAN_MISMATCH", "SCHEDULE_GRANT_SCOPE_CHANGED"].includes(error?.code));
const injected = { ...structuredClone(grant), apiKey: "NEVER_STORE" };
assert.equal(validateScheduleGrant(injected).ok, false);

const revoked = revokeScheduleGrant(grant, { revokedAt: "2026-09-14T06:00:00.000Z" });
assert.equal(revoked.status, "revoked");
assert.equal(revoked.revoked, true);
assert.equal(revoked.revokedReason, "user_revoked");
assert.equal(revoked.revokedAt, "2026-09-14T06:00:00.000Z");
assert.deepEqual(validateScheduleGrant(revoked), { ok: true, errors: [] });
assert.throws(() => assertScheduleGrantMatches(referenced, skill, revoked, { now: Date.parse("2026-09-14T06:00:01.000Z") }), (error) => error?.code === "SCHEDULE_GRANT_REVOKED");

const runtimeSource = await readFile("src/schedule-grants-runtime.js", "utf8");
for (const phrase of [
  'const SCHEDULE_GRANTS_KEY = "browsercrew.scheduleGrants.v1"',
  'const SCHEDULE_GRANTS_PORT = "browsercrew-schedule-grants"',
  'from "./schedule-state-mutation.js"',
  "approveScheduleGrant",
  "revokeScheduleGrantById",
  "withScheduleStateMutation(async () =>",
  "assertScheduleTargetUnchanged(current, scheduleSnapshot)",
  "assertScheduleEditAllowedWithGrant",
  "resolveActiveScheduleGrant",
  "revokeScheduleGrantsForDeletedSchedule",
  "scheduleStateLockHeld ? work() : withScheduleStateMutation(work)",
  "schedule_deleted"
]) assert.ok(runtimeSource.includes(phrase), `Schedule grant runtime contract missing: ${phrase}`);

const sharedStateSource = await readFile("src/schedule-state-mutation.js", "utf8");
for (const phrase of [
  "let scheduleStateMutation = null",
  "export async function withScheduleStateMutation(work)",
  "const previous = scheduleStateMutation || Promise.resolve()",
  "if (scheduleStateMutation === current) scheduleStateMutation = null"
]) assert.ok(sharedStateSource.includes(phrase), `Cross-module schedule state mutex missing: ${phrase}`);

const schedulesRuntime = await readFile("src/schedules-runtime.js", "utf8");
for (const phrase of [
  'from "./schedule-grants-runtime.js"',
  'from "./schedule-state-mutation.js"',
  "await assertScheduleEditAllowedWithGrant(existingSnapshot, schedule)",
  "assertScheduleTargetUnchanged(current, existingSnapshot)",
  "await resolveActiveScheduleGrant(schedule.grantRefs, { schedule, skill: skillResult.skill })",
  "await resolveActiveScheduleGrant(existing.grantRefs, { schedule: existing, skill: skillResult.skill })",
  "await revokeScheduleGrantsForDeletedSchedule(scheduleId, { scheduleStateLockHeld: true })"
]) assert.ok(schedulesRuntime.includes(phrase), `Schedule storage authority boundary missing: ${phrase}`);

const dispatcher = await readFile("src/schedule-dispatcher.js", "utf8");
assert.ok(dispatcher.includes("grant.providerRef !== schedule?.providerRef"), "Dispatcher must independently pin durable grant authority to the selected AI connection.");
assert.equal(dispatcher.includes("GET_ACTIVE_TAB"), false, "Scheduled dispatcher must still refuse active-tab guessing.");

const bindingUi = await readFile("src/schedule-binding-ui.js", "utf8");
assert.ok(bindingUi.includes('browsercrew:schedule-binding-updated'), "Starting-page review must refresh the permission-review surface immediately.");
const grantUi = await readFile("src/schedule-grants-ui.js", "utf8");
for (const phrase of [
  "Future permission:",
  "Approve future permission",
  "Revoke future permission",
  "still does not turn the schedule on",
  'const GRANTS_PORT = "browsercrew-schedule-grants"'
]) assert.ok(grantUi.includes(phrase), `Schedule grant review UI contract missing: ${phrase}`);

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./schedule-grants-ui.js"'), "Side panel must load durable schedule permission review.");

const smoke = await readFile("scripts/schedule-grants-smoke.mjs", "utf8");
for (const phrase of [
  'channel: "chromium",',
  "Approving future permission must not create a schedule run receipt.",
  "Active durable permission blocks provider changes",
  "Revocation clears executable refs",
  "Provider replacement requires a new permission grant",
  "Deleting a schedule must revoke its active durable authority"
]) assert.ok(smoke.includes(phrase), `Schedule grant installed-extension proof missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["schedule-grants-check"], "node scripts/schedule-grants-check.mjs");
assert.equal(pkg.scripts?.["schedule-grants-smoke"], "node scripts/schedule-grants-smoke.mjs");
const setupSmoke = String(pkg.scripts?.["schedule-setup-smoke"] || "");
for (const part of ["schedule-setup-smoke.mjs", "schedule-binding-smoke.mjs", "schedule-grants-smoke.mjs"]) assert.ok(setupSmoke.includes(part), `Current Chrome prepared-schedule gate missing ${part}.`);
assert.ok(String(pkg.scripts?.check || "").includes("schedule-grants-check.mjs"));

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousStable.includes('"schedule-grants-smoke.mjs"'), "Chrome 152 matrix must include durable schedule grant coverage.");

const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Durable grant review must not boot scheduled dispatch.");
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Durable grant review must not add alarms permission before activation.");

await import("./schedule-grant-state-race-check.mjs");

console.log("BrowserCrew durable exact-schedule grant lifecycle contracts passed.");
