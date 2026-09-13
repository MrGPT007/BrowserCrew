import { exportSkillBundle, importSkillAsDraft, parseSkillBundle } from "./skills-portable.js";

const SKILLS_PORT = "browsercrew-skills";
let pendingImport = null;
let importPanel = null;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list || card.querySelector("#skillPortableControls")) return;

  const controls = createPortableControls();
  const filters = card.querySelector("#skillLibraryFilters");
  if (filters) filters.after(controls);
  else list.before(controls);

  card.addEventListener("click", onPortableAction);
  controls.querySelector("#skillImportFile")?.addEventListener("change", onImportFileSelected);
  enhanceExportButtons(list);
  const observer = new MutationObserver(() => enhanceExportButtons(list));
  observer.observe(list, { childList: true, subtree: true });
});

function createPortableControls() {
  const wrap = document.createElement("section");
  wrap.id = "skillPortableControls";
  wrap.innerHTML = `
    <div class="button-row">
      <button class="button button-small tactile" id="skillImportButton" type="button">Import Skill JSON</button>
      <input id="skillImportFile" type="file" accept=".json,application/json" hidden />
    </div>
    <p class="helper">Imported Skill files are untrusted. BrowserCrew shows their requested sites and actions first, then saves them only as a new draft for review.</p>`;
  return wrap;
}

function enhanceExportButtons(list) {
  for (const card of list.querySelectorAll(".skill-card[data-skill-record]")) {
    if (card.dataset.skillRecord === "empty") continue;
    const actions = card.querySelector(".skill-actions");
    if (!actions || actions.querySelector("[data-export-skill]")) continue;
    const [skillId, version] = String(card.dataset.skillRecord || "").split("@@");
    if (!skillId || !version) continue;
    const button = document.createElement("button");
    button.className = "button button-small tactile";
    button.type = "button";
    button.textContent = "Export JSON";
    button.dataset.exportSkill = skillId;
    button.dataset.skillVersion = version;
    actions.append(button);
  }
}

async function onPortableAction(event) {
  const exportButton = event.target.closest("[data-export-skill]");
  const importButton = event.target.closest("#skillImportButton");
  const confirmImport = event.target.closest("[data-confirm-skill-import]");
  const cancelImport = event.target.closest("[data-cancel-skill-import]");
  if (exportButton) return exportSkill(exportButton);
  if (importButton) return document.querySelector("#skillImportFile")?.click();
  if (confirmImport) return confirmPendingImport(confirmImport);
  if (cancelImport) return clearImportPreview();
}

async function exportSkill(button) {
  busy(button, true, "Exporting…");
  try {
    const response = await portRequest(SKILLS_PORT, { type: "get", skillId: button.dataset.exportSkill, version: button.dataset.skillVersion });
    if (!response.ok || !response.skill) throw new Error(response.error?.message || "BrowserCrew could not load that exact Skill version.");
    const text = exportSkillBundle(response.skill);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = portableFilename(response.skill);
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce("Skill JSON exported. Exporting does not grant permission or change this version.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not export that Skill version.");
  } finally {
    busy(button, false, "Export JSON");
  }
}

async function onImportFileSelected(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    pendingImport = parseSkillBundle(await file.text());
    renderImportPreview(pendingImport.preview);
  } catch (error) {
    pendingImport = null;
    clearImportPreview();
    announce(error.message || "BrowserCrew rejected that Skill file.");
  }
}

function renderImportPreview(preview) {
  const card = document.querySelector("#versionedSkillsCard");
  const controls = document.querySelector("#skillPortableControls");
  if (!card || !controls) return;
  clearImportPreview();

  importPanel = document.createElement("section");
  importPanel.className = "evidence-box";
  importPanel.id = "skillImportPreview";
  importPanel.dataset.skillImportPreview = "true";

  const heading = document.createElement("div");
  heading.className = "card-heading";
  const copy = document.createElement("div");
  const label = document.createElement("p");
  label.className = "step-label";
  label.textContent = "UNTRUSTED IMPORT";
  const title = document.createElement("h3");
  title.textContent = preview.title;
  copy.append(label, title);
  const badge = document.createElement("span");
  badge.className = "badge badge-warning";
  badge.textContent = "Review first";
  heading.append(copy, badge);
  importPanel.append(heading);

  importPanel.append(helper(`Source: ${preview.sourceRef.id} · v${preview.sourceRef.version} · ${preview.sourceRef.status}. Importing never preserves approval or archive authority.`));
  importPanel.append(scopeSection("Requested websites", preview.allowedOrigins, "No websites requested."));
  importPanel.append(scopeSection("Requested actions", preview.actionClasses, "No actions requested."));
  importPanel.append(scopeSection("Data destinations", preview.dataDestinations, "No external data destinations."));
  importPanel.append(helper(`${preview.stepCount} semantic steps · ${preview.inputCount} runtime inputs · budget up to ${preview.budgets.maxSteps} steps / ${preview.budgets.maxMinutes} minutes.`));
  importPanel.append(helper("Nothing runs and no permission is granted by this file. Importing creates a brand-new draft that you must review and approve separately."));

  const row = document.createElement("div");
  row.className = "button-row";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "button button-primary tactile";
  confirm.textContent = "Import as draft";
  confirm.dataset.confirmSkillImport = "true";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button tactile";
  cancel.textContent = "Cancel import";
  cancel.dataset.cancelSkillImport = "true";
  row.append(confirm, cancel);
  importPanel.append(row);
  controls.after(importPanel);
}

async function confirmPendingImport(button) {
  if (!pendingImport) return announce("Choose a Skill JSON file first.");
  busy(button, true, "Importing…");
  try {
    const draft = importSkillAsDraft(pendingImport, {
      id: `skill-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString()
    });
    const response = await portRequest(SKILLS_PORT, { type: "saveDraft", skill: draft });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not save the imported draft.");
    pendingImport = null;
    clearImportPreview();
    const drafts = document.querySelector('#skillLibraryFilters [data-skill-filter="draft"]');
    drafts?.click();
    announce("Imported as a new draft. Review it before approval; no permission was granted.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not import that Skill file.");
  } finally {
    busy(button, false, "Import as draft");
  }
}

function clearImportPreview() {
  importPanel?.remove();
  importPanel = null;
}

function scopeSection(title, values, emptyText) {
  const wrap = document.createElement("div");
  wrap.className = "selection-summary";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const p = document.createElement("p");
  p.textContent = Array.isArray(values) && values.length ? values.join(" · ") : emptyText;
  wrap.append(strong, p);
  return wrap;
}

function portableFilename(skill) {
  const slug = String(skill.title || skill.id || "skill").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "skill";
  return `${slug}-v${skill.version}.browsercrew-skill.json`;
}

function helper(text) {
  const p = document.createElement("p");
  p.className = "helper";
  p.textContent = text;
  return p;
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
