import { createNextVersionDraft } from "./skills-versioning.js";
import { testApprovedSkillOnPage } from "./skills-test.js";

const SKILLS_PORT = "browsercrew-skills";
let selectedSkill = null;
let selectedTab = null;
let cachedSkills = [];

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list || card.querySelector("#skillVersionsPanel")) return;

  const intro = document.createElement("p");
  intro.className = "helper";
  intro.id = "skillLibraryPlainHelp";
  intro.textContent = "A Skill is a saved way to do a browser job. Test it without making changes, or review the exact version before one run.";
  const filters = card.querySelector("#skillLibraryFilters");
  (filters || list).before(intro);

  const versionsPanel = createVersionsPanel();
  const runPanel = createRunPanel();
  list.before(versionsPanel, runPanel);

  card.addEventListener("click", onCardAction);
  const observer = new MutationObserver(enhanceSkillCards);
  observer.observe(list, { childList: true, subtree: true });
  enhanceSkillCards();
});

function enhanceSkillCards() {
  document.querySelectorAll("#versionedSkillList [data-skill-record]").forEach((card) => {
    const ref = parseRef(card.dataset.skillRecord);
    if (!ref || ref.id === "empty") return;
    const actions = card.querySelector(".skill-actions");
    if (!actions) return;
    if (!actions.querySelector("[data-view-versions]")) actions.prepend(button("Versions", "viewVersions", ref));
    if (card.dataset.skillStatus === "approved" && !actions.querySelector("[data-open-skill-run]")) actions.prepend(button("Test / Run", "openSkillRun", ref, true));
  });
}

function button(label, action, ref, primary = false) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `button button-small ${primary ? "button-primary " : ""}tactile`;
  element.textContent = label;
  if (action === "viewVersions") element.dataset.viewVersions = ref.id;
  if (action === "openSkillRun") element.dataset.openSkillRun = ref.id;
  element.dataset.skillVersion = ref.version;
  return element;
}

async function onCardAction(event) {
  const versions = event.target.closest("[data-view-versions]");
  const runner = event.target.closest("[data-open-skill-run]");
  const newVersion = event.target.closest("[data-new-version-draft]");
  if (versions) return openVersions(versions.dataset.viewVersions, versions.dataset.skillVersion);
  if (runner) return openRunner(runner.dataset.openSkillRun, runner.dataset.skillVersion);
  if (newVersion) return createVersionDraft(newVersion);
  if (event.target.closest("#skillVersionsClose")) return closePanel("#skillVersionsPanel");
  if (event.target.closest("#skillRunClose")) return closePanel("#skillRunPanel");
  if (event.target.closest("#skillTestButton")) return testCurrentPage();
  if (event.target.closest("#skillRunOnceButton")) return runOnce();
}

function createVersionsPanel() {
  const panel = document.createElement("section");
  panel.id = "skillVersionsPanel";
  panel.className = "evidence-box";
  panel.hidden = true;
  panel.innerHTML = `<div class="card-heading"><div><p class="step-label">VERSIONS</p><h3 id="skillVersionsTitle">Skill versions</h3></div><button class="button button-small tactile" id="skillVersionsClose" type="button">Close</button></div><p class="helper">Approved and archived versions stay unchanged. A new version starts as a draft and needs review again.</p><div id="skillVersionsList"></div>`;
  return panel;
}

function createRunPanel() {
  const panel = document.createElement("section");
  panel.id = "skillRunPanel";
  panel.className = "evidence-box";
  panel.hidden = true;
  panel.innerHTML = `<div class="card-heading"><div><p class="step-label">TEST OR RUN</p><h3 id="skillRunTitle">Review this Skill</h3></div><button class="button button-small tactile" id="skillRunClose" type="button">Close</button></div><p class="helper">Test checks this page without clicking, typing, navigating, downloading, or saving anything. Run uses only the exact approved version shown here.</p><div id="skillRunScope" class="selection-summary"></div><div id="skillRunInputs"></div><div id="skillTestResult" class="selection-summary" aria-live="polite">Choose Test to check the current page without changes.</div><div class="button-row"><button class="button tactile" id="skillTestButton" type="button">Test this page (no changes)</button><button class="button button-primary tactile" id="skillRunOnceButton" type="button">Review and run once</button></div>`;
  return panel;
}

