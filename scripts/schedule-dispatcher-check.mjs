import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

globalThis.chrome = {
  runtime: { onConnect: { addListener() {} } },
  storage: {
    local: {
      async get() { return {}; },
      async set() {}
    }
  }
};

const {
  createScheduleSkillDispatcher,
  inspectScheduleSkillReadiness
} = await import("../src/schedule-dispatcher.js");

const now = "2026-09-13T04:30:00.000Z";
const skill = {
  schemaVersion: 1,
  id: "scheduled-order-check",
  version: "1.0.0",
  status: "approved",
  title: "Check scheduled orders",
  description: "Open the reviewed orders page and verify the saved result condition.",
  inputs: {
    region: { type: "string", required: true, secret: false, label: "Region", default: "west" }
  },
  allowedOrigins: ["https://example.test"],
  allowedResources: ["resource:orders"],
  actionClasses: ["read"],
  dataDestinations: [],
  providerRequirements: { capabilities: ["structured_output"] },
  budgets: { maxSteps: 5, maxMinutes: 5 },
  steps: [{
    id: "verify-orders",
    kind: "verify",
    purpose: "Verify the reviewed orders page is ready.",
    origin: "https://example.test",
    expect: { visibleText: "Orders ready" }
  }],
  completionCriteria: [{ claim: "Orders are ready.", verification: "The reviewed page shows Orders ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: now },
  approval: { approvedAt: now, approvedBy: "user" },
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  createdAt: now,
  updatedAt: now,
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
};
const schedule = {
  schemaVersion: 1,
  id: "scheduled-order-check-daily",
  name: "Scheduled order check",
  enabled: true,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 9, minute: 0 },
  missedRunPolicy: "ask",
  concurrencyPolicy: "skip_if_running",
  providerRef: "provider-a",
  grantRefs: ["grant-a"],
  budgets: { maxSteps: 5, maxMinutes: 5 },
  createdAt: now,
  updatedAt: now,
  nextRunAt: null
};
const provider = { id: "provider-a", available: true, capabilities: ["structured_output"] };
const grant = {
  id: "grant-a",
  scope: "schedule",
  skillRef: { id: skill.id, version: skill.version },
  origins: ["https://example.test"],
  resources: ["resource:orders"],
  actionClasses: ["read"],
  providerCapabilities: ["structured_output"],
  dataDestinations: [],
  revoked: false,
  expiresAt: "2099-01-01T00:00:00.000Z"
};
const resource = { fresh: true, tabId: 42, url: "https://example.test/orders", resources: ["resource:orders"] };

const resolvers = () => ({
  resolveProvider: async (id) => ({ ...provider, id }),
  resolveGrant: async () => structuredClone(grant),
  resolveResource: async () => structuredClone(resource)
});

assert.throws(() => createScheduleSkillDispatcher({}), (error) => error?.code === "SCHEDULE_PROVIDER_RESOLVER_REQUIRED");

const ready = await inspectScheduleSkillReadiness({ schedule, skill, ...resolvers() });
assert.equal(ready.ready, true);
assert.equal(ready.grantsValid, true);
assert.equal(ready.providerAvailable, true);
assert.equal(ready.resourceFresh, true);
assert.deepEqual(ready.blockers, []);
assert.deepEqual(ready.inputNames, ["region"]);
assert.equal(JSON.stringify(ready).includes("west"), false, "Readiness summaries must not expose unattended input values.");
assert.deepEqual(ready.resource, { tabId: 42, url: "https://example.test/orders", resources: ["resource:orders"] });
assert.deepEqual(ready.provider, provider);

let preflightExecutions = 0;
const preflightDispatcher = createScheduleSkillDispatcher({
  ...resolvers(),
  executeSkill: async () => { preflightExecutions += 1; return { ok: true }; }
});
const preflight = await preflightDispatcher({ mode: "preflight", schedule, skill });
assert.deepEqual(preflight, { grantsValid: true, providerAvailable: true, resourceFresh: true, blockers: [] });
assert.equal(preflightExecutions, 0, "Preflight must never create a Skill run.");

const resolutionCounts = { provider: 0, grant: 0, resource: 0 };
let executed = null;
const dispatcher = createScheduleSkillDispatcher({
  resolveProvider: async () => { resolutionCounts.provider += 1; return structuredClone(provider); },
  resolveGrant: async () => { resolutionCounts.grant += 1; return structuredClone(grant); },
  resolveResource: async () => { resolutionCounts.resource += 1; return structuredClone(resource); },
  executeSkill: async (input) => {
    executed = structuredClone(input);
    return { ok: true, run: { id: "skill-run-1", status: "completed", error: null } };
  }
});
const dispatched = await dispatcher({ schedule, skill, scheduleRunId: "schedule-run-1" });
assert.equal(dispatched.ok, true);
assert.equal(dispatched.taskId, "skill-run-1");
assert.deepEqual(dispatched.task, { id: "skill-run-1", status: "completed", error: null });
assert.deepEqual(resolutionCounts, { provider: 2, grant: 2, resource: 2 }, "Authority, provider, and resource state must be re-resolved immediately before execution.");
assert.deepEqual(executed, {
  skillId: skill.id,
  version: skill.version,
  tabId: 42,
  inputValues: { region: "west" },
  grant
});

let raceResourceChecks = 0;
let raceExecutions = 0;
const raceDispatcher = createScheduleSkillDispatcher({
  resolveProvider: async () => structuredClone(provider),
  resolveGrant: async () => structuredClone(grant),
  resolveResource: async () => {
    raceResourceChecks += 1;
    return raceResourceChecks === 1 ? structuredClone(resource) : { ...structuredClone(resource), fresh: false };
  },
  executeSkill: async () => { raceExecutions += 1; return { ok: true }; }
});
await assert.rejects(() => raceDispatcher({ schedule, skill }), (error) => error?.code === "SCHEDULE_RESOURCE_STALE");
assert.equal(raceResourceChecks, 2);
assert.equal(raceExecutions, 0, "A resource that changes after preflight must block before the Skill executor creates a run.");

await assert.rejects(
  () => preflightDispatcher({ mode: "preflight", schedule: { ...schedule, budgets: { maxSteps: 6, maxMinutes: 5 } }, skill }),
  (error) => error?.code === "SCHEDULE_BUDGET_WIDENED"
);
await assert.rejects(
  () => preflightDispatcher({ mode: "preflight", schedule: { ...schedule, skillRef: { id: skill.id, version: "2.0.0" } }, skill }),
  (error) => error?.code === "SCHEDULE_SKILL_VERSION_CHANGED"
);

const providerMissingCapability = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveProvider: async () => ({ id: "provider-a", available: true, capabilities: [] })
});
assert.equal(providerMissingCapability.ready, false);
assert(providerMissingCapability.blockers.some((item) => item.code === "SCHEDULE_PROVIDER_CAPABILITY_MISSING"));

