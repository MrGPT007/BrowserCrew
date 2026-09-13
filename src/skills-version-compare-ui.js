import { compareSkillVersions } from "./skills-version-diff.js";

const SKILLS_PORT = "browsercrew-skills";
let comparePanel = null;
let candidateSkill = null;
let versionChoices = [];

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list) return;
  enhanceCompareButtons(list);
  const observer = new MutationObserver(() => enhanceCompareButtons(list));
  observer.observe(list, { childList: true, subtree: true });
  card.addEventListener("click", onCompareAction);
  card.addEventListener("change", onCompareChange);
});

function enhanceCompareButtons(list) {
  for (const card of list.querySelectorAll("[data-skill-record]")) {
    if (card.dataset.skillRecord === "empty") continue;
    const actions = card.querySelector(".skill-actions");
    if (!actions || actions.querySelector("[data-compare-skill]")) continue;
    const [skillId, version] = String(card.dataset.skillRecord || "").split("@@");
    if (!skillId || !version) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-small tactile";
    button.textContent = "Compare versions";
    button.dataset.compareSkill = skillId;
    button.dataset.skillVersion = version;
    actions.append(button);
  }
}

async function onCompareAction(event) {
  const open = event.target.closest("[data-compare-skill]");
  if (open) return openCompare(open);
  if (event.target.closest("[data-close-version-compare]")) return closeCompare();
}

function onCompareChange(event) {
  const select = event.target.closest("[data-compare-base-version]");
  if (!select || !candidateSkill) return;
  const baseline = versionChoices.find((skill) => skill.version === select.value);
  if (!baseline) return;
  renderComparison(baseline, candidateSkill);
}

async function openCompare(button) {
  busy(button, true, "Opening…");
  try {
    const [exact, all] = await Promise.all([
      portRequest({ type: "get", skillId: button.dataset.compareSkill, version: button.dataset.skillVersion }),
      portRequest({ type: "list" })
    ]);
    if (!exact.ok || !exact.skill) throw new Error(exact.error?.message || "That exact Skill version could not be found.");
    if (!all.ok) throw new Error(all.error?.message || "BrowserCrew could not load saved Skill versions.");
    candidateSkill = exact.skill;
    versionChoices = (all.skills || [])
      .filter((skill) => skill.id === candidateSkill.id && skill.version !== candidateSkill.version)
      .sort((a, b) => compareSemver(b.version, a.version));
    if (!versionChoices.length) throw new Error("This saved Skill has only one version. Create another version before comparing changes.");
    renderPanel();
  } catch (error) {
    announce(error.message || "BrowserCrew could not compare those Skill versions.");
  } finally {
    busy(button, false, "Compare versions");
  }
}

