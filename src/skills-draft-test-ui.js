import { testDraftSkillOnPage } from "./skills-test.js";

const SKILLS_PORT = "browsercrew-skills";
let selectedDraft = null;
let selectedTab = null;
let draftPanel = null;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#versionedSkillsCard");
  const list = document.querySelector("#versionedSkillList");
  if (!card || !list) return;
  enhanceDraftTestButtons(list);
  const observer = new MutationObserver(() => enhanceDraftTestButtons(list));
  observer.observe(list, { childList: true, subtree: true });
  card.addEventListener("click", onDraftTestAction);
});

function enhanceDraftTestButtons(list) {
  for (const card of list.querySelectorAll('[data-skill-status="draft"][data-skill-record]')) {
    if (card.dataset.skillRecord === "empty") continue;
    const actions = card.querySelector(".skill-actions");
    if (!actions || actions.querySelector("[data-test-draft-skill]")) continue;
    const [skillId, version] = String(card.dataset.skillRecord || "").split("@@");
    if (!skillId || !version) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-small tactile";
    button.textContent = "Test draft — no changes";
    button.dataset.testDraftSkill = skillId;
    button.dataset.skillVersion = version;
    actions.prepend(button);
  }
}

async function onDraftTestAction(event) {
  const open = event.target.closest("[data-test-draft-skill]");
  if (open) return openDraftTest(open);
  if (event.target.closest("[data-close-draft-test]")) return closeDraftTest();
  if (event.target.closest("[data-run-draft-test]")) return runDraftTest(event.target.closest("[data-run-draft-test]"));
}

async function openDraftTest(button) {
  busy(button, true, "Opening…");
  try {
    const response = await portRequest({ type: "get", skillId: button.dataset.testDraftSkill, version: button.dataset.skillVersion });
    if (!response.ok || !response.skill) throw new Error(response.error?.message || "BrowserCrew could not load that exact draft.");
    if (response.skill.status !== "draft") throw new Error("Draft Test is only for an exact unapproved draft version.");
    selectedDraft = response.skill;
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    selectedTab = active?.ok ? active.tab : null;
    renderDraftTestPanel();
  } catch (error) {
    announce(error.message || "BrowserCrew could not open Draft Test.");
  } finally {
    busy(button, false, "Test draft — no changes");
  }
}

function renderDraftTestPanel() {
  const host = document.querySelector("#versionedSkillsCard");
  if (!host || !selectedDraft) return;
  draftPanel?.remove();
  draftPanel = document.createElement("section");
  draftPanel.className = "evidence-box";
  draftPanel.id = "skillDraftTestPanel";
  draftPanel.dataset.draftTestPanel = "true";

  const unresolved = selectedDraft.steps?.filter((step) => step?.review?.unresolved === true).length || 0;
  const origin = selectedTab?.url && /^https?:/.test(selectedTab.url) ? new URL(selectedTab.url).origin : null;
  draftPanel.innerHTML = `
    <div class="card-heading"><div><p class="step-label">DRAFT TEST · OBSERVATION ONLY</p><h3>${escapeHtml(selectedDraft.title)} · v${escapeHtml(selectedDraft.version)}</h3></div><button class="button button-small tactile" type="button" data-close-draft-test>Close</button></div>
    <p class="helper">Test checks the current page without clicking, typing, navigating, downloading, saving, approving, or running this draft.</p>
    <p class="helper">Draft Test never asks Chrome for new site access. It can only observe a site BrowserCrew already has permission to inspect.</p>
    <div class="selection-summary" id="skillDraftTestScope"><strong>Exact draft v${escapeHtml(selectedDraft.version)}</strong><p>Websites: ${escapeHtml(selectedDraft.allowedOrigins.join(" · "))}</p><p>Actions recorded: ${escapeHtml(selectedDraft.actionClasses.join(" · "))}</p><p>Current page: ${escapeHtml(origin || "Choose a normal website page")}</p>${unresolved ? `<p>${unresolved} recorded target${unresolved === 1 ? " still needs" : "s still need"} review. Test will mark those steps blocked.</p>` : ""}</div>
    <div id="skillDraftTestInputs"></div>
    <div id="skillDraftTestResult" class="selection-summary" aria-live="polite">Choose Test draft to inspect the current page. Nothing will run.</div>
    <div class="button-row"><button class="button button-primary tactile" type="button" data-run-draft-test>Test draft — no changes</button></div>`;
  host.append(draftPanel);
  renderInputs();
  draftPanel.scrollIntoView({ block: "nearest" });
}

