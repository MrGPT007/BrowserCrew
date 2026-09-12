import { assertSkillExecutable, materializeSkillSteps } from "./skills-contract.js";

const DEFAULT_STEP_TIMEOUT_MS = 15_000;

export async function runApprovedSkill({ skill, inputValues = {}, tabId, grant, onEvent = async () => {}, signal = null }) {
  assertSkillExecutable(skill);
  if (!Number.isInteger(tabId)) throw coded("SKILL_TAB_REQUIRED", "Choose the page where this skill should run.");
  assertGrantCoversSkill(skill, grant);
  const steps = materializeSkillSteps(skill, inputValues);
  if (steps.length > skill.budgets.maxSteps) throw coded("SKILL_STEP_BUDGET", "This skill contains more steps than its approved budget allows.");

  const startedAt = Date.now();
  const receipt = {
    schemaVersion: 1,
    kind: "browsercrew.skill_run",
    skillRef: { id: skill.id, version: skill.version },
    tabId,
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    steps: []
  };

  for (const step of steps) {
    assertNotAborted(signal);
    if (Date.now() - startedAt > skill.budgets.maxMinutes * 60_000) throw coded("SKILL_TIME_BUDGET", "This skill reached its approved time budget.");
    const tab = await chrome.tabs.get(tabId);
    assertTabInScope(tab, skill.allowedOrigins, step.origin);
    const stepReceipt = { id: step.id, kind: step.kind, startedAt: new Date().toISOString(), status: "running" };
    receipt.steps.push(stepReceipt);
    await onEvent({ type: "skill.step.intent", skillRef: receipt.skillRef, step: safeStepSummary(step), tab: safeTab(tab) });

    try {
      await executeStep({ step, tabId, skill, grant, signal });
      stepReceipt.status = "completed";
      stepReceipt.completedAt = new Date().toISOString();
      const after = await chrome.tabs.get(tabId);
      stepReceipt.page = safeTab(after);
      await onEvent({ type: "skill.step.complete", skillRef: receipt.skillRef, stepId: step.id, page: stepReceipt.page });
    } catch (error) {
      stepReceipt.status = "failed";
      stepReceipt.completedAt = new Date().toISOString();
      stepReceipt.error = safeError(error);
      receipt.status = "failed";
      receipt.completedAt = new Date().toISOString();
      receipt.error = safeError(error);
      await onEvent({ type: "skill.step.failed", skillRef: receipt.skillRef, stepId: step.id, error: stepReceipt.error });
      throw withReceipt(error, receipt);
    }
  }

  receipt.status = "completed";
  receipt.completedAt = new Date().toISOString();
  await onEvent({ type: "skill.run.complete", skillRef: receipt.skillRef, steps: receipt.steps.length });
  return { ok: true, receipt };
}

export function assertGrantCoversSkill(skill, grant = {}) {
  if (!grant || grant.revoked === true) throw coded("SKILL_GRANT_REQUIRED", "This saved skill still needs an active permission grant before it can run.");
  const origins = new Set(grant.origins || []);
  const actions = new Set(grant.actionClasses || []);
  const destinations = new Set(grant.dataDestinations || []);
  for (const origin of skill.allowedOrigins) if (!origins.has(origin)) throw coded("SKILL_ORIGIN_NOT_GRANTED", `This run is not allowed to use ${origin}.`);
  for (const action of skill.actionClasses) if (!actions.has(action)) throw coded("SKILL_ACTION_NOT_GRANTED", `This run is missing permission for ${action}.`);
  for (const destination of skill.dataDestinations || []) if (!destinations.has(destination)) throw coded("SKILL_DATA_DESTINATION_NOT_GRANTED", `This run is not allowed to send data to ${destination}.`);
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) throw coded("SKILL_GRANT_EXPIRED", "The permission for this skill expired. Review it before running again.");
  return true;
}

