import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { materializeSkillSteps, promoteSkillDraft, validateSkill } from "../src/skills-contract.js";
import { createWatchSession, draftSkillFromWatchSession, recordWatchEvent, stopWatchSession } from "../src/watch-me-contract.js";
import { assertScheduleDispatchable, nextCalendarRun, reconcileAlarmNames, toChromeAlarmSpec, validateSchedule } from "../src/schedules-contract.js";
import { assertGrantCoversSkill } from "../src/skills-runner.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/skills-contract.js",
  "src/skills-runtime.js",
  "src/skills-runner.js",
  "src/watch-me-contract.js",
  "src/watch-me-runtime.js",
  "src/schedules-contract.js",
  "src/schedules-runtime.js"
]) await execFileAsync(process.execPath, ["--check", file]);

const origin = "https://example.test";
let watch = createWatchSession({ id: "watch-001", tabId: 7, origin, startedAt: "2026-09-12T12:00:00.000Z" });
watch = recordWatchEvent(watch, {
  id: "step-01",
  kind: "navigate",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  url: `${origin}/form`,
  occurredAt: "2026-09-12T12:00:01.000Z"
});
watch = recordWatchEvent(watch, {
  id: "step-02",
  kind: "type",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-12T12:00:02.000Z",
  target: { role: "textbox", label: "Email address", name: "email" },
  variableName: "emailAddress",
  value: "person@example.com"
});
watch = recordWatchEvent(watch, {
  id: "step-03",
  kind: "select",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-12T12:00:02.500Z",
  target: { role: "combobox", label: "Department", name: "department" },
  variableName: "department",
  value: "private-demonstration-choice"
});
watch = recordWatchEvent(watch, {
  id: "step-04",
  kind: "click",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-12T12:00:03.000Z",
  target: { role: "button", label: "Preview" }
});
watch = recordWatchEvent(watch, {
  id: "step-05",
  kind: "verify",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-12T12:00:04.000Z",
  expect: { visibleText: "Ready to review" }
});
watch = stopWatchSession(watch, "2026-09-12T12:00:05.000Z");

const draft = draftSkillFromWatchSession(watch, {
  skillId: "demo-form-review",
  title: "Prepare the review form",
  description: "Open the form, enter reviewed run-time inputs, choose Preview, and verify the review state.",
  createdAt: "2026-09-12T12:00:05.000Z"
});
assert.equal(draft.status, "draft");
assert.equal(draft.inputs.emailAddress.default, undefined);
assert.equal(draft.inputs.department.default, undefined);
assert.equal(JSON.stringify(draft).includes("person@example.com"), false, "Watch Me must parameterize typed values rather than persisting demonstration literals.");
assert.equal(JSON.stringify(draft).includes("private-demonstration-choice"), false, "Watch Me must parameterize selected values rather than persisting demonstration literals.");
assert.equal(validateSkill(draft).ok, true);

const approved = promoteSkillDraft(draft, { approvedAt: "2026-09-12T12:01:00.000Z" });
const materialized = materializeSkillSteps(approved, { emailAddress: "run@example.com", department: "Sales" });
assert.equal(materialized[1].value, "run@example.com");
assert.equal(materialized[2].value, "Sales");

const fullGrant = {
  origins: [origin],
  actionClasses: ["read", "page_write_prepare"],
  dataDestinations: [],
  revoked: false,
  expiresAt: "2099-01-01T00:00:00.000Z"
};
assert.equal(assertGrantCoversSkill(approved, fullGrant), true);
assert.throws(() => assertGrantCoversSkill(approved, { ...fullGrant, actionClasses: ["read"] }), /missing permission/);
assert.throws(() => assertGrantCoversSkill(approved, { ...fullGrant, revoked: true }), /active permission grant/);

let secretWatch = createWatchSession({ id: "watch-secret", tabId: 8, origin, startedAt: "2026-09-12T12:02:00.000Z" });
secretWatch = recordWatchEvent(secretWatch, {
  id: "step-secret",
  kind: "type",
  tabId: 8,
  origin,
  pageUrl: `${origin}/login`,
  occurredAt: "2026-09-12T12:02:01.000Z",
  target: { role: "textbox", type: "password", label: "Password", name: "password", autocomplete: "current-password" },
  variableName: "accountPassword",
  value: "NEVER_PERSIST_THIS_PASSWORD"
});
secretWatch = stopWatchSession(secretWatch, "2026-09-12T12:02:02.000Z");
const secretDraft = draftSkillFromWatchSession(secretWatch, {
  skillId: "login-helper",
  title: "Enter a login value",
  description: "Use a private runtime value without storing the demonstrated secret.",
  createdAt: "2026-09-12T12:02:02.000Z"
});
assert.equal(JSON.stringify(secretDraft).includes("NEVER_PERSIST_THIS_PASSWORD"), false);
assert.equal(secretDraft.inputs.accountPassword.secret, true);
assert.equal(secretDraft.inputs.accountPassword.default, undefined);

