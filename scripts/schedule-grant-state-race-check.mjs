import assert from "node:assert/strict";
import { createPreparedScheduleMetadata } from "../src/schedule-prepared-metadata.js";
import { createScheduleGrant } from "../src/schedule-grants-contract.js";

const SCHEDULES_KEY = "browsercrew.schedules.v1";
const SCHEDULE_GRANTS_KEY = "browsercrew.scheduleGrants.v1";
const SKILL_LIBRARY_KEY = "browsercrew.skillLibrary.v1";
const SKILL_RUNS_KEY = "browsercrew.skillRuns.v1";
const clone = (value) => structuredClone(value);
const storage = new Map();
let tracking = false;
let holdCombinedWrite = false;
let combinedSetCount = 0;
let scheduleOnlySetCount = 0;
let combinedWriteEnteredResolve = null;
let releaseCombinedWriteResolve = null;
let combinedWriteEntered = null;
let releaseCombinedWrite = null;

function eventBucket() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

function armCombinedGrantWriteBarrier() {
  tracking = true;
  holdCombinedWrite = true;
  combinedSetCount = 0;
  scheduleOnlySetCount = 0;
  combinedWriteEntered = new Promise((resolve) => { combinedWriteEnteredResolve = resolve; });
  releaseCombinedWrite = new Promise((resolve) => { releaseCombinedWriteResolve = resolve; });
  return {
    entered: combinedWriteEntered,
    release() {
      holdCombinedWrite = false;
      releaseCombinedWriteResolve();
    }
  };
}

async function settleTurns() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

globalThis.chrome = {
  runtime: {
    onConnect: eventBucket(),
    onStartup: eventBucket(),
    onInstalled: eventBucket()
  },
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return Object.fromEntries([...storage.entries()].map(([key, value]) => [key, clone(value)]));
        const wanted = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        return Object.fromEntries(wanted.filter((key) => storage.has(key)).map((key) => [key, clone(storage.get(key))]));
      },
      async set(values) {
        const writesSchedules = Object.prototype.hasOwnProperty.call(values, SCHEDULES_KEY);
        const writesGrants = Object.prototype.hasOwnProperty.call(values, SCHEDULE_GRANTS_KEY);
        if (tracking && writesSchedules && writesGrants) {
          combinedSetCount += 1;
          if (holdCombinedWrite && combinedSetCount === 1) {
            combinedWriteEnteredResolve();
            await releaseCombinedWrite;
          }
        } else if (tracking && writesSchedules) {
          scheduleOnlySetCount += 1;
        }
        for (const [key, value] of Object.entries(values)) storage.set(key, clone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
      }
    }
  },
  alarms: {
    onAlarm: eventBucket(),
    async create() {},
    async clear() { return true; },
    async get() { return null; },
    async getAll() { return []; }
  }
};

