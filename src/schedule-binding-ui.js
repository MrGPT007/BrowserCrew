import { assertPreparedScheduleMetadataForSkill, validatePreparedScheduleMetadata } from "./schedule-prepared-metadata.js";

const SCHEDULES_PORT = "browsercrew-schedules";
const SKILLS_PORT = "browsercrew-skills";
let refreshPromise = null;

window.addEventListener("DOMContentLoaded", () => {
  const list = document.querySelector("#preparedScheduleList");
  if (!list || list.dataset.bindingReviewMounted === "true") return;
  list.dataset.bindingReviewMounted = "true";
  list.addEventListener("click", onBindingAction);
  new MutationObserver(() => refreshBindings().catch(() => {})).observe(list, { childList: true });
  refreshBindings().catch(() => {});
});

function refreshBindings() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = Promise.all([
    portRequest(SCHEDULES_PORT, { type: "list" }),
    portRequest(SKILLS_PORT, { type: "list" })
  ]).then(([scheduleResponse, skillResponse]) => {
    if (!scheduleResponse.ok) throw new Error(scheduleResponse.error?.message || "Could not load prepared schedules.");
    if (!skillResponse.ok) throw new Error(skillResponse.error?.message || "Could not load approved jobs.");
    const schedules = scheduleResponse.schedules || [];
    const skills = skillResponse.skills || [];
    for (const card of document.querySelectorAll("[data-prepared-schedule]")) {
      const schedule = schedules.find((item) => item.id === card.dataset.preparedSchedule);
      if (schedule) renderBinding(card, schedule, skills);
    }
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function renderBinding(card, schedule, skills) {
  let box = card.querySelector("[data-schedule-binding-review]");
  if (!box) {
    box = document.createElement("div");
    box.className = "selection-summary";
    box.dataset.scheduleBindingReview = schedule.id;
    const boundaries = card.querySelector("[data-schedule-boundaries]");
    if (boundaries) boundaries.after(box);
    else card.prepend(box);
  }

  const exactSkill = skills.find((item) => item.id === schedule.skillRef?.id && item.version === schedule.skillRef?.version && item.status === "approved");
  const validation = validatePreparedScheduleMetadata(schedule);
  let exactMatch = false;
  if (!validation.legacy && validation.ok && exactSkill) {
    try { exactMatch = assertPreparedScheduleMetadataForSkill(schedule, exactSkill) === true; }
    catch { exactMatch = false; }
  }
  if (exactMatch) {
    const plan = schedule.authorityPlan;
    const resources = plan.resources?.length ? plan.resources.join(", ") : "None";
    const actions = plan.actionClasses?.length ? plan.actionClasses.join(", ") : "None";
    const destinations = plan.dataDestinations?.length ? plan.dataDestinations.join(", ") : "None";
    box.innerHTML = `
      <p><strong>Starting page:</strong> ${escapeHtml(schedule.startResource.url)}</p>
      <p><strong>Authority:</strong> Prepared-only requirements — this is not permission to run.</p>
      <p><strong>Future permission plan:</strong> Actions ${escapeHtml(actions)} · Resources ${escapeHtml(resources)} · Data destinations ${escapeHtml(destinations)}.</p>
      <p class="helper">BrowserCrew stored no tab ID, no login secret, and no executable grant. A future activation must create and re-check separate schedule authority.</p>
      <button class="button button-small tactile" type="button" data-edit-schedule-binding="${escapeAttr(schedule.id)}">Review a different starting page</button>`;
    return;
  }
  const message = validation.legacy
    ? "Choose the exact page where this prepared job should start."
    : "This saved starting-page review no longer matches the exact approved job. Review it again before any future activation.";
  renderEditor(box, schedule, message);
}

function renderEditor(box, schedule, message = "Review a safe starting page for this prepared schedule.") {
  const current = schedule.startResource?.url || "";
  box.innerHTML = `
    <p><strong>Starting page:</strong> Not ready for future activation.</p>
    <p class="helper">${escapeHtml(message)} Use a normal http/https page from the approved Skill. Do not include query parameters, a # fragment, usernames, or passwords.</p>
    <label class="field-label" for="scheduleStartPage-${escapeAttr(schedule.id)}">Starting page URL</label>
    <input id="scheduleStartPage-${escapeAttr(schedule.id)}" data-schedule-start-url="${escapeAttr(schedule.id)}" type="url" inputmode="url" autocomplete="off" maxlength="2048" placeholder="https://example.com/dashboard" value="${escapeAttr(current)}" />
    <div class="button-row">
      <button class="button button-small button-primary tactile" type="button" data-save-schedule-binding="${escapeAttr(schedule.id)}">Review starting page</button>
      ${current ? `<button class="button button-small tactile" type="button" data-cancel-schedule-binding="${escapeAttr(schedule.id)}">Cancel</button>` : ""}
    </div>
    <p><strong>Authority:</strong> No permission grant exists. Reviewing this page cannot run the schedule.</p>`;
}

async function onBindingAction(event) {
  const edit = event.target.closest("[data-edit-schedule-binding]");
  const save = event.target.closest("[data-save-schedule-binding]");
  const cancel = event.target.closest("[data-cancel-schedule-binding]");
  if (edit) {
    const schedules = await loadSchedules();
    const schedule = schedules.find((item) => item.id === edit.dataset.editScheduleBinding);
    const box = edit.closest("[data-schedule-binding-review]");
    if (schedule && box) {
      renderEditor(box, schedule);
      box.querySelector("[data-schedule-start-url]")?.focus();
    }
    return;
  }
  if (cancel) {
    await refreshBindings();
    return;
  }
  if (!save) return;

  const scheduleId = save.dataset.saveScheduleBinding;
  const box = save.closest("[data-schedule-binding-review]");
  const input = box?.querySelector(`[data-schedule-start-url="${cssEscape(scheduleId)}"]`);
  const pageUrl = String(input?.value || "").trim();
  if (!pageUrl) return announce("Enter the exact starting page URL you want to review.");

  busy(save, true, "Reviewing…");
  try {
    const response = await portRequest(SCHEDULES_PORT, { type: "setPreparedBinding", scheduleId, pageUrl });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not save that starting-page review.");
    assertPreparedOnlyResponse(response.schedule);
    announce("Starting page reviewed. The schedule is still off and no permission grant was created.");
    await refreshBindings();
    window.dispatchEvent(new CustomEvent("browsercrew:schedule-binding-updated", { detail: { scheduleId } }));
  } catch (error) {
    announce(error.message || "BrowserCrew could not save that starting-page review.");
  } finally {
    busy(save, false, "Review starting page");
  }
}

async function loadSchedules() {
  const response = await portRequest(SCHEDULES_PORT, { type: "list" });
  if (!response.ok) throw new Error(response.error?.message || "Could not load prepared schedules.");
  return response.schedules || [];
}

function assertPreparedOnlyResponse(schedule) {
  if (schedule?.enabled !== false || (schedule?.grantRefs || []).length || schedule?.authorityPlan?.status !== "prepared_only") {
    throw new Error("BrowserCrew refused an unsafe prepared-schedule binding state.");
  }
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
  announce.timer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
