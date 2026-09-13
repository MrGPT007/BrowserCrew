const SCHEDULES_PORT = "browsercrew-schedules";
const SCHEDULE_CONTROLS_PORT = "browsercrew-schedule-controls";

let schedulerBooted = false;
let activeSchedules = [];

window.addEventListener("DOMContentLoaded", () => {
  hydrateScheduleControls().catch(() => {});
});

async function hydrateScheduleControls() {
  const capability = await portRequest(SCHEDULES_PORT, { type: "capabilities" });
  schedulerBooted = capability.ok === true && capability.schedulerBooted === true;
  if (!schedulerBooted) return;

  const response = await portRequest(SCHEDULES_PORT, { type: "list" });
  if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not load active schedules.");
  activeSchedules = (response.schedules || []).filter((schedule) => schedule.enabled === true);
  installPreparedScheduleObserver();
  renderActiveSchedules();
}

function installPreparedScheduleObserver() {
  const list = document.querySelector("#preparedScheduleList");
  const section = document.querySelector("#preparedSchedulesSection");
  if (!list || !section) return;
  const helper = section.querySelector(":scope > .helper");
  if (helper) helper.textContent = "Prepared schedules stay off until you turn them on. Review the exact job, starting page, AI connection, and future permission before activation.";
  decoratePreparedSchedules();
  const observer = new MutationObserver(decoratePreparedSchedules);
  observer.observe(list, { childList: true, subtree: true });
}

function decoratePreparedSchedules() {
  if (!schedulerBooted) return;
  for (const card of document.querySelectorAll("[data-prepared-schedule]")) {
    const scheduleId = card.getAttribute("data-prepared-schedule");
    const actions = card.querySelector(".skill-actions");
    if (!scheduleId || !actions || actions.querySelector("[data-enable-schedule]")) continue;
    for (const button of [...actions.querySelectorAll("button[disabled]")]) {
      if (["Run now", "Pause"].includes(button.textContent?.trim())) button.remove();
    }
    const enable = document.createElement("button");
    enable.className = "button button-small button-primary tactile";
    enable.type = "button";
    enable.dataset.enableSchedule = scheduleId;
    enable.textContent = "Turn on schedule";
    enable.addEventListener("click", () => enableSchedule(enable, scheduleId));
    actions.prepend(enable);
    const helper = card.querySelector(":scope > .helper");
    if (helper) helper.textContent = "Turning this on re-checks the exact Skill, reviewed starting page, and durable future permission before Chrome registers its alarm.";
  }
}

function renderActiveSchedules() {
  let section = document.querySelector("#activeSchedulesSection");
  if (!section) {
    section = document.createElement("section");
    section.id = "activeSchedulesSection";
    section.innerHTML = `<div class="card-heading"><div><p class="step-label">ACTIVE SCHEDULES</p><h3>Jobs that can run in the background</h3></div><span class="badge badge-safe" id="activeScheduleCount">0</span></div><p class="helper">Run now uses the same reviewed schedule authority and normal BrowserCrew task engine. Pause removes the Chrome alarm without deleting the setup or its history.</p><div id="activeScheduleList"></div>`;
    const prepared = document.querySelector("#preparedSchedulesSection");
    if (prepared) prepared.after(section);
    else document.querySelector("#schedulesPreviewCard")?.append(section);
  }
  const count = section.querySelector("#activeScheduleCount");
  const list = section.querySelector("#activeScheduleList");
  if (!count || !list) return;
  count.textContent = String(activeSchedules.length);
  if (!activeSchedules.length) {
    list.innerHTML = `<div class="empty">No active schedules.</div>`;
    return;
  }
  list.innerHTML = activeSchedules.map((schedule) => `<article class="skill-card" data-active-schedule="${escapeAttr(schedule.id)}"><div class="card-heading"><div><strong>${escapeHtml(schedule.name)}</strong><p>${escapeHtml(schedule.skillRef?.id || "Unknown job")} · v${escapeHtml(schedule.skillRef?.version || "?")}</p></div><span class="badge badge-safe">Active</span></div><div class="selection-summary"><p><strong>Next run:</strong> ${escapeHtml(formatDateTime(schedule.nextRunAt))}</p><p><strong>AI connection:</strong> ${escapeHtml(schedule.providerRef || "Unavailable")}</p><p><strong>Timezone:</strong> ${escapeHtml(schedule.timezone || "UTC")}</p><p><strong>Safety:</strong> The exact Skill, reviewed starting page, grant, provider, resource freshness, budgets, and completion checks are revalidated before every run.</p></div><div class="skill-actions"><button class="button button-small button-primary tactile" type="button" data-run-schedule-now="${escapeAttr(schedule.id)}">Run now</button><button class="button button-small tactile" type="button" data-pause-schedule="${escapeAttr(schedule.id)}">Pause schedule</button></div></article>`).join("");
  list.querySelectorAll("[data-run-schedule-now]").forEach((button) => button.addEventListener("click", () => runNow(button, button.dataset.runScheduleNow)));
  list.querySelectorAll("[data-pause-schedule]").forEach((button) => button.addEventListener("click", () => pauseSchedule(button, button.dataset.pauseSchedule)));
}

async function enableSchedule(button, scheduleId) {
  busy(button, true, "Turning on…");
  try {
    const response = await portRequest(SCHEDULE_CONTROLS_PORT, { type: "enable", scheduleId });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not turn on that schedule.");
    announce("Schedule turned on. BrowserCrew registered its next Chrome alarm.");
    window.location.reload();
  } catch (error) {
    announce(error.message || "BrowserCrew could not turn on that schedule.");
    busy(button, false, "Turn on schedule");
  }
}

async function runNow(button, scheduleId) {
  busy(button, true, "Starting…");
  try {
    const response = await portRequest(SCHEDULE_CONTROLS_PORT, { type: "runNow", scheduleId });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not run that schedule now.");
    announce(response.queued ? "Run now was queued behind the active scheduled job." : "Run now finished. Its receipt is saved in schedule history.");
  } catch (error) {
    announce(error.message || "BrowserCrew could not run that schedule now.");
  } finally {
    busy(button, false, "Run now");
  }
}

async function pauseSchedule(button, scheduleId) {
  busy(button, true, "Pausing…");
  try {
    const response = await portRequest(SCHEDULE_CONTROLS_PORT, { type: "pause", scheduleId });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not pause that schedule.");
    announce("Schedule paused. Its saved setup and history are still here.");
    window.location.reload();
  } catch (error) {
    announce(error.message || "BrowserCrew could not pause that schedule.");
    busy(button, false, "Pause schedule");
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

function busy(button, state, label) { if (button) { button.disabled = state; button.textContent = label; } }
function announce(message) { const toast = document.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.hidden = false; clearTimeout(announce.timer); announce.timer = setTimeout(() => { toast.hidden = true; }, 4000); }
function formatDateTime(value) { const date = new Date(value || ""); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