const unavailableProvider = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveProvider: async () => ({ id: "provider-a", available: false, capabilities: ["structured_output"] })
});
assert.equal(unavailableProvider.ready, false);
assert(unavailableProvider.blockers.some((item) => item.code === "SCHEDULE_PROVIDER_UNAVAILABLE"));

const wrongScopeGrant = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveGrant: async () => ({ ...structuredClone(grant), scope: "one_run" })
});
assert.equal(wrongScopeGrant.ready, false);
assert(wrongScopeGrant.blockers.some((item) => item.code === "SCHEDULE_GRANT_SKILL_MISMATCH"));

const expiredGrant = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveGrant: async () => ({ ...structuredClone(grant), expiresAt: "2020-01-01T00:00:00.000Z" })
});
assert.equal(expiredGrant.ready, false);
assert(expiredGrant.blockers.some((item) => item.code === "SCHEDULE_GRANT_INVALID"));

const narrowGrant = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveGrant: async () => ({ ...structuredClone(grant), resources: [] })
});
assert.equal(narrowGrant.ready, false);
assert(narrowGrant.blockers.some((item) => item.code === "SCHEDULE_GRANT_INVALID"));

const staleResource = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveResource: async () => ({ ...structuredClone(resource), fresh: false })
});
assert.equal(staleResource.ready, false);
assert(staleResource.blockers.some((item) => item.code === "SCHEDULE_RESOURCE_STALE"));

