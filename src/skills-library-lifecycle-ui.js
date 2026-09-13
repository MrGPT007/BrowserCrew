import { duplicateSkillAsDraft } from "./skills-library-lifecycle.js";

const SKILLS_PORT = "browsercrew-skills";
let skillVersions = [];
let activeFilter = "all";
let refreshQueued = false;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list || card.querySelector("#skillLibraryFilters")) return;

  const heading = card.querySelector("h2");
  if (heading) heading.textContent = "My Skills";
  const filters = createFilters();
  list.before(filters);
  filters.addEventListener("click", onFilterAction);
  list.addEventListener("click", onLifecycleAction);

  const observer = new MutationObserver(() => {
    if (!list.querySelector("[data-skill-record]") && list.children.length) queueRefresh();
  });
  observer.observe(list, { childList: true });
  refreshSkills().catch((error) => announce(error.message || "BrowserCrew could not load My Skills."));
});

function createFilters() {
  const wrap = document.createElement("div");
  wrap.id = "skillLibraryFilters";
  wrap.className = "button-row";
  wrap.setAttribute("aria-label", "Filter saved skill versions");
  for (const [value, label] of [["all", "All versions"], ["draft", "Drafts"], ["approved", "Approved"], ["archived", "Archived"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-small tactile";
    button.dataset.skillFilter = value;
    button.textContent = label;
    button.setAttribute("aria-pressed", value === activeFilter ? "true" : "false");
    wrap.append(button);
  }
  return wrap;
}

async function onFilterAction(event) {
  const button = event.target.closest("[data-skill-filter]");
  if (!button) return;
  activeFilter = button.dataset.skillFilter || "all";
  await refreshSkills();
}

async function onLifecycleAction(event) {
  const duplicate = event.target.closest("[data-duplicate-skill]");
  const archive = event.target.closest("[data-archive-skill]");
  const remove = event.target.closest("[data-delete-draft]");
  if (duplicate) return duplicateSkill(duplicate);
  if (archive) return archiveSkill(archive);
  if (remove) return deleteDraft(remove);
}

async function duplicateSkill(button) {
  busy(button, true, "Copying…");
  try {
    const source = await getExactSkill(button.dataset.duplicateSkill, button.dataset.skillVersion);
    const copy = duplicateSkillAsDraft(source, {
      id: `skill-${crypto.randomUUID()}`,
      title: copyTitle(source.title),
      createdAt: new Date().toISOString()
    });
    const saved = await portRequest(SKILLS_PORT, { type: "saveDraft", skill: copy });
    if (!saved.ok) throw new Error(saved.error?.message || "BrowserCrew could not duplicate that skill version.");
    activeFilter = "draft";
    await refreshSkills();
    announce("Copy created as a new draft. It is not approved and has no new permission.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not duplicate that skill version.");
  } finally {
    busy(button, false, "Duplicate as draft");
  }
}

async function archiveSkill(button) {
  const skill = await getExactSkill(button.dataset.archiveSkill, button.dataset.skillVersion).catch((error) => { announce(error.message); return null; });
  if (!skill) return;
  if (!confirm(`Archive “${skill.title}” v${skill.version}? Archived versions stay in history but cannot run or be scheduled.`)) return;
  busy(button, true, "Archiving…");
  try {
    const response = await portRequest(SKILLS_PORT, { type: "archive", skillId: skill.id, version: skill.version });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not archive that approved version.");
    await refreshSkills();
    announce("Approved version archived. Its history is still available.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not archive that approved version.");
  } finally {
    busy(button, false, "Archive");
  }
}

async function deleteDraft(button) {
  const skill = await getExactSkill(button.dataset.deleteDraft, button.dataset.skillVersion).catch((error) => { announce(error.message); return null; });
  if (!skill) return;
  if (!confirm(`Delete the draft “${skill.title}” v${skill.version}? Only this unapproved draft will be removed.`)) return;
  busy(button, true, "Deleting…");
  try {
    const response = await portRequest(SKILLS_PORT, { type: "deleteDraft", skillId: skill.id, version: skill.version });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not delete that draft.");
    await refreshSkills();
    announce("Draft deleted. Approved and archived history was not changed.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not delete that draft.");
  } finally {
    busy(button, false, "Delete draft");
  }
}

async function getExactSkill(skillId, version) {
  const response = await portRequest(SKILLS_PORT, { type: "get", skillId, version });
  if (!response.ok || !response.skill) throw new Error(response.error?.message || "That exact skill version could not be found.");
  return response.skill;
}

async function refreshSkills() {
  const response = await portRequest(SKILLS_PORT, { type: "list" });
  if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not load saved skills.");
  skillVersions = response.skills || [];
  renderSkills();
}

function renderSkills() {
  const list = document.querySelector("#versionedSkillList");
  const count = document.querySelector("#versionedSkillCount");
  const filters = document.querySelector("#skillLibraryFilters");
  if (!list || !count || !filters) return;

  for (const button of filters.querySelectorAll("[data-skill-filter]")) {
    const filter = button.dataset.skillFilter;
    const number = filter === "all" ? skillVersions.length : skillVersions.filter((skill) => skill.status === filter).length;
    const label = filter === "all" ? "All versions" : filter === "draft" ? "Drafts" : filter === "approved" ? "Approved" : "Archived";
    button.textContent = `${label} (${number})`;
    button.setAttribute("aria-pressed", filter === activeFilter ? "true" : "false");
  }

  const visible = activeFilter === "all" ? skillVersions : skillVersions.filter((skill) => skill.status === activeFilter);
  count.textContent = activeFilter === "all" ? String(skillVersions.length) : `${visible.length}/${skillVersions.length}`;
  if (!visible.length) {
    list.innerHTML = `<div class="empty" data-skill-record="empty">${emptyMessage(activeFilter)}</div>`;
    return;
  }
  list.replaceChildren(...visible.map(createSkillCard));
}

function createSkillCard(skill) {
  const card = document.createElement("article");
  card.className = "skill-card";
  card.dataset.skillRecord = `${skill.id}@@${skill.version}`;
  card.dataset.skillStatus = skill.status;

  const info = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = skill.title;
  const description = document.createElement("p");
  description.textContent = skill.description;
  const small = document.createElement("small");
  const finalCheck = skill.steps?.at(-1)?.expect?.visibleText;
  small.textContent = `${statusLabel(skill.status)} · v${skill.version} · ${skill.steps?.length || 0} steps${finalCheck ? ` · checks “${finalCheck}”` : ""}`;
  info.append(title, description, small);

  const actions = document.createElement("div");
  actions.className = "skill-actions";
  if (skill.status === "draft") {
    actions.append(actionButton("Approve this version", "button button-small button-primary tactile", "approveSkill", skill));
    actions.append(actionButton("Delete draft", "button button-small tactile", "deleteDraft", skill));
  } else if (skill.status === "approved") {
    actions.append(actionButton("Archive", "button button-small tactile", "archiveSkill", skill));
  }
  actions.append(actionButton("Duplicate as draft", "button button-small tactile", "duplicateSkill", skill));
  card.append(info, actions);
  return card;
}

function actionButton(label, className, action, skill) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  if (action === "approveSkill") button.dataset.approveSkill = skill.id;
  else if (action === "deleteDraft") button.dataset.deleteDraft = skill.id;
  else if (action === "archiveSkill") button.dataset.archiveSkill = skill.id;
  else button.dataset.duplicateSkill = skill.id;
  button.dataset.skillVersion = skill.version;
  return button;
}

function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(async () => {
    refreshQueued = false;
    const list = document.querySelector("#versionedSkillList");
    if (list?.querySelector("[data-skill-record]")) return;
    try { await refreshSkills(); } catch {}
  });
}

function copyTitle(title) {
  const base = String(title || "Saved skill").replace(/\s+/g, " ").trim();
  return `${base.slice(0, 115)} copy`.slice(0, 120);
}

function statusLabel(status) {
  return status === "approved" ? "Approved" : status === "archived" ? "Archived" : "Needs review";
}

function emptyMessage(filter) {
  if (filter === "draft") return "No drafts need review.";
  if (filter === "approved") return "No approved skill versions yet.";
  if (filter === "archived") return "No archived skill versions.";
  return "No saved skill versions yet. Choose “Watch me do it” to create a draft.";
}

function portRequest(portName, payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: portName });
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
