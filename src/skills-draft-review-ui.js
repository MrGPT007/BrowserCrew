import { reviewSkillDraft } from "./skills-draft-review.js";

const SKILLS_PORT = "browsercrew-skills";
let activeEditor = null;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list) return;
  enhanceDraftCards(list);
  const observer = new MutationObserver(() => enhanceDraftCards(list));
  observer.observe(list, { childList: true, subtree: true });
  card.addEventListener("click", onReviewAction);
});

function enhanceDraftCards(list) {
  for (const approve of list.querySelectorAll("[data-approve-skill]")) {
    const actions = approve.closest(".skill-actions");
    if (!actions || actions.querySelector("[data-review-skill]")) continue;
    const review = document.createElement("button");
    review.className = "button button-small tactile";
    review.type = "button";
    review.textContent = "Review & edit draft";
    review.dataset.reviewSkill = approve.dataset.approveSkill || "";
    review.dataset.skillVersion = approve.dataset.skillVersion || "";
    actions.prepend(review);
  }
}

async function onReviewAction(event) {
  const review = event.target.closest("[data-review-skill]");
  const cancel = event.target.closest("[data-cancel-draft-review]");
  const save = event.target.closest("[data-save-draft-review]");
  if (review) return openDraftReview(review);
  if (cancel) return closeDraftReview(cancel.closest("[data-draft-review-editor]"));
  if (save) return saveDraftReview(save);
}

async function openDraftReview(button) {
  busy(button, true, "Opening…");
  try {
    const response = await portRequest(SKILLS_PORT, {
      type: "get",
      skillId: button.dataset.reviewSkill,
      version: button.dataset.skillVersion
    });
    if (!response.ok || !response.skill) throw new Error(response.error?.message || "BrowserCrew could not load that draft.");
    if (response.skill.status !== "draft") throw new Error("Only a draft skill version can be edited.");
    const host = document.querySelector("#versionedSkillsCard");
    if (!host) throw new Error("BrowserCrew could not open the stable Skill review surface.");
    activeEditor?.remove();
    activeEditor = createDraftEditor(response.skill);
    host.append(activeEditor);
    activeEditor.querySelector("[data-draft-title]")?.focus();
  } catch (error) {
    announce(error.message || "BrowserCrew could not open this draft for review.");
  } finally {
    busy(button, false, "Review & edit draft");
  }
}

function createDraftEditor(skill) {
  const editor = document.createElement("section");
  editor.className = "evidence-box";
  editor.dataset.draftReviewEditor = "true";
  editor.dataset.skillId = skill.id;
  editor.dataset.skillVersion = skill.version;

  const heading = document.createElement("div");
  heading.className = "card-heading";
  const headingText = document.createElement("div");
  const label = document.createElement("p");
  label.className = "step-label";
  label.textContent = "DRAFT REVIEW";
  const title = document.createElement("h3");
  title.textContent = `Review ${skill.title}`;
  headingText.append(label, title);
  const badge = document.createElement("span");
  badge.className = "badge badge-warning";
  badge.textContent = "Still a draft";
  heading.append(headingText, badge);
  editor.append(heading);

  editor.append(helper("Changes stay in this exact draft version. This screen cannot add websites, actions, permissions, budgets, or runtime values."));
  editor.append(helper("You can only make this draft narrower: remove an unused recorded website or action, never add a new one."));
  editor.append(helper("Recorded runtime values are never displayed here. Rename the labels BrowserCrew asks for when the skill runs."));

  editor.append(fieldLabel("Draft name", "draftReviewTitle"));
  const titleInput = input("text", skill.title, 120);
  titleInput.id = "draftReviewTitle";
  titleInput.dataset.draftTitle = "true";
  editor.append(titleInput);

  editor.append(fieldLabel("What this saved job does", "draftReviewDescription"));
  const description = document.createElement("textarea");
  description.id = "draftReviewDescription";
  description.maxLength = 600;
  description.rows = 3;
  description.value = skill.description || "";
  description.dataset.draftDescription = "true";
  editor.append(description);

  editor.append(sectionHeading("SITES & ACTIONS", "Keep only the access this draft still needs"));
  editor.append(helper("Uncheck recorded access only after removing every step that needs it. BrowserCrew will reject a save that would leave a kept step outside the remaining scope."));
  editor.append(createScopeEditor(skill));

  const inputEntries = Object.entries(skill.inputs || {});
  if (inputEntries.length) {
    editor.append(sectionHeading("RUN-TIME INPUTS", "What BrowserCrew should ask for"));
    editor.append(helper("You can rename these prompts. No demonstrated value or secret is shown or saved in this editor."));
    for (const [name, definition] of inputEntries) editor.append(createInputEditor(name, definition));
  }

  editor.append(sectionHeading("RECORDED STEPS", "Keep only the steps you trust"));
  editor.append(helper("Change the plain-language description or remove a recorded step. Semantic targets cannot be changed here, and site/action scope can only be reduced."));
  editor.append(helper("A fragile target stays blocked from approval until you either remove that step or explicitly confirm that you reviewed its recorded target."));
  skill.steps.forEach((step, index) => editor.append(createStepEditor(step, index === skill.steps.length - 1)));

  const row = document.createElement("div");
  row.className = "button-row";
  const save = document.createElement("button");
  save.className = "button button-primary tactile";
  save.type = "button";
  save.textContent = "Save draft review";
  save.dataset.saveDraftReview = "true";
  const cancel = document.createElement("button");
  cancel.className = "button tactile";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.dataset.cancelDraftReview = "true";
  row.append(save, cancel);
  editor.append(row);
  editor.append(helper("Saving does not approve this version. You can review it again before choosing “Approve this version”."));
  return editor;
}

