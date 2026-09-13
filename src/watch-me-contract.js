import { validateSkill } from "./skills-contract.js";

export const WATCH_ME_SCHEMA_VERSION = 1;
export const WATCH_ME_EVENT_KINDS = Object.freeze(["navigate", "click", "type", "select", "waitFor", "verify", "download"]);

const SENSITIVE_FIELD_TYPES = new Set(["password"]);
const SENSITIVE_AUTOCOMPLETE = /(?:cc-number|cc-csc|cc-exp|current-password|new-password|one-time-code)/i;
const SENSITIVE_NAME = /(?:password|passwd|passcode|secret|token|api.?key|authorization|auth.?key|credit.?card|card.?number|cvc|cvv|security.?code)/i;

export function createWatchSession({ id, tabId, origin, startedAt }) {
  if (!id || !Number.isInteger(tabId) || !origin || !startedAt) throw new Error("Watch session requires id, tabId, origin, and startedAt.");
  return {
    schemaVersion: WATCH_ME_SCHEMA_VERSION,
    id,
    status: "watching",
    approvedTabs: [tabId],
    approvedOrigins: [origin],
    startedAt,
    stoppedAt: null,
    events: [],
    variables: {},
    warnings: []
  };
}

export function recordWatchEvent(session, rawEvent) {
  assertWatchSession(session);
  if (session.status !== "watching") throw new Error("Watch session is not recording.");
  const event = sanitizeWatchEvent(rawEvent, session);
  if (!event) return session;
  return { ...session, events: [...session.events, event] };
}

export function sanitizeWatchEvent(rawEvent, session) {
  if (!rawEvent || !WATCH_ME_EVENT_KINDS.includes(rawEvent.kind)) throw new Error("Unsupported Watch Me event.");
  if (!session.approvedTabs.includes(rawEvent.tabId)) throw new Error("Watch Me event came from an unapproved tab.");
  if (!session.approvedOrigins.includes(rawEvent.origin)) throw new Error("Watch Me paused because the workflow left the approved site scope.");
  if (["type", "select"].includes(rawEvent.kind) && String(rawEvent.target?.type || "").toLowerCase() === "hidden") return null;

  const base = {
    id: rawEvent.id,
    kind: rawEvent.kind,
    tabId: rawEvent.tabId,
    origin: rawEvent.origin,
    pageUrl: safeUrl(rawEvent.pageUrl, rawEvent.origin),
    occurredAt: rawEvent.occurredAt,
    target: sanitizeTarget(rawEvent.target)
  };

  if (rawEvent.kind === "type" || rawEvent.kind === "select") {
    const sensitivity = classifyInput(rawEvent.target || {});
    const variableName = normalizeVariableName(rawEvent.variableName || deriveVariableName(rawEvent.target || {}, session.events.length + 1), session.events.length + 1);
    const type = inputTypeForEvent(rawEvent);
    base.value = `{{input.${variableName}}}`;
    base.input = { name: variableName, type, required: true, secret: sensitivity.secret, label: sensitivity.label };
    base.recordedLiteral = false;
    if (sensitivity.secret) base.redaction = "secret_value_never_recorded";
  } else if (rawEvent.kind === "navigate") {
    base.url = safeUrl(rawEvent.url, rawEvent.origin);
  } else if (rawEvent.kind === "waitFor" || rawEvent.kind === "verify") {
    base.expect = sanitizeExpectation(rawEvent.expect);
  } else if (rawEvent.kind === "download") {
    const expectedUrlOrigin = rawEvent.downloadOrigin || rawEvent.origin;
    if (!session.approvedOrigins.includes(expectedUrlOrigin)) throw new Error("Watch Me ignored a download that left the approved site scope.");
    base.download = { userInitiated: true, expectedUrlOrigin };
  }

  return base;
}

export function stopWatchSession(session, stoppedAt) {
  assertWatchSession(session);
  if (!stoppedAt) throw new Error("stoppedAt is required.");
  return { ...session, status: "stopped", stoppedAt };
}

export function draftSkillFromWatchSession(session, { skillId, version = "0.1.0", title, description, createdAt } = {}) {
  assertWatchSession(session);
  if (session.status !== "stopped") throw new Error("Stop Watch Me before creating a draft skill.");
  if (!session.events.length) throw new Error("Cannot create a skill from an empty demonstration.");

  const inputs = {};
  const steps = session.events.map((event, index) => {
    if (event.input) inputs[event.input.name] = event.input;
    const step = { id: event.id || `step-${String(index + 1).padStart(2, "0")}`, kind: event.kind, purpose: humanPurpose(event), origin: event.origin };
    if (event.target) step.target = event.target;
    if (event.value !== undefined) step.value = event.value;
    if (event.url) step.url = event.url;
    if (event.expect) step.expect = event.expect;
    if (event.download) step.download = event.download;
    return step;
  });

  const draft = {
    schemaVersion: 1,
    id: skillId,
    version,
    status: "draft",
    title,
    description,
    inputs,
    allowedOrigins: [...new Set(session.approvedOrigins)],
    actionClasses: inferActionClasses(steps),
    dataDestinations: [],
    budgets: { maxSteps: Math.max(10, steps.length * 3), maxMinutes: 30 },
    steps,
    completionCriteria: [{ claim: "The demonstrated workflow reached its user-reviewed final state.", verification: "Re-observe the final page/resource and require the reviewed completion check before reporting success." }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "watch_me_demonstration", sessionId: session.id, createdAt: createdAt || session.stoppedAt, eventCount: session.events.length }
  };

  const validation = validateSkill(draft);
  if (!validation.ok) throw new Error(`Watch Me produced an invalid skill draft: ${validation.errors.join(" ")}`);
  return draft;
}