const createdAt = "2026-09-13T06:00:00.000Z";
const skill = {
  schemaVersion: 1,
  id: "grant-state-race-skill",
  version: "1.0.0",
  status: "approved",
  title: "Verify grant schedule state",
  description: "Test-only approved Skill for cross-module schedule and grant persistence races.",
  inputs: {},
  allowedOrigins: ["https://example.test"],
  allowedResources: [],
  actionClasses: ["read"],
  dataDestinations: [],
  providerRequirements: { capabilities: [] },
  budgets: { maxSteps: 5, maxMinutes: 5 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Verify ready state.", origin: "https://example.test", expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "Ready state is visible.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt },
  approval: { approvedAt: createdAt, approvedBy: "user" },
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  createdAt,
  updatedAt: createdAt,
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
};
const prepared = createPreparedScheduleMetadata({ skill, pageUrl: "https://example.test/ready", reviewedAt: createdAt });

function schedule(id, { enabled = false, name = null, grantRefs = [] } = {}) {
  return {
    schemaVersion: 1,
    id,
    name: name || id.replaceAll("-", " "),
    enabled,
    skillRef: { id: skill.id, version: skill.version },
    timezone: "UTC",
    recurrence: { kind: "daily", hour: 9, minute: 30 },
    missedRunPolicy: "ask",
    concurrencyPolicy: "skip_if_running",
    providerRef: "grant-race-provider",
    grantRefs: [...grantRefs],
    budgets: { maxSteps: 5, maxMinutes: 5 },
    ...clone(prepared),
    createdAt,
    updatedAt: createdAt,
    lastRunAt: null,
    nextRunAt: null
  };
}

storage.set(SKILL_LIBRARY_KEY, [skill]);
storage.set(SKILL_RUNS_KEY, []);
storage.set(SCHEDULES_KEY, []);
storage.set(SCHEDULE_GRANTS_KEY, []);

const scheduleRuntime = await import("../src/schedules-runtime.js");
const grantRuntime = await import("../src/schedule-grants-runtime.js");

function resetState(schedules, grants = []) {
  tracking = false;
  holdCombinedWrite = false;
  storage.set(SCHEDULES_KEY, clone(schedules));
  storage.set(SCHEDULE_GRANTS_KEY, clone(grants));
}

async function readState() {
  tracking = false;
  const data = await chrome.storage.local.get([SCHEDULES_KEY, SCHEDULE_GRANTS_KEY]);
  return {
    schedules: data[SCHEDULES_KEY] || [],
    grants: data[SCHEDULE_GRANTS_KEY] || []
  };
}

async function proveApprovalVsPause() {
  const grantTarget = schedule("grant-approval-target");
  const pauseTarget = schedule("pause-target", { enabled: true });
  resetState([grantTarget, pauseTarget]);

  const barrier = armCombinedGrantWriteBarrier();
  const approval = grantRuntime.approveScheduleGrant(
    grantTarget.id,
    new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  );
  await barrier.entered;

  const pause = scheduleRuntime.setScheduleEnabled(pauseTarget.id, false);
  await settleTurns();
  const competingWriteBeforeRelease = scheduleOnlySetCount;

  barrier.release();
  await Promise.all([approval, pause]);
  const state = await readState();
  assert.equal(
    competingWriteBeforeRelease,
    0,
    "Pause must wait while grant approval owns the shared schedule/grant mutation instead of persisting a competing schedule snapshot."
  );
  assert.equal(state.schedules.find((item) => item.id === pauseTarget.id)?.enabled, false, "Grant approval must not resurrect a concurrently paused schedule.");
  const approved = state.schedules.find((item) => item.id === grantTarget.id);
  assert.equal(approved?.grantRefs?.length, 1, "Grant approval must still persist its exact durable permission reference.");
  assert.equal(state.grants.filter((grant) => grant.scheduleId === grantTarget.id && grant.status === "active").length, 1);
}

async function proveRevocationVsEdit() {
  const grantTargetWithoutRef = schedule("grant-revoke-target");
  const activeGrant = createScheduleGrant({
    id: "schedule-grant:grant-state-race",
    schedule: grantTargetWithoutRef,
    skill,
    createdAt,
    expiresAt: "2027-09-13T06:00:00.000Z"
  });
  const grantTarget = { ...grantTargetWithoutRef, grantRefs: [activeGrant.id] };
  const editTarget = schedule("edit-target", { name: "Before edit" });
  resetState([grantTarget, editTarget], [activeGrant]);

  const barrier = armCombinedGrantWriteBarrier();
  const revocation = grantRuntime.revokeScheduleGrantById(grantTarget.id, activeGrant.id);
  await barrier.entered;

  const edit = scheduleRuntime.saveSchedule({ ...editTarget, name: "After edit" });
  await settleTurns();
  const competingWriteBeforeRelease = scheduleOnlySetCount;

  barrier.release();
  await Promise.all([revocation, edit]);
  const state = await readState();
  assert.equal(
    competingWriteBeforeRelease,
    0,
    "Save/Edit must wait while grant revocation owns the shared schedule/grant mutation instead of persisting a competing schedule snapshot."
  );
  assert.equal(state.schedules.find((item) => item.id === editTarget.id)?.name, "After edit", "Grant revocation must not overwrite a concurrent schedule edit.");
  assert.deepEqual(state.schedules.find((item) => item.id === grantTarget.id)?.grantRefs, [], "Revocation must clear the exact schedule grant reference.");
  assert.equal(state.grants.find((grant) => grant.id === activeGrant.id)?.status, "revoked", "Revocation receipt must remain durable.");
}

await proveApprovalVsPause();
await proveRevocationVsEdit();

const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Cross-module grant-state hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await (await import("node:fs/promises")).readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Cross-module grant-state hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew cross-module schedule/grant state mutation checks passed.");