const wrongOrigin = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveResource: async () => ({ ...structuredClone(resource), url: "https://other.test/orders" })
});
assert.equal(wrongOrigin.ready, false);
assert(wrongOrigin.blockers.some((item) => item.code === "SCHEDULE_RESOURCE_OUT_OF_SCOPE"));

const missingResource = await inspectScheduleSkillReadiness({
  schedule,
  skill,
  ...resolvers(),
  resolveResource: async () => ({ ...structuredClone(resource), resources: [] })
});
assert.equal(missingResource.ready, false);
assert(missingResource.blockers.some((item) => item.code === "SCHEDULE_RESOURCE_STALE"));

const inputMissingSkill = structuredClone(skill);
delete inputMissingSkill.inputs.region.default;
const inputMissing = await inspectScheduleSkillReadiness({ schedule, skill: inputMissingSkill, ...resolvers() });
assert.equal(inputMissing.ready, false);
assert(inputMissing.blockers.some((item) => item.code === "SCHEDULE_INPUT_REQUIRED"));

const secretSkill = structuredClone(skill);
secretSkill.inputs.region.secret = true;
delete secretSkill.inputs.region.default;
const secretInput = await inspectScheduleSkillReadiness({ schedule, skill: secretSkill, ...resolvers() });
assert.equal(secretInput.ready, false);
assert(secretInput.blockers.some((item) => item.code === "SCHEDULE_SECRET_INPUT_REQUIRED"));

for (const file of ["src/schedule-dispatcher.js", "src/schedules-runtime.js"]) await execFileAsync(process.execPath, ["--check", file]);

const dispatcherSource = await readFile("src/schedule-dispatcher.js", "utf8");
for (const phrase of [
  "executeSkillVersion",
  "SCHEDULE_SECRET_INPUT_REQUIRED",
  "SCHEDULE_GRANT_SKILL_MISMATCH",
  "SCHEDULE_PROVIDER_CAPABILITY_MISSING",
  "SCHEDULE_RESOURCE_OUT_OF_SCOPE",
  "Re-resolve immediately before dispatch",
  "throwBlocker"
]) if (!dispatcherSource.includes(phrase)) throw new Error(`Schedule dispatcher safety contract missing: ${phrase}`);
for (const forbidden of ["GET_ACTIVE_TAB", "chrome.tabs.query", "chrome.tabs.getCurrent"]) {
  if (dispatcherSource.includes(forbidden)) throw new Error(`Schedule dispatcher must not guess the user's active tab: ${forbidden}`);
}

const serviceWorkerSource = await readFile("src/service-worker.js", "utf8");
if (serviceWorkerSource.includes("schedule-dispatcher")) throw new Error("The pre-activation service worker must not import the schedule dispatcher yet.");
if (serviceWorkerSource.includes("bootSchedulesRuntime")) throw new Error("The v0.2 feature branch must not boot scheduled dispatch yet.");
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if ((manifest.permissions || []).includes("alarms")) throw new Error("Do not add alarms permission before the post-v0.2 activation release.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["schedule-dispatcher-check"] !== "node scripts/schedule-dispatcher-check.mjs") throw new Error("schedule-dispatcher-check must stay directly runnable.");
if (!String(pkg.scripts?.check || "").includes("schedule-dispatcher-check.mjs")) throw new Error("npm run check must include the schedule dispatcher boundary.");

const docs = await readFile("docs/POST-V0.2-AUTOMATION.md", "utf8");
for (const phrase of [
  "Fail-closed schedule dispatcher",
  "does not guess the active tab",
  "schedule-scoped grant",
  "re-resolves provider, grant, and starting resource immediately before execution"
]) if (!docs.includes(phrase)) throw new Error(`Post-v0.2 architecture docs missing dispatcher boundary: ${phrase}`);

console.log("BrowserCrew fail-closed schedule-to-Skill dispatcher contracts passed.");