async function openVersions(skillId, version) {
  try {
    cachedSkills = await listSkills();
    const exact = cachedSkills.find((item) => item.id === skillId && item.version === version);
    if (!exact) throw new Error("That exact skill version could not be found.");
    const lineage = cachedSkills.filter((item) => item.id === skillId).sort(compareVersionDesc);
    const panel = document.querySelector("#skillVersionsPanel");
    const list = panel?.querySelector("#skillVersionsList");
    if (!panel || !list) return;
    document.querySelector("#skillVersionsTitle").textContent = exact.title;
    list.replaceChildren(...lineage.map(versionRow));
    if (exact.status === "approved") {
      const action = document.createElement("div");
      action.className = "button-row";
      const create = document.createElement("button");
      create.type = "button";
      create.className = "button button-primary tactile";
      create.textContent = "Create next draft version";
      create.dataset.newVersionDraft = exact.id;
      create.dataset.skillVersion = exact.version;
      action.append(create);
      list.append(action);
    }
    panel.hidden = false;
    panel.scrollIntoView({ block: "nearest" });
  } catch (error) { announce(error.message || "BrowserCrew could not load Skill versions."); }
}

function versionRow(skill) {
  const row = document.createElement("article");
  row.className = "skill-card";
  row.dataset.versionRow = `${skill.id}@@${skill.version}`;
  const finalCheck = skill.steps?.at(-1)?.expect?.visibleText || skill.steps?.at(-1)?.expect?.urlIncludes || "saved completion check";
  row.innerHTML = `<div><strong>v${escapeHtml(skill.version)} · ${escapeHtml(statusLabel(skill.status))}</strong><p>${escapeHtml(skill.description)}</p><small>${skill.steps?.length || 0} steps · final check: ${escapeHtml(finalCheck)}</small></div>`;
  return row;
}

async function createVersionDraft(button) {
  busy(button, true, "Creating…");
  try {
    cachedSkills = await listSkills();
    const source = cachedSkills.find((item) => item.id === button.dataset.newVersionDraft && item.version === button.dataset.skillVersion);
    if (!source || source.status !== "approved") throw new Error("Choose an approved version before creating the next draft.");
    const draft = createNextVersionDraft(source, cachedSkills, { createdAt: new Date().toISOString() });
    const saved = await portRequest({ type: "saveDraft", skill: draft });
    if (!saved.ok) throw new Error(saved.error?.message || "BrowserCrew could not create the next draft version.");
    announce(`v${draft.version} created as a draft. It has no approval until you review it.`);
    document.querySelector('[data-skill-filter="draft"]')?.click();
    await openVersions(draft.id, draft.version);
  } catch (error) { announce(error.message || "BrowserCrew could not create the next draft version."); }
  finally { busy(button, false, "Create next draft version"); }
}

async function openRunner(skillId, version) {
  try {
    const response = await portRequest({ type: "get", skillId, version });
    if (!response.ok || response.skill?.status !== "approved") throw new Error("Only an approved exact Skill version can be tested or run.");
    selectedSkill = response.skill;
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    selectedTab = active?.ok ? active.tab : null;
    const panel = document.querySelector("#skillRunPanel");
    if (!panel) return;
    document.querySelector("#skillRunTitle").textContent = `${selectedSkill.title} · v${selectedSkill.version}`;
    document.querySelector("#skillRunScope").innerHTML = scopeSummary(selectedSkill, selectedTab);
    renderInputs(selectedSkill);
    const result = document.querySelector("#skillTestResult");
    if (result) result.textContent = "Choose Test to check the current page without changes.";
    panel.hidden = false;
    panel.scrollIntoView({ block: "nearest" });
  } catch (error) { announce(error.message || "BrowserCrew could not open this Skill."); }
}