function renderPanel() {
  const host = document.querySelector("#versionedSkillsCard");
  if (!host || !candidateSkill) return;
  comparePanel?.remove();
  comparePanel = document.createElement("section");
  comparePanel.className = "evidence-box";
  comparePanel.id = "skillVersionComparePanel";
  comparePanel.dataset.skillVersionCompare = "true";

  const heading = document.createElement("div");
  heading.className = "card-heading";
  const copy = document.createElement("div");
  const label = document.createElement("p");
  label.className = "step-label";
  label.textContent = "READ-ONLY VERSION COMPARE";
  const title = document.createElement("h3");
  title.textContent = candidateSkill.title;
  copy.append(label, title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button button-small tactile";
  close.textContent = "Close";
  close.dataset.closeVersionCompare = "true";
  heading.append(copy, close);
  comparePanel.append(heading);
  comparePanel.append(helper("Compare shows what changed between two exact versions. It cannot approve, run, save, archive, or grant site access."));
  comparePanel.append(helper("Changes that add access, increase limits, weaken safety, or add behavior are called out separately so you can review them before approval."));

  const picker = document.createElement("label");
  picker.className = "field-label";
  picker.textContent = `Compare from an earlier exact version to v${candidateSkill.version}`;
  const select = document.createElement("select");
  select.dataset.compareBaseVersion = "true";
  for (const skill of versionChoices) {
    const option = document.createElement("option");
    option.value = skill.version;
    option.textContent = `v${skill.version} · ${statusLabel(skill.status)}`;
    select.append(option);
  }
  picker.append(select);
  comparePanel.append(picker);

  const result = document.createElement("div");
  result.id = "skillVersionCompareResult";
  result.className = "selection-summary";
  result.setAttribute("aria-live", "polite");
  comparePanel.append(result);
  host.append(comparePanel);
  renderComparison(versionChoices[0], candidateSkill);
  comparePanel.scrollIntoView({ block: "nearest" });
}

function renderComparison(base, candidate) {
  const root = comparePanel?.querySelector("#skillVersionCompareResult");
  if (!root) return;
  const diff = compareSkillVersions(base, candidate);
  root.replaceChildren();

  const summary = document.createElement("div");
  summary.className = "card-heading";
  const text = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `v${diff.from.version} → v${diff.to.version}`;
  const detail = document.createElement("p");
  detail.textContent = diff.hasChanges
    ? `${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"} · ${diff.warningCount} need extra review${diff.wideningCount ? ` · ${diff.wideningCount} widen access, behavior, limits, or weaken safety` : ""}`
    : "No contract changes between these exact versions.";
  text.append(strong, detail);
  const badge = document.createElement("span");
  badge.className = `badge ${diff.wideningCount ? "badge-warning" : "badge-success"}`;
  badge.textContent = diff.wideningCount ? "Review widening" : "No widening found";
  summary.append(text, badge);
  root.append(summary);

  if (!diff.hasChanges) return;
  const sections = groupBySection(diff.changes);
  for (const [section, changes] of sections) {
    const block = document.createElement("div");
    block.className = "selection-summary";
    const heading = document.createElement("strong");
    heading.textContent = section;
    const list = document.createElement("ul");
    for (const item of changes) {
      const row = document.createElement("li");
      row.dataset.changeReview = item.review;
      const prefix = reviewLabel(item.review);
      row.textContent = `${prefix}${item.label}: ${describeChange(item)}`;
      list.append(row);
    }
    block.append(heading, list);
    root.append(block);
  }
}

function describeChange(item) {
  if (item.kind === "set_changed") {
    const parts = [];
    if (item.added?.length) parts.push(`added ${item.added.join(", ")}`);
    if (item.removed?.length) parts.push(`removed ${item.removed.join(", ")}`);
    return parts.join(" · ") || "changed";
  }
  if (item.kind === "added") return `added ${describeValue(item.after)}`;
  if (item.kind === "removed") return `removed ${describeValue(item.before)}`;
  return `${describeValue(item.before)} → ${describeValue(item.after)}`;
}

function describeValue(value) {
  if (value == null) return "none";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value.kind) {
    const target = value.target?.label || value.target?.ariaLabel || value.target?.role || "saved target";
    return `${value.kind} · ${target}${value.purpose ? ` · ${value.purpose}` : ""}`;
  }
  if (Object.prototype.hasOwnProperty.call(value, "secret")) {
    return `${value.type || "input"}${value.required ? " · required" : ""}${value.secret ? " · secret" : " · not secret"}${value.label ? ` · ${value.label}` : ""}`;
  }
  return "changed contract settings";
}

function reviewLabel(review) {
  if (review === "scope_widening") return "ACCESS WIDENING · ";
  if (review === "safety_weakening") return "SAFETY WEAKENING · ";
  if (review === "behavior_expansion") return "NEW BEHAVIOR · ";
  if (review === "behavior_change") return "BEHAVIOR CHANGE · ";
  if (review === "input_change") return "INPUT CHANGE · ";
  return "";
}

function groupBySection(changes) {
  const map = new Map();
  for (const change of changes) {
    if (!map.has(change.section)) map.set(change.section, []);
    map.get(change.section).push(change);
  }
  return map;
}

function closeCompare() {
  comparePanel?.remove();
  comparePanel = null;
  candidateSkill = null;
  versionChoices = [];
}

function portRequest(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: SKILLS_PORT });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("BrowserCrew did not answer in time.")); }, 10_000);
    port.onMessage.addListener(function onMessage(message) {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch {}
      resolve(message);
    });
    port.postMessage({ ...payload, requestId });
  });
}

function compareSemver(a, b) {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  return (left[0] || 0) - (right[0] || 0) || (left[1] || 0) - (right[1] || 0) || (left[2] || 0) - (right[2] || 0);
}
function statusLabel(status) { return status === "approved" ? "Approved" : status === "archived" ? "Archived" : "Draft"; }
function helper(text) { const p = document.createElement("p"); p.className = "helper"; p.textContent = text; return p; }
function busy(button, state, label) { if (!button) return; button.disabled = state; button.textContent = label; }
function announce(message) { const toast = document.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.hidden = false; clearTimeout(announce.timer); announce.timer = setTimeout(() => { toast.hidden = true; }, 4500); }