async function executeStep({ step, tabId, skill, grant, signal }) {
  assertNotAborted(signal);
  if (step.kind === "navigate") return navigateStep(step, tabId, skill.allowedOrigins);
  if (step.kind === "waitFor") return waitForStep(step, tabId, signal);
  if (step.kind === "verify") return verifyStep(step, tabId);
  if (["click", "type", "select"].includes(step.kind)) {
    if (!grant.actionClasses?.includes("page_write_prepare")) throw coded("SKILL_WRITE_GRANT_REQUIRED", "Review and approve this page change before BrowserCrew performs it.");
    return pageActionStep(step, tabId);
  }
  if (step.kind === "download") {
    if (!grant.actionClasses?.includes("download")) throw coded("SKILL_DOWNLOAD_GRANT_REQUIRED", "Review and approve downloads before BrowserCrew performs them.");
    throw coded("SKILL_DOWNLOAD_NOT_IMPLEMENTED", "Recorded download replay is not enabled yet. This skill stopped safely before downloading anything.");
  }
  throw coded("SKILL_STEP_UNSUPPORTED", `BrowserCrew does not know how to replay the ${step.kind} step yet.`);
}

async function navigateStep(step, tabId, allowedOrigins) {
  const url = new URL(step.url);
  if (!allowedOrigins.includes(url.origin)) throw coded("SKILL_NAVIGATION_OUT_OF_SCOPE", "The saved workflow tried to leave its approved site scope.");
  await chrome.tabs.update(tabId, { url: url.href });
  await waitForTabComplete(tabId, url.origin);
}

async function pageActionStep(step, tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: ({ kind, target, value }) => {
      const visible = (el) => Boolean(el && (el.getClientRects().length || el === document.activeElement));
      const text = (el) => String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
      const roleOf = (el) => {
        const explicit = el.getAttribute?.("role");
        if (explicit) return explicit;
        const tag = el.tagName?.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (["checkbox", "radio"].includes(type)) return type;
          if (["button", "submit", "reset"].includes(type)) return "button";
          return "textbox";
        }
        return "";
      };
      const labelOf = (el) => {
        const aria = el.getAttribute?.("aria-label");
        if (aria) return aria.trim();
        if (el.id) {
          try {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (label?.innerText) return label.innerText.trim();
          } catch {}
        }
        return text(el).slice(0, 200) || String(el.getAttribute?.("placeholder") || "").trim();
      };
      let candidates = [...document.querySelectorAll("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']")].filter(visible);
      if (target.testId) candidates = candidates.filter((el) => el.getAttribute("data-testid") === target.testId);
      if (target.id) candidates = candidates.filter((el) => el.id === target.id);
      if (target.role) candidates = candidates.filter((el) => roleOf(el) === target.role);
      const wantedLabel = target.label || target.ariaLabel;
      if (wantedLabel) candidates = candidates.filter((el) => labelOf(el) === wantedLabel);
      if (target.name) candidates = candidates.filter((el) => el.getAttribute("name") === target.name);
      if (candidates.length !== 1) return { ok: false, code: candidates.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND", count: candidates.length };
      const el = candidates[0];
      if (kind === "click") {
        el.click();
      } else if (kind === "type") {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return { ok: false, code: "TARGET_NOT_EDITABLE" };
        if (el instanceof HTMLInputElement && ["password"].includes((el.type || "").toLowerCase()) && typeof value !== "string") return { ok: false, code: "SECRET_INPUT_REQUIRED" };
        if (el.isContentEditable) el.textContent = String(value ?? "");
        else el.value = String(value ?? "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (kind === "select") {
        if (el instanceof HTMLSelectElement) {
          const option = [...el.options].find((item) => item.value === String(value) || item.text.trim() === String(value));
          if (!option) return { ok: false, code: "OPTION_NOT_FOUND" };
          el.value = option.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes((el.type || "").toLowerCase())) {
          const desired = Boolean(value);
          if (el.checked !== desired) el.click();
        } else return { ok: false, code: "TARGET_NOT_SELECTABLE" };
      }
      return { ok: true, url: location.href };
    },
    args: [{ kind: step.kind, target: step.target, value: step.value }]
  });
  if (!result?.ok) throw coded(`SKILL_${result?.code || "ACTION_FAILED"}`, humanActionError(result?.code));
}

async function verifyStep(step, tabId) {
  const ok = await observeExpectation(step.expect, tabId);
  if (!ok) throw coded("SKILL_VERIFY_FAILED", "The page did not match the saved completion check. BrowserCrew stopped instead of guessing.");
}