export function classifyInput(target) {
  const type = String(target.type || "").toLowerCase();
  const autocomplete = String(target.autocomplete || "");
  const identity = [target.name, target.id, target.label, target.ariaLabel, target.placeholder].filter(Boolean).join(" ");
  const secret = SENSITIVE_FIELD_TYPES.has(type) || SENSITIVE_AUTOCOMPLETE.test(autocomplete) || SENSITIVE_NAME.test(identity);
  return { secret, label: secret ? "Private value" : cleanLabel(target) || "Recorded input" };
}

function inputTypeForEvent(event) {
  const type = String(event.target?.type || "").toLowerCase();
  if (["checkbox", "radio"].includes(type)) return "boolean";
  return "string";
}

function sanitizeTarget(target) {
  if (!target || typeof target !== "object") return undefined;
  const result = {};
  for (const [key, value] of Object.entries({ role: target.role, label: target.label, ariaLabel: target.ariaLabel, name: target.name, id: target.id, testId: target.testId, type: target.type, autocomplete: target.autocomplete, placeholder: target.placeholder })) {
    if (typeof value === "string" && value.trim()) result[key] = value.slice(0, 200);
  }
  if (!result.role && !result.label && !result.ariaLabel && !result.id && !result.testId) return undefined;
  return result;
}

function sanitizeExpectation(expect) {
  if (!expect || typeof expect !== "object") throw new Error("Wait/verify event requires an expectation.");
  const out = {};
  for (const key of ["visibleText", "urlIncludes", "role", "label", "state"]) if (typeof expect[key] === "string" && expect[key].trim()) out[key] = expect[key].slice(0, 300);
  if (!Object.keys(out).length) throw new Error("Expectation needs a bounded observable condition.");
  return out;
}

function safeUrl(value, expectedOrigin) {
  const url = new URL(value);
  if (url.origin !== expectedOrigin) throw new Error("Recorded URL left the approved origin.");
  url.username = "";
  url.password = "";
  return url.href;
}

function deriveVariableName(target, index) {
  const candidate = cleanLabel(target).toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c) => c ? c.toUpperCase() : "").replace(/^[^a-z]+/, "");
  return candidate || `input${index}`;
}

function normalizeVariableName(value, index) {
  let name = String(value || "").trim().replace(/[^a-zA-Z0-9_]+(.)?/g, (_, c) => c ? c.toUpperCase() : "").replace(/^[^a-z]+/i, "");
  if (!/^[a-z]/.test(name)) name = `input${index}${name ? name[0].toUpperCase() + name.slice(1) : ""}`;
  return name.slice(0, 64) || `input${index}`;
}

function cleanLabel(target) {
  return String(target.label || target.ariaLabel || target.name || target.id || target.placeholder || "").trim().slice(0, 80);
}

function inferActionClasses(steps) {
  const map = new Set(["read"]);
  if (steps.some((step) => ["click", "type", "select"].includes(step.kind))) map.add("page_write_prepare");
  if (steps.some((step) => step.kind === "download")) map.add("download");
  return [...map];
}

function humanPurpose(event) {
  const label = event.target?.label || event.target?.ariaLabel || event.target?.role || "the demonstrated target";
  if (event.kind === "navigate") return "Open the demonstrated page within the approved site.";
  if (event.kind === "click") return `Choose ${label}.`;
  if (event.kind === "type") return `Enter the reviewed ${event.input?.label || "input"} in ${label}.`;
  if (event.kind === "select") return `Choose the reviewed ${event.input?.label || "option"} in ${label}.`;
  if (event.kind === "waitFor") return "Wait for the demonstrated page condition.";
  if (event.kind === "verify") return "Verify the demonstrated result before continuing.";
  if (event.kind === "download") return "Download the user-selected file and verify completion.";
  return "Follow the demonstrated step.";
}

function assertWatchSession(session) {
  if (!session || session.schemaVersion !== WATCH_ME_SCHEMA_VERSION || !Array.isArray(session.approvedTabs) || !Array.isArray(session.approvedOrigins) || !Array.isArray(session.events)) throw new Error("Invalid Watch Me session.");
}