function createScopeEditor(skill) {
  const wrap = document.createElement("div");
  wrap.className = "selection-summary";
  wrap.dataset.draftScope = "true";

  const sites = document.createElement("div");
  const siteHeading = document.createElement("strong");
  siteHeading.textContent = "Recorded websites";
  sites.append(siteHeading);
  for (const origin of skill.allowedOrigins || []) sites.append(scopeChoice(origin, "scopeOrigin", origin, `Website: ${origin}`));

  const actions = document.createElement("div");
  const actionHeading = document.createElement("strong");
  actionHeading.textContent = "Recorded actions";
  actions.append(actionHeading);
  for (const action of skill.actionClasses || []) actions.append(scopeChoice(action, "scopeAction", action, actionLabel(action)));

  wrap.append(sites, actions);
  return wrap;
}

function scopeChoice(value, datasetKey, rawValue, text) {
  const label = document.createElement("label");
  label.className = "field-label";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.value = rawValue;
  checkbox.dataset[datasetKey] = value;
  label.append(checkbox, document.createTextNode(` ${text}`));
  return label;
}

function actionLabel(action) {
  if (action === "read") return "Read page information";
  if (action === "page_write_prepare") return "Prepare page changes";
  if (action === "download") return "Download files";
  return `Action: ${action}`;
}

function createInputEditor(name, definition) {
  const wrap = document.createElement("div");
  wrap.className = "selection-summary";
  wrap.dataset.draftInput = name;

  const strong = document.createElement("strong");
  strong.textContent = definition.secret ? "Private runtime input" : "Runtime input";
  wrap.append(strong);

  const nameLabel = document.createElement("label");
  nameLabel.className = "field-label";
  nameLabel.textContent = "Input name";
  const nameInput = input("text", name, 64);
  nameInput.autocomplete = "off";
  nameInput.dataset.inputName = "true";
  nameLabel.append(nameInput);

  const promptLabel = document.createElement("label");
  promptLabel.className = "field-label";
  promptLabel.textContent = "Question shown when this skill runs";
  const promptInput = input("text", definition.label || "Runtime input", 120);
  promptInput.autocomplete = "off";
  promptInput.dataset.inputLabel = "true";
  promptLabel.append(promptInput);

  wrap.append(nameLabel, promptLabel);
  if (definition.secret) wrap.append(helper("BrowserCrew will ask for this private value at run time and will not store a default."));
  return wrap;
}

function createStepEditor(step, finalStep) {
  const wrap = document.createElement("div");
  wrap.className = "selection-summary";
  wrap.dataset.draftStep = step.id;

  const heading = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `${step.kind} · ${summarizeTarget(step)}`;
  heading.append(strong);
  wrap.append(heading);

  if (step.review?.stability === "fragile") {
    const warning = helper(step.review.reason || "This recorded target may be fragile. Review it before approval.");
    warning.dataset.fragileStepWarning = "true";
    wrap.append(warning);
    if (step.review.unresolved === true) {
      const confirmLabel = document.createElement("label");
      confirmLabel.className = "field-label";
      const confirm = document.createElement("input");
      confirm.type = "checkbox";
      confirm.dataset.confirmFragileStep = "true";
      confirmLabel.append(confirm, document.createTextNode(" I reviewed this fragile recorded target and want to keep this step"));
      wrap.append(confirmLabel);
    } else {
      const reviewed = helper("Fragile target reviewed for this exact draft version.");
      reviewed.dataset.fragileStepReviewed = "true";
      wrap.append(reviewed);
    }
  }

  const purposeLabel = document.createElement("label");
  purposeLabel.className = "field-label";
  purposeLabel.textContent = "What this step does";
  const purpose = input("text", step.purpose || "", 240);
  purpose.dataset.stepPurpose = "true";
  purposeLabel.append(purpose);
  wrap.append(purposeLabel);

  const keepLabel = document.createElement("label");
  const keep = document.createElement("input");
  keep.type = "checkbox";
  keep.checked = true;
  keep.dataset.keepStep = "true";
  if (finalStep) keep.disabled = true;
  keepLabel.append(keep, document.createTextNode(finalStep ? " Keep final result check · required" : " Keep this step"));
  wrap.append(keepLabel);
  if (finalStep) wrap.append(helper("The final result check cannot be removed. BrowserCrew needs it to verify success."));
  return wrap;
}