assert.throws(() => recordWatchEvent(createWatchSession({ id: "watch-origin", tabId: 9, origin, startedAt: "2026-09-12T12:03:00.000Z" }), {
  id: "step-cross-origin",
  kind: "navigate",
  tabId: 9,
  origin: "https://other.test",
  pageUrl: "https://other.test/",
  url: "https://other.test/",
  occurredAt: "2026-09-12T12:03:01.000Z"
}), /approved site scope/);

const forbidden = structuredClone(approved);
forbidden.remoteCode = "https://evil.test/a.js";
assert.equal(validateSkill(forbidden).ok, false, "Skills must reject executable remote-code fields.");
const coordinateMacro = structuredClone(approved);
coordinateMacro.steps[3].target.coordinates = { x: 10, y: 20 };
assert.equal(validateSkill(coordinateMacro).ok, false, "Skills must reject raw coordinate replay targets.");

const schedule = {
  schemaVersion: 1,
  id: "daily-review",
  name: "Daily review",
  enabled: true,
  skillRef: { id: approved.id, version: approved.version },
  timezone: "Asia/Kolkata",
  recurrence: { kind: "daily", hour: 9, minute: 30 },
  missedRunPolicy: "run_once_when_available",
  concurrencyPolicy: "skip_if_running",
  providerRef: "local-a",
  grantRefs: [],
  budgets: { maxSteps: 30, maxMinutes: 20 }
};
assert.equal(validateSchedule(schedule).ok, true);
assert.equal(assertScheduleDispatchable(schedule, approved, { grantsValid: true, providerAvailable: true, resourceFresh: true }), true);
assert.throws(() => assertScheduleDispatchable(schedule, approved, { grantsValid: false }), /grant expired or was revoked/);
assert.throws(() => assertScheduleDispatchable(schedule, approved, { resourceFresh: false }), /stale or changed/);
const draftOnlySchedule = { ...schedule, skillRef: { id: draft.id, version: draft.version } };
assert.throws(() => assertScheduleDispatchable(draftOnlySchedule, draft, { grantsValid: true, providerAvailable: true, resourceFresh: true }), /Only approved skill versions may execute/);

const now = Date.parse("2026-09-12T03:00:00.000Z"); // 08:30 Asia/Kolkata
const next = nextCalendarRun(schedule, now);
assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(next)), "09:30");
const alarmSpec = toChromeAlarmSpec(schedule, now);
assert.equal(alarmSpec.when, next);
assert.equal(Object.prototype.hasOwnProperty.call(alarmSpec, "periodInMinutes"), false, "Calendar schedules must be one-shot alarms so DST/timezone changes are recalculated after each fire.");
assert.equal(alarmSpec.persistAcrossSessions, true);

const newYorkSchedule = { ...schedule, id: "daily-new-york", timezone: "America/New_York", recurrence: { kind: "daily", hour: 9, minute: 30 } };
const beforeDst = Date.parse("2026-03-07T16:00:00.000Z");
const afterDst = Date.parse("2026-03-08T16:00:00.000Z");
const beforeDstNext = nextCalendarRun(newYorkSchedule, beforeDst);
const afterDstNext = nextCalendarRun(newYorkSchedule, afterDst);
assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(beforeDstNext)), "09:30");
assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(afterDstNext)), "09:30");

const intervalSchedule = {
  ...schedule,
  id: "interval-review",
  recurrence: { kind: "interval", everyMinutes: 60 }
};
assert.equal(toChromeAlarmSpec(intervalSchedule, now).periodInMinutes, 60);

assert.deepEqual(reconcileAlarmNames([schedule], [{ name: "browsercrew.schedule.old" }]), {
  create: ["browsercrew.schedule.daily-review"],
  clear: ["browsercrew.schedule.old"]
});

console.log("BrowserCrew post-v0.2 Skills, Watch Me, and Schedules contract checks passed.\n");