function renderInputs(skill) {
  const root = document.querySelector("#skillRunInputs");
  if (!root) return;
  root.replaceChildren();
  for (const [name, definition] of Object.entries(skill.inputs || {})) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.className = "field-label";
    label.htmlFor = `skillInput-${name}`;
    label.textContent = `${definition.label || name}${definition.required ? " · required" : ""}${definition.secret ? " · secret" : ""}`;
    const input = document.createElement("input");
    input.id = `skillInput-${name}`;
    input.dataset.skillInput = name;
    input.dataset.inputType = definition.type;
    input.dataset.required = definition.required ? "true" : "false";
    if (definition.type === "boolean") input.type = "checkbox";
    else if (definition.type === "number") input.type = "number";
    else input.type = definition.secret ? "password" : "text";
    if (!definition.secret && Object.prototype.hasOwnProperty.call(definition, "default")) {
      if (definition.type === "boolean") input.checked = Boolean(definition.default);
      else input.value = String(definition.default);
    }
    if (definition.required) input.required = true;
    input.autocomplete = definition.secret ? "off" : "on";
    wrap.append(label, input);
    root.append(wrap);
  }
}

async function testCurrentPage() {
  if (!selectedSkill) return;
  const button = document.querySelector("#skillTestButton");
  let inputValues;
  try { inputValues = readInputs(); } catch (error) { return announce(error.message); }
  const origin = selectedTab?.url && /^https?:/.test(selectedTab.url) ? new URL(selectedTab.url).origin : null;
  if (!origin || !selectedSkill.allowedOrigins.includes(origin)) return announce("Choose a current page that belongs to this Skill's reviewed websites.");
  busy(button, true, "Testing…");
  try {
    if (!(await requestOrigins([origin]))) throw new Error("Test needs Chrome access to this page. Nothing was changed.");
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    if (!active?.ok || active.tab?.id !== selectedTab.id || new URL(active.tab.url).origin !== origin) throw new Error("The selected page changed. Open Test / Run again for the page you want to use.");
    const test = await testApprovedSkillOnPage({ skill: selectedSkill, inputValues, tabId: selectedTab.id });
    renderTestResult(test);
    announce(test.ready ? "Test passed. The page was not changed." : "Test found something to review. The page was not changed.");
  } catch (error) {
    const result = document.querySelector("#skillTestResult");
    if (result) result.textContent = error.message || "BrowserCrew could not test this page.";
    announce(error.message || "BrowserCrew could not test this page.");
  } finally { busy(button, false, "Test this page (no changes)"); }
}

function renderTestResult(test) {
  const root = document.querySelector("#skillTestResult");
  if (!root) return;
  const found = test.checks.filter((item) => item.status === "found" || item.status === "matches_now").length;
  const blocked = test.checks.filter((item) => item.status === "blocked").length;
  root.innerHTML = `<strong>${test.ready ? "Ready to run on this page" : "Review before running"}</strong><p>${found} current-page checks matched${blocked ? ` · ${blocked} blocked` : ""}. Test made no page changes.</p><ul>${test.checks.map((item) => `<li>${escapeHtml(item.kind)}: ${escapeHtml(item.message)}</li>`).join("")}</ul>`;
}

async function runOnce() {
  if (!selectedSkill) return;
  const button = document.querySelector("#skillRunOnceButton");
  let inputValues;
  try { inputValues = readInputs(); } catch (error) { return announce(error.message); }
  const approvalText = `Run “${selectedSkill.title}” v${selectedSkill.version} once?\n\nWebsites: ${selectedSkill.allowedOrigins.join(", ")}\nActions: ${selectedSkill.actionClasses.join(", ")}\nData destinations: ${(selectedSkill.dataDestinations || []).join(", ") || "none"}\nLimits: ${selectedSkill.budgets.maxSteps} steps / ${selectedSkill.budgets.maxMinutes} minutes\n\nThis approval is for this run only. Saved Skill requirements do not grant permission by themselves.`;
  if (!confirm(approvalText)) return;
  busy(button, true, "Running…");
  try {
    if (!(await requestOrigins(selectedSkill.allowedOrigins))) throw new Error("Run stopped because Chrome site access was not approved.");
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    if (!active?.ok || !Number.isInteger(active.tab?.id)) throw new Error("Choose the page where this Skill should start.");
    const startOrigin = /^https?:/.test(active.tab.url || "") ? new URL(active.tab.url).origin : null;
    if (!startOrigin || !selectedSkill.allowedOrigins.includes(startOrigin)) throw new Error("The current page is outside this Skill's reviewed website scope.");
    const oneRunGrant = {
      origins: [...selectedSkill.allowedOrigins],
      actionClasses: [...selectedSkill.actionClasses],
      dataDestinations: [...(selectedSkill.dataDestinations || [])],
      revoked: false,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      scope: "one_run",
      skillRef: { id: selectedSkill.id, version: selectedSkill.version }
    };
    const response = await runPortRequest({ type: "run", skillId: selectedSkill.id, version: selectedSkill.version, tabId: active.tab.id, inputValues, grant: oneRunGrant });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew stopped this Skill safely.");
    const result = document.querySelector("#skillTestResult");
    if (result) result.innerHTML = `<strong>Run completed and checked</strong><p>Exact version v${escapeHtml(selectedSkill.version)} finished ${response.run?.receipt?.steps?.length || selectedSkill.steps.length} steps and passed its saved completion check.</p>`;
    announce("Skill run completed and its final result was checked.");
  } catch (error) {
    const result = document.querySelector("#skillTestResult");
    if (result) result.textContent = error.message || "BrowserCrew stopped this Skill safely.";
    announce(error.message || "BrowserCrew stopped this Skill safely.");
  } finally { busy(button, false, "Review and run once"); }
}