async function saveDraftReview(button) {
  const editor = button.closest("[data-draft-review-editor]");
  if (!editor) return;
  busy(button, true, "Checking…");
  try {
    const response = await portRequest(SKILLS_PORT, {
      type: "get",
      skillId: editor.dataset.skillId,
      version: editor.dataset.skillVersion
    });
    if (!response.ok || !response.skill) throw new Error(response.error?.message || "BrowserCrew could not reload this draft.");
    if (response.skill.status !== "draft") throw new Error("This version is no longer a draft, so it cannot be changed.");

    const inputEdits = {};
    for (const row of editor.querySelectorAll("[data-draft-input]")) {
      inputEdits[row.dataset.draftInput] = {
        name: row.querySelector("[data-input-name]")?.value || "",
        label: row.querySelector("[data-input-label]")?.value || ""
      };
    }
    const stepEdits = {};
    for (const row of editor.querySelectorAll("[data-draft-step]")) {
      stepEdits[row.dataset.draftStep] = {
        purpose: row.querySelector("[data-step-purpose]")?.value || "",
        remove: row.querySelector("[data-keep-step]")?.checked === false,
        confirmTarget: row.querySelector("[data-confirm-fragile-step]")?.checked === true
      };
    }
    const scopeEdits = {
      allowedOrigins: [...editor.querySelectorAll("[data-scope-origin]:checked")].map((item) => item.value),
      actionClasses: [...editor.querySelectorAll("[data-scope-action]:checked")].map((item) => item.value)
    };

    const reviewed = reviewSkillDraft(response.skill, {
      title: editor.querySelector("[data-draft-title]")?.value || "",
      description: editor.querySelector("[data-draft-description]")?.value || "",
      inputEdits,
      stepEdits,
      scopeEdits
    });
    const saved = await portRequest(SKILLS_PORT, { type: "saveDraft", skill: reviewed });
    if (!saved.ok) throw new Error(saved.error?.message || "BrowserCrew could not save this draft review.");

    updateCard(findSkillCard(saved.skill), saved.skill);
    closeDraftReview(editor);
    announce("Draft review saved. It is still a draft and has not gained any new permission.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not save this draft review.");
  } finally {
    busy(button, false, "Save draft review");
  }
}

function findSkillCard(skill) {
  if (!skill) return null;
  for (const card of document.querySelectorAll("#versionedSkillList .skill-card")) {
    const approve = card.querySelector("[data-approve-skill]");
    if (approve?.dataset.approveSkill === skill.id && approve?.dataset.skillVersion === skill.version) return card;
  }
  return null;
}

function updateCard(card, skill) {
  if (!card || !skill) return;
  const info = card.firstElementChild;
  const strong = info?.querySelector("strong");
  const paragraph = info?.querySelector("p");
  const small = info?.querySelector("small");
  if (strong) strong.textContent = skill.title;
  if (paragraph) paragraph.textContent = skill.description;
  if (small) {
    const finalCheck = skill.steps?.at(-1)?.expect?.visibleText;
    const unresolved = skill.steps?.filter((step) => step?.review?.unresolved === true).length || 0;
    small.textContent = `Needs review · v${skill.version} · ${skill.steps?.length || 0} steps${unresolved ? ` · ${unresolved} target${unresolved === 1 ? "" : "s"} still needs review` : ""}${finalCheck ? ` · checks “${finalCheck}”` : ""}`;
  }
}

function closeDraftReview(editor) {
  if (!editor) return;
  editor.remove();
  if (activeEditor === editor) activeEditor = null;
}

function sectionHeading(labelText, headingText) {
  const wrap = document.createElement("div");
  wrap.className = "card-heading";
  const inner = document.createElement("div");
  const label = document.createElement("p");
  label.className = "step-label";
  label.textContent = labelText;
  const heading = document.createElement("h4");
  heading.textContent = headingText;
  inner.append(label, heading);
  wrap.append(inner);
  return wrap;
}

function fieldLabel(text, forId) {
  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = forId;
  label.textContent = text;
  return label;
}

function input(type, value, maxLength) {
  const element = document.createElement("input");
  element.type = type;
  element.value = String(value ?? "");
  element.maxLength = maxLength;
  return element;
}

function helper(text) {
  const p = document.createElement("p");
  p.className = "helper";
  p.textContent = text;
  return p;
}

function summarizeTarget(step) {
  if (step.kind === "verify") return "final visible result";
  if (step.kind === "navigate") return "approved page";
  const target = step.target || {};
  return target.label || target.ariaLabel || target.testId || target.role || "recorded page target";
}

function portRequest(portName, payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: portName });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      try { port.disconnect(); } catch {}
      reject(new Error("BrowserCrew did not answer in time."));
    }, 10_000);
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
