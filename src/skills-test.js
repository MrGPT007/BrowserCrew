import { assertSkillExecutable, materializeSkillSteps } from "./skills-contract.js";

export async function testApprovedSkillOnPage({ skill, inputValues = {}, tabId } = {}) {
  assertSkillExecutable(skill);
  if (!Number.isInteger(tabId)) throw coded("SKILL_TAB_REQUIRED", "Choose the page where this skill should be tested.");
  const steps = materializeSkillSteps(skill, inputValues);
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !/^https?:/.test(tab.url)) throw coded("SKILL_UNSUPPORTED_PAGE", "Test works only on a normal website page.");
  const currentOrigin = new URL(tab.url).origin;
  if (!skill.allowedOrigins.includes(currentOrigin)) throw coded("SKILL_PAGE_OUT_OF_SCOPE", "This page is outside the websites reviewed for this skill.");

  const checks = [];
  let ready = true;
  for (const step of steps) {
    if (step.kind === "navigate") {
      const destination = new URL(step.url);
      const inScope = skill.allowedOrigins.includes(destination.origin);
      checks.push({ stepId: step.id, kind: step.kind, status: inScope ? "reviewed_only" : "blocked", message: inScope ? `Would navigate to ${destination.origin}; Test does not navigate.` : "Navigation leaves the reviewed website scope." });
      if (!inScope) ready = false;
      continue;
    }
    if (step.kind === "download") {
      checks.push({ stepId: step.id, kind: step.kind, status: "blocked", message: "Recorded download replay is not enabled." });
      ready = false;
      continue;
    }
    if (step.origin && step.origin !== currentOrigin) {
      checks.push({ stepId: step.id, kind: step.kind, status: "later_page", message: `This step belongs to ${step.origin}; Test did not navigate there.` });
      continue;
    }
    if (["click", "type", "select"].includes(step.kind)) {
      const inspected = await inspectTarget(step, tabId);
      checks.push({ stepId: step.id, kind: step.kind, status: inspected.ok ? "found" : "blocked", code: inspected.code || null, message: inspected.ok ? "Found one matching control without changing it." : humanTargetError(inspected.code) });
      if (!inspected.ok) ready = false;
      continue;
    }
    if (["waitFor", "verify"].includes(step.kind)) {
      const matches = await observeExpectation(step.expect, tabId);
      checks.push({ stepId: step.id, kind: step.kind, status: matches ? "matches_now" : "not_met_yet", message: matches ? "This saved condition matches now." : "This condition does not match yet; earlier steps may make it true." });
    }
  }

  return {
    ok: true,
    ready,
    skillRef: { id: skill.id, version: skill.version },
    page: { id: tab.id, title: String(tab.title || "").slice(0, 160), url: tab.url, origin: currentOrigin },
    requirements: {
      origins: [...skill.allowedOrigins],
      actionClasses: [...skill.actionClasses],
      dataDestinations: [...(skill.dataDestinations || [])],
      budgets: structuredClone(skill.budgets)
    },
    checks
  };
}

async function inspectTarget(step, tabId) {
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
        const label = `${labelOf(el)} ${text(el)} ${el.getAttribute?.("name") || ""} ${el.id || ""}`.replace(/\s+/g, " ").trim();
        if (/(?:delete|destroy|submit|send|save|publish|purchase|buy|pay|checkout|place\s+order|transfer|approve|confirm|unsubscribe|cancel\s+subscription)/i.test(label)) return { ok: false, code: "CLICK_REQUIRES_COMMIT_APPROVAL" };
        if (el instanceof HTMLButtonElement && ((el.type || "submit").toLowerCase() !== "button" || el.hasAttribute("formaction"))) return { ok: false, code: "CLICK_REQUIRES_COMMIT_APPROVAL" };
        if (el instanceof HTMLAnchorElement) {
          if (el.hasAttribute("download")) return { ok: false, code: "CLICK_REQUIRES_DOWNLOAD_APPROVAL" };
          if (new URL(el.href, location.href).origin !== location.origin) return { ok: false, code: "CLICK_LEAVES_APPROVED_SITE" };
        }
      }
      if (kind === "type" && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return { ok: false, code: "TARGET_NOT_EDITABLE" };
      if (kind === "select") {
        if (el instanceof HTMLSelectElement) {
          const option = [...el.options].find((item) => item.value === String(value) || item.text.trim() === String(value));
          if (!option) return { ok: false, code: "OPTION_NOT_FOUND" };
        } else if (!(el instanceof HTMLInputElement && ["checkbox", "radio"].includes((el.type || "").toLowerCase()))) return { ok: false, code: "TARGET_NOT_SELECTABLE" };
      }
      return { ok: true };
    },
    args: [{ kind: step.kind, target: step.target || {}, value: step.value }]
  });
  return result || { ok: false, code: "TARGET_NOT_FOUND" };
}

async function observeExpectation(expect, tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expected) => {
      if (expected?.visibleText && !String(document.body?.innerText || "").includes(expected.visibleText)) return false;
      if (expected?.urlIncludes && !location.href.includes(expected.urlIncludes)) return false;
      if (expected?.state === "document_complete" && document.readyState !== "complete") return false;
      if (expected?.role || expected?.label) {
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

function humanTargetError(code) {
  if (code === "TARGET_AMBIGUOUS") return "More than one control matches this saved step.";
  if (code === "CLICK_REQUIRES_COMMIT_APPROVAL") return "This saved click now looks like a final Save, Send, Delete, Pay, or other commit action and needs a different approval path.";
  if (code === "CLICK_REQUIRES_DOWNLOAD_APPROVAL") return "This saved click now starts a download and needs download approval.";
  if (code === "CLICK_LEAVES_APPROVED_SITE") return "This saved click now leaves the reviewed website.";
  if (code === "TARGET_NOT_EDITABLE") return "The saved control is no longer editable.";
  if (code === "TARGET_NOT_SELECTABLE") return "The saved control is no longer selectable.";
  if (code === "OPTION_NOT_FOUND") return "The saved choice is not available on this page.";
  return "The saved control could not be found on this page.";
}
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
