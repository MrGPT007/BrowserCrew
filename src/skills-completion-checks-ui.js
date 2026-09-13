import { listDraftCompletionChecks, MAX_DRAFT_COMPLETION_CHECKS, MAX_DRAFT_COMPLETION_TEXT, updateDraftCompletionChecks } from "./skills-completion-checks.js";

const SKILLS_PORT = "browsercrew-skills";
let activePanel = null;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list) return;
  enhance(list);
  new MutationObserver(() => enhance(list)).observe(list, { childList: true, subtree: true });
  card.addEventListener("click", onAction);
});

function enhance(list) {
  for (const card of list.querySelectorAll('[data-skill-status="draft"][data-skill-record]')) {
    if (card.dataset.skillRecord === "empty") continue;
    const actions = card.querySelector(".skill-actions");
    if (!actions || actions.querySelector("[data-completion-checks]")) continue;
    const [skillId, version] = String(card.dataset.skillRecord || "").split("@@");
    if (!skillId || !version) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-small tactile";
    button.textContent = "Success checks";
    button.dataset.completionChecks = skillId;
    button.dataset.skillVersion = version;
    actions.prepend(button);
  }
}

async function onAction(event) {
  const open = event.target.closest("[data-completion-checks]");
  if (open) return openPanel(open);
  if (event.target.closest("[data-close-completion-checks]")) return closePanel();
  if (event.target.closest("[data-add-completion-check]")) return addRow();
  const remove = event.target.closest("[data-remove-completion-check]");
  if (remove) return remove.closest("[data-completion-check-row]")?.remove();
  const save = event.target.closest("[data-save-completion-checks]");
  if (save) return saveChecks(save);
}

async function openPanel(button) {
  busy(button, true, "Opening…");
  try {
    const response = await portRequest({ type: "get", skillId: button.dataset.completionChecks, version: button.dataset.skillVersion });
    if (!response.ok || !response.skill) throw new Error(response.error?.message || "BrowserCrew could not load that exact draft.");
    if (response.skill.status !== "draft") throw new Error("Success checks can only be edited on an exact draft version.");
    renderPanel(response.skill);
  } catch (error) {
    announce(error.message || "BrowserCrew could not open success checks.");
  } finally {
    busy(button, false, "Success checks");
  }
}

function renderPanel(skill) {
  const host = document.querySelector("#versionedSkillsCard");
  if (!host) return;
  activePanel?.remove();
  const panel = document.createElement("section");
  panel.className = "evidence-box";
  panel.id = "skillCompletionChecksPanel";
  panel.dataset.skillId = skill.id;
  panel.dataset.skillVersion = skill.version;

  const heading = document.createElement("div");
  heading.className = "card-heading";
  const text = document.createElement("div");
  const label = document.createElement("p");
  label.className = "step-label";
  label.textContent = "SUCCESS CHECKS";
  const title = document.createElement("h3");
  title.textContent = `${skill.title} · v${skill.version}`;
  text.append(label, title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button button-small tactile";
  close.textContent = "Close";
  close.dataset.closeCompletionChecks = "true";
  heading.append(text, close);
  panel.append(heading);

  panel.append(helper("Add up to five short pieces of visible page text that must be present before BrowserCrew can report success."));
  panel.append(helper("These are extra checks only. They cannot replace the original final result check, add websites or actions, grant permission, or approve this draft."));
  panel.append(helper("Use public status text such as “Review complete”. Do not put names, emails, account numbers, passwords, tokens, or other private values here."));

  const final = skill.steps?.at(-1);
  const finalSummary = document.createElement("div");
  finalSummary.className = "selection-summary";
  finalSummary.dataset.lockedFinalCheck = "true";
  const finalStrong = document.createElement("strong");
  finalStrong.textContent = "Original final check · locked";
  const finalText = document.createElement("p");
  finalText.textContent = summarizeExpectation(final?.expect);
  finalSummary.append(finalStrong, finalText);
  panel.append(finalSummary);

  const list = document.createElement("div");
  list.id = "skillCompletionCheckList";
  for (const check of listDraftCompletionChecks(skill)) list.append(createRow(check.visibleText));
  panel.append(list);

  const row = document.createElement("div");
  row.className = "button-row";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "button tactile";
  add.textContent = "Add another check";
  add.dataset.addCompletionCheck = "true";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button button-primary tactile";
  save.textContent = "Save success checks";
  save.dataset.saveCompletionChecks = "true";
  row.append(add, save);
  panel.append(row);
  panel.append(helper("Saving keeps this exact version as a draft. Every saved extra check becomes a real verification step when this version is later approved and run."));

  host.append(panel);
  activePanel = panel;
  if (!list.children.length) addRow();
  panel.scrollIntoView({ block: "nearest" });
}

function addRow() {
  if (!activePanel) return;
  const list = activePanel.querySelector("#skillCompletionCheckList");
  if (!list) return;
  if (list.children.length >= MAX_DRAFT_COMPLETION_CHECKS) return announce(`Keep at most ${MAX_DRAFT_COMPLETION_CHECKS} added success checks.`);
  const row = createRow("");
  list.append(row);
  row.querySelector("input")?.focus();
}

function createRow(value) {
  const row = document.createElement("div");
  row.className = "selection-summary";
  row.dataset.completionCheckRow = "true";
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "Visible text that proves success";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = MAX_DRAFT_COMPLETION_TEXT;
  input.autocomplete = "off";
  input.value = value;
  input.dataset.completionCheckText = "true";
  label.append(input);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button button-small tactile";
  remove.textContent = "Remove this check";
  remove.dataset.removeCompletionCheck = "true";
  row.append(label, remove);
  return row;
}

async function saveChecks(button) {
  if (!activePanel) return;
  busy(button, true, "Checking…");
  try {
    const response = await portRequest({ type: "get", skillId: activePanel.dataset.skillId, version: activePanel.dataset.skillVersion });
    if (!response.ok || response.skill?.status !== "draft") throw new Error("This exact version is no longer an editable draft.");
    const values = [...activePanel.querySelectorAll("[data-completion-check-text]")].map((input) => input.value);
    const updated = updateDraftCompletionChecks(response.skill, values);
    const saved = await portRequest({ type: "saveDraft", skill: updated });
    if (!saved.ok) throw new Error(saved.error?.message || "BrowserCrew could not save these success checks.");
    closePanel();
    document.querySelector('[data-skill-filter="draft"]')?.click();
    announce("Success checks saved. This exact version is still a draft and has not gained any permission.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not save these success checks.");
  } finally {
    busy(button, false, "Save success checks");
  }
}

function closePanel() {
  activePanel?.remove();
  activePanel = null;
}

function summarizeExpectation(expect = {}) {
  if (expect.visibleText) return `Visible text: “${expect.visibleText}”`;
  if (expect.urlIncludes) return `Page address includes: ${expect.urlIncludes}`;
  if (expect.role || expect.label) return `Visible control: ${[expect.role, expect.label].filter(Boolean).join(" · ")}`;
  if (expect.state) return `Page state: ${expect.state}`;
  return "Saved final verification";
}

function helper(value) {
  const p = document.createElement("p");
  p.className = "helper";
  p.textContent = value;
  return p;
}

function portRequest(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: SKILLS_PORT });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("BrowserCrew did not answer in time.")); }, 10_000);
    const onMessage = (message) => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch {}
      resolve(message);
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({ ...payload, requestId });
  });
}

function busy(button, state, label) {
  if (!button) return;
  button.disabled = state;
  button.textContent = label;
}

function announce(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