function readInputs() {
  const values = {};
  for (const input of document.querySelectorAll("#skillRunInputs [data-skill-input]")) {
    const name = input.dataset.skillInput;
    const type = input.dataset.inputType;
    let value;
    if (type === "boolean") value = input.checked;
    else if (type === "number") value = input.value === "" ? undefined : Number(input.value);
    else value = input.value;
    if (input.dataset.required === "true" && (value === undefined || value === "")) throw new Error(`Enter ${input.previousElementSibling?.textContent?.replace(/ ·.*/, "") || name} before continuing.`);
    if (value !== undefined && value !== "") values[name] = value;
  }
  return values;
}

async function requestOrigins(origins) {
  const patterns = [...new Set(origins)].map((origin) => `${origin}/*`);
  if (await chrome.permissions.contains({ origins: patterns })) return true;
  return chrome.permissions.request({ origins: patterns });
}

function scopeSummary(skill, tab) {
  const page = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).origin : "No website selected";
  return `<strong>Exact version v${escapeHtml(skill.version)}</strong><p>Current page: ${escapeHtml(page)}</p><p>Websites: ${escapeHtml(skill.allowedOrigins.join(", "))}</p><p>Actions: ${escapeHtml(skill.actionClasses.join(", "))}</p><p>Data destinations: ${escapeHtml((skill.dataDestinations || []).join(", ") || "none")}</p><p>Limits: ${skill.budgets.maxSteps} steps · ${skill.budgets.maxMinutes} minutes</p>`;
}

async function listSkills() {
  const response = await portRequest({ type: "list" });
  if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not load Skill versions.");
  return response.skills || [];
}
function portRequest(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: SKILLS_PORT });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("BrowserCrew did not answer in time.")); }, 10_000);
    port.onMessage.addListener((message) => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
      resolve(message);
    });
    port.onDisconnect.addListener(() => { if (chrome.runtime.lastError) clearTimeout(timer); });
    port.postMessage({ ...payload, requestId });
  });
}
function runPortRequest(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: SKILLS_PORT });
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; try { port.disconnect(); } catch {} fn(value); };
    port.onMessage.addListener((message) => { if (message?.requestId === requestId) finish(resolve, message); });
    port.onDisconnect.addListener(() => { if (!settled) finish(reject, new Error("BrowserCrew's Skill runner stopped before replying. Review the page before trying again.")); });
    port.postMessage({ ...payload, requestId });
  });
}
function parseRef(value) {
  const [id, version] = String(value || "").split("@@");
  return id && version ? { id, version } : null;
}
function compareVersionDesc(a, b) { return compareSemver(b.version, a.version); }
function compareSemver(a, b) {
  const av = String(a).split(".").map(Number), bv = String(b).split(".").map(Number);
  return (av[0] || 0) - (bv[0] || 0) || (av[1] || 0) - (bv[1] || 0) || (av[2] || 0) - (bv[2] || 0);
}
function statusLabel(status) { return status === "approved" ? "Approved" : status === "archived" ? "Archived" : "Draft · needs review"; }
function closePanel(selector) { const panel = document.querySelector(selector); if (panel) panel.hidden = true; }
function busy(button, state, label) { if (!button) return; button.disabled = state; button.textContent = label; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function announce(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