function renderInputs() {
  const root = draftPanel?.querySelector("#skillDraftTestInputs");
  if (!root || !selectedDraft) return;
  root.replaceChildren();
  for (const [name, definition] of Object.entries(selectedDraft.inputs || {})) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.className = "field-label";
    label.htmlFor = `draftTestInput-${name}`;
    label.textContent = `${definition.label || name}${definition.required ? " · required" : ""}${definition.secret ? " · secret" : ""}`;
    const input = document.createElement("input");
    input.id = `draftTestInput-${name}`;
    input.dataset.draftTestInput = name;
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

async function runDraftTest(button) {
  if (!selectedDraft || !selectedTab) return announce("Open Draft Test again on the page you want to inspect.");
  let inputValues;
  try { inputValues = readInputs(); } catch (error) { return announce(error.message); }
  const origin = selectedTab.url && /^https?:/.test(selectedTab.url) ? new URL(selectedTab.url).origin : null;
  if (!origin || !selectedDraft.allowedOrigins.includes(origin)) return announce("Choose a current page that belongs to this draft's recorded websites.");
  busy(button, true, "Testing…");
  try {
    const hasAccess = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!hasAccess) throw new Error("Draft Test does not grant new site access. Give BrowserCrew access to this site first, then test the draft again.");
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    if (!active?.ok || active.tab?.id !== selectedTab.id || new URL(active.tab.url).origin !== origin) throw new Error("The selected page changed. Open Draft Test again for the page you want to inspect.");
    const result = await testDraftSkillOnPage({ skill: selectedDraft, inputValues, tabId: selectedTab.id });
    renderResult(result);
    announce(result.ready ? "Draft Test passed. Nothing ran and the page was not changed." : "Draft Test found items to review. Nothing ran and the page was not changed.");
  } catch (error) {
    const result = draftPanel?.querySelector("#skillDraftTestResult");
    if (result) result.textContent = error.message || "BrowserCrew could not test this draft.";
    announce(error.message || "BrowserCrew could not test this draft.");
  } finally {
    busy(button, false, "Test draft — no changes");
  }
}

function renderResult(test) {
  const root = draftPanel?.querySelector("#skillDraftTestResult");
  if (!root) return;
  const found = test.checks.filter((item) => item.status === "found" || item.status === "matches_now").length;
  const blocked = test.checks.filter((item) => item.status === "blocked").length;
  root.innerHTML = `<strong>${test.ready ? "Draft looks testable on this page" : "Review this draft first"}</strong><p>${found} current-page checks matched${blocked ? ` · ${blocked} blocked` : ""}. No draft step ran and no approval was created.</p><ul>${test.checks.map((item) => `<li>${escapeHtml(item.kind)}: ${escapeHtml(item.message)}</li>`).join("")}</ul>`;
}

function readInputs() {
  const values = {};
  for (const input of draftPanel?.querySelectorAll("[data-draft-test-input]") || []) {
    const name = input.dataset.draftTestInput;
    const type = input.dataset.inputType;
    const required = input.dataset.required === "true";
    let value;
    if (type === "boolean") value = input.checked;
    else if (type === "number") value = input.value === "" ? undefined : Number(input.value);
    else value = input.value;
    if (required && (value === undefined || value === "")) throw new Error(`Enter ${input.labels?.[0]?.textContent?.replace(/ · .*/, "") || name} before testing this draft.`);
    if (value !== undefined && value !== "") values[name] = value;
  }
  return values;
}

function closeDraftTest() {
  draftPanel?.remove();
  draftPanel = null;
  selectedDraft = null;
  selectedTab = null;
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