async function waitForStep(step, tabId, signal) {
  const deadline = Date.now() + Math.min(Number(step.timeoutMs) || DEFAULT_STEP_TIMEOUT_MS, 30_000);
  while (Date.now() < deadline) {
    assertNotAborted(signal);
    if (await observeExpectation(step.expect, tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw coded("SKILL_WAIT_TIMEOUT", "The page did not reach the saved condition before the wait limit.");
}

async function observeExpectation(expect, tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expected) => {
      if (expected.visibleText && !String(document.body?.innerText || "").includes(expected.visibleText)) return false;
      if (expected.urlIncludes && !location.href.includes(expected.urlIncludes)) return false;
      if (expected.state === "document_complete" && document.readyState !== "complete") return false;
      if (expected.role || expected.label) {
        const elements = [...document.querySelectorAll("button,a,input,textarea,select,[role]")];
        const match = elements.some((el) => {
          const role = el.getAttribute("role") || (el.tagName.toLowerCase() === "button" ? "button" : el.tagName.toLowerCase() === "a" ? "link" : "");
          const label = el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || "";
          return (!expected.role || role === expected.role) && (!expected.label || String(label).trim() === expected.label);
        });
        if (!match) return false;
      }
      return true;
    },
    args: [expect || {}]
  });
  return result === true;
}

async function waitForTabComplete(tabId, expectedOrigin) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    if (new URL(current.url).origin !== expectedOrigin) throw coded("SKILL_NAVIGATION_REDIRECTED", "The page redirected outside the expected site.");
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, coded("SKILL_NAVIGATION_TIMEOUT", "The page did not finish loading in time.")), DEFAULT_STEP_TIMEOUT_MS);
    const listener = (changedTabId, info, tab) => {
      if (changedTabId !== tabId || info.status !== "complete") return;
      try {
        if (new URL(tab.url).origin !== expectedOrigin) return finish(reject, coded("SKILL_NAVIGATION_REDIRECTED", "The page redirected outside the expected site."));
        finish(resolve);
      } catch (error) { finish(reject, error); }
    };
    const finish = (done, value) => { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); done(value); };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function assertTabInScope(tab, allowedOrigins, stepOrigin) {
  if (!tab?.url || !/^https?:/.test(tab.url)) throw coded("SKILL_UNSUPPORTED_PAGE", "This saved skill can run only on normal website pages.");
  const origin = new URL(tab.url).origin;
  if (!allowedOrigins.includes(origin)) throw coded("SKILL_PAGE_OUT_OF_SCOPE", "The selected page is outside this skill's reviewed site scope.");
  if (stepOrigin && stepOrigin !== origin) throw coded("SKILL_STEP_STALE", "The page changed from the site expected by the next saved step. BrowserCrew stopped before acting.");
}

function safeStepSummary(step) { return { id: step.id, kind: step.kind, purpose: step.purpose, origin: step.origin, target: step.target ? { role: step.target.role || null, label: step.target.label || step.target.ariaLabel || null, testId: step.target.testId || null } : null }; }
function safeTab(tab) { return { id: tab?.id || null, title: String(tab?.title || "").slice(0, 160), url: tab?.url || null }; }
function safeError(error) { return { code: error?.code || "SKILL_RUN_FAILED", message: error?.message || "The saved skill could not continue." }; }
function withReceipt(error, receipt) { error.receipt = receipt; return error; }
function assertNotAborted(signal) { if (signal?.aborted) throw coded("SKILL_RUN_STOPPED", "The saved skill was stopped. BrowserCrew will not start another step."); }
function humanActionError(code) {
  if (code === "TARGET_AMBIGUOUS") return "The page now has more than one matching control. BrowserCrew stopped instead of choosing one blindly.";
  if (code === "TARGET_NOT_FOUND") return "The saved control is no longer on this page. Review the skill before trying again.";
  if (code === "TARGET_NOT_EDITABLE") return "The saved field is no longer editable.";
  if (code === "TARGET_NOT_SELECTABLE") return "The saved choice control changed and can no longer be selected safely.";
  if (code === "OPTION_NOT_FOUND") return "The saved choice is no longer available on this page.";
  return "The saved page action could not be completed safely.";
}
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
