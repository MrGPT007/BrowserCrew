export const AGENT_POLICY_VERSION = 1;

export const AGENT_MODE_LIMITS = Object.freeze({
  compare: Object.freeze({ modelCalls: 2, toolCalls: 0, handoffs: 1 }),
  specialist: Object.freeze({ modelCalls: 1, toolCalls: 0, handoffs: 1 })
});

const BUDGET_KEYS = new Set(["modelCalls", "toolCalls", "handoffs"]);

export function createAgentPolicy({ mode, allowedConnectionIds, requestedBudgets = null } = {}) {
  const defaults = AGENT_MODE_LIMITS[mode];
  if (!defaults) throw policyError("AGENT_MODE_UNSUPPORTED", "Choose Compare two AIs or Hand off to another AI.");
  const allowList = [...new Set((allowedConnectionIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!allowList.length) throw policyError("AGENT_CONNECTION_ALLOWLIST_EMPTY", "This run has no approved AI destinations.");
  const budget = {};
  for (const key of BUDGET_KEYS) {
    const requested = requestedBudgets && Object.prototype.hasOwnProperty.call(requestedBudgets, key)
      ? Number(requestedBudgets[key])
      : defaults[key];
    const safeRequested = Number.isInteger(requested) && requested >= 0 ? requested : defaults[key];
    budget[key] = { max: Math.min(defaults[key], safeRequested), used: 0 };
  }
  return {
    schemaVersion: AGENT_POLICY_VERSION,
    mode,
    allowedConnectionIds: allowList,
    budget
  };
}

export function assertAgentConnectionAllowed(policy, connectionId) {
  if (!policy?.allowedConnectionIds?.includes(String(connectionId || ""))) {
    throw policyError("AGENT_CONNECTION_NOT_ALLOWED", "That AI connection is outside this run's approved destination list.");
  }
}

export function assertAgentNotCancelled(run) {
  if (run?.cancelled || run?.controller?.signal?.aborted) {
    throw policyError("AGENT_RUN_STOPPED", "This compare or handoff was stopped before BrowserCrew started more work.");
  }
}

export function consumeAgentBudget(policy, key) {
  if (!BUDGET_KEYS.has(key) || !policy?.budget?.[key]) {
    throw policyError("AGENT_BUDGET_UNKNOWN", "BrowserCrew could not verify this run's safety budget.");
  }
  const counter = policy.budget[key];
  if (counter.used >= counter.max) {
    const labels = { modelCalls: "AI-call", toolCalls: "tool-call", handoffs: "handoff" };
    const codeNames = { modelCalls: "MODEL", toolCalls: "TOOL", handoffs: "HANDOFF" };
    throw policyError(`AGENT_${codeNames[key]}_BUDGET_EXHAUSTED`, `This run reached its ${labels[key]} limit. BrowserCrew did not start another dispatch.`);
  }
  counter.used += 1;
  return { max: counter.max, used: counter.used, remaining: Math.max(0, counter.max - counter.used) };
}

export function publicAgentPolicy(policy) {
  return {
    schemaVersion: Number(policy?.schemaVersion || AGENT_POLICY_VERSION),
    mode: String(policy?.mode || ""),
    allowedConnectionIds: [...(policy?.allowedConnectionIds || [])],
    budget: {
      modelCalls: publicCounter(policy?.budget?.modelCalls),
      toolCalls: publicCounter(policy?.budget?.toolCalls),
      handoffs: publicCounter(policy?.budget?.handoffs)
    }
  };
}

export function canonicalAgentJson(value) {
  return JSON.stringify(sortJson(value));
}

export function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicCounter(counter) {
  return { max: Number(counter?.max || 0), used: Number(counter?.used || 0) };
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
  return sorted;
}
