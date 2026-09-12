const SCHEDULES_PORT = "browsercrew-schedules";
const SKILLS_PORT = "browsercrew-skills";
const CONNECTIONS_PORT = "browsercrew-connections";

let preparedSchedules = [];
let approvedSkills = [];
let connections = [];
let activeConnectionId = null;
let editingScheduleId = null;

window.addEventListener("DOMContentLoaded", () => {
  const card = document.querySelector("#schedulesPreviewCard");
  const setupButton = document.querySelector("#scheduleSetupButton");
  const capability = document.querySelector("#scheduleCapabilityStatus");
  if (!card || !setupButton || !capability || card.querySelector("#scheduleSetupPanel")) return;

  setupButton.disabled = false;
  setupButton.textContent = "Prepare a schedule";
  capability.after(setupButton);

  const panel = createSetupPanel();
  const prepared = createPreparedSchedulesSection();
  const reviewHeading = document.querySelector("#scheduleReviewCount")?.closest(".card-heading");
  if (reviewHeading) reviewHeading.before(panel, prepared);
  else setupButton.after(panel, prepared);

  setupButton.addEventListener("click", openNewSchedule);
  panel.querySelector("#schedulePreset")?.addEventListener("change", renderRecurrenceFields);
  panel.querySelector("#scheduleSkill")?.addEventListener("change", renderBudgetSummary);
  panel.querySelector("#scheduleSaveDraft")?.addEventListener("click", savePreparedSchedule);
  panel.querySelector("#scheduleCancelDraft")?.addEventListener("click", closeScheduleSetup);
  prepared.querySelector("#preparedScheduleList")?.addEventListener("click", onPreparedScheduleAction);

  Promise.all([loadApprovedSkills(), loadConnections(), loadPreparedSchedules()]).then(() => {
    renderSetupChoices();
    renderPreparedSchedules();
  }).catch((error) => announce(error.message || "BrowserCrew could not load schedule setup."));
});

function createSetupPanel() {
  const panel = document.createElement("section");
  panel.id = "scheduleSetupPanel";
  panel.hidden = true;
  panel.className = "evidence-box";
  panel.innerHTML = `
    <div class="card-heading"><div><p class="step-label">PREPARE ONLY</p><h3 id="scheduleSetupTitle">Prepare a schedule</h3></div><span class="badge">Not active</span></div>
    <p class="helper">Save the schedule details now. This build will not register an alarm or run it in the background. Turning schedules on stays locked until the post-v0.2 release adds that permission intentionally.</p>

    <label class="field-label" for="scheduleSkill">Which approved job should run?</label>
    <select id="scheduleSkill"></select>
    <p class="helper" id="scheduleSkillHelp">Only approved skill versions can be prepared for scheduling.</p>

    <label class="field-label" for="scheduleName">Schedule name</label>
    <input id="scheduleName" type="text" maxlength="120" placeholder="Example: Check supplier prices every morning" autocomplete="off" />

    <label class="field-label" for="schedulePreset">When should it run?</label>
    <select id="schedulePreset">
      <option value="once">Once</option>
      <option value="daily">Every day</option>
      <option value="weekly">Every week</option>
      <option value="interval">Custom interval</option>
    </select>

    <div id="scheduleOnceFields" data-schedule-fields="once">
      <label class="field-label" for="scheduleOnceAt">Date and time</label>
      <input id="scheduleOnceAt" type="datetime-local" />
    </div>
    <div id="scheduleDailyFields" data-schedule-fields="daily" hidden>
      <label class="field-label" for="scheduleDailyTime">Time each day</label>
      <input id="scheduleDailyTime" type="time" value="09:00" />
    </div>
    <div id="scheduleWeeklyFields" data-schedule-fields="weekly" hidden>
      <label class="field-label" for="scheduleWeekday">Day of week</label>
      <select id="scheduleWeekday">
        <option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option>
        <option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option>
      </select>
      <label class="field-label" for="scheduleWeeklyTime">Time</label>
      <input id="scheduleWeeklyTime" type="time" value="09:00" />
    </div>
    <div id="scheduleIntervalFields" data-schedule-fields="interval" hidden>
      <label class="field-label" for="scheduleIntervalMinutes">Repeat every</label>
      <div class="button-row"><input id="scheduleIntervalMinutes" type="number" min="1" max="43200" step="1" value="60" /><span class="helper">minutes</span></div>
    </div>

    <label class="field-label" for="scheduleTimezone">Timezone</label>
    <input id="scheduleTimezone" type="text" maxlength="80" autocomplete="off" />
    <p class="helper">Daily and weekly schedules stay at the wall-clock time you chose when daylight-saving rules change.</p>

    <label class="field-label" for="scheduleConnection">AI connection</label>
    <select id="scheduleConnection"></select>
    <p class="helper">BrowserCrew stores the connection reference, not its secret. The connection is checked again before any future run.</p>

    <div class="selection-summary" id="scheduleBudgetSummary">Choose an approved job to see its safety limits.</div>

    <label class="field-label" for="scheduleMissedPolicy">If the browser was asleep and this time was missed</label>
    <select id="scheduleMissedPolicy">
      <option value="ask">Ask me what to do</option>
      <option value="skip">Skip that missed run</option>
      <option value="run_once_when_available">Run it once when BrowserCrew is available</option>
    </select>

    <label class="field-label" for="scheduleConcurrency">If the previous run is still working</label>
    <select id="scheduleConcurrency">
      <option value="skip_if_running">Skip the overlapping run</option>
      <option value="queue_one">Queue one run, then reject extra overlap</option>
    </select>

    <div class="button-row">
      <button class="button button-primary tactile" id="scheduleSaveDraft" type="button">Save prepared schedule</button>
      <button class="button tactile" id="scheduleCancelDraft" type="button">Cancel</button>
    </div>
    <p class="helper">Saving here does not turn the schedule on and does not add Chrome's alarms permission.</p>`;
  return panel;
}

function createPreparedSchedulesSection() {
  const section = document.createElement("section");
  section.id = "preparedSchedulesSection";
  section.innerHTML = `
    <div class="card-heading"><div><p class="step-label">PREPARED SCHEDULES</p><h3>Ready for a future schedule release</h3></div><span class="badge" id="preparedScheduleCount">0</span></div>
    <p class="helper">Prepared schedules are saved but disabled. You can edit or delete them now; this build cannot activate them.</p>
    <div id="preparedScheduleList"><div class="empty">No prepared schedules yet.</div></div>`;
  return section;
}

async function loadApprovedSkills() {
  const response = await portRequest(SKILLS_PORT, { type: "list" });
  if (!response.ok) throw new Error(response.error?.message || "Could not load approved jobs.");
  approvedSkills = (response.skills || []).filter((skill) => skill.status === "approved");
}

async function loadConnections() {
  const response = await portRequest(CONNECTIONS_PORT, { type: "GET_CONNECTIONS" });
  if (!response.ok) throw new Error(response.error?.message || "Could not load AI connections.");
  connections = response.connections || [];
  activeConnectionId = response.activeId || connections[0]?.id || null;
}

async function loadPreparedSchedules() {
  const response = await portRequest(SCHEDULES_PORT, { type: "list" });
  if (!response.ok) throw new Error(response.error?.message || "Could not load prepared schedules.");
  preparedSchedules = (response.schedules || []).filter((schedule) => schedule.enabled === false);
}

function renderSetupChoices() {
  const skillSelect = document.querySelector("#scheduleSkill");
  const connectionSelect = document.querySelector("#scheduleConnection");
  const setupButton = document.querySelector("#scheduleSetupButton");
  if (!skillSelect || !connectionSelect || !setupButton) return;

  skillSelect.innerHTML = approvedSkills.length
    ? approvedSkills.map((skill) => `<option value="${escapeAttr(`${skill.id}@@${skill.version}`)}">${escapeHtml(skill.title)} · v${escapeHtml(skill.version)}</option>`).join("")
    : `<option value="">Approve a skill first</option>`;
  connectionSelect.innerHTML = connections.length
    ? connections.map((connection) => `<option value="${escapeAttr(connection.id)}">${escapeHtml(connection.name)}${connection.model ? ` · ${escapeHtml(connection.model)}` : ""}</option>`).join("")
    : `<option value="">Connect an AI first</option>`;
  if (activeConnectionId && connections.some((item) => item.id === activeConnectionId)) connectionSelect.value = activeConnectionId;

  setupButton.disabled = !approvedSkills.length || !connections.length;
  setupButton.textContent = !approvedSkills.length ? "Approve a skill before preparing a schedule" : !connections.length ? "Connect an AI before preparing a schedule" : "Prepare a schedule";
  setDefaultTimezone();
  renderBudgetSummary();
}

function renderPreparedSchedules() {
  const list = document.querySelector("#preparedScheduleList");
  const count = document.querySelector("#preparedScheduleCount");
  if (!list || !count) return;
  count.textContent = String(preparedSchedules.length);
  if (!preparedSchedules.length) {
    list.innerHTML = `<div class="empty">No prepared schedules yet.</div>`;
    return;
  }

  list.innerHTML = preparedSchedules.map((schedule) => {
    const skill = approvedSkills.find((item) => item.id === schedule.skillRef?.id && item.version === schedule.skillRef?.version);
    const connection = connections.find((item) => item.id === schedule.providerRef);
    return `<article class="skill-card" data-prepared-schedule="${escapeAttr(schedule.id)}">
      <div><strong>${escapeHtml(schedule.name)}</strong><p>${escapeHtml(describeRecurrence(schedule))}</p><small>Prepared · not active · ${escapeHtml(skill?.title || schedule.skillRef?.id || "Unknown skill")} · ${escapeHtml(connection?.name || "Saved AI connection")} · ${escapeHtml(schedule.timezone)}</small></div>
      <div class="skill-actions">
        <button class="button button-small tactile" type="button" data-edit-schedule="${escapeAttr(schedule.id)}">Edit</button>
        <button class="button button-small tactile" type="button" data-delete-schedule="${escapeAttr(schedule.id)}">Delete</button>
      </div>
    </article>`;
  }).join("");
}

function openNewSchedule() {
  editingScheduleId = null;
  const panel = document.querySelector("#scheduleSetupPanel");
  if (!panel) return;
  resetForm();
  panel.hidden = false;
  document.querySelector("#scheduleSetupTitle").textContent = "Prepare a schedule";
  document.querySelector("#scheduleName")?.focus();
}

function closeScheduleSetup() {
  editingScheduleId = null;
  const panel = document.querySelector("#scheduleSetupPanel");
  if (panel) panel.hidden = true;
}

function resetForm() {
  const name = document.querySelector("#scheduleName");
  const preset = document.querySelector("#schedulePreset");
  const missed = document.querySelector("#scheduleMissedPolicy");
  const concurrency = document.querySelector("#scheduleConcurrency");
  const interval = document.querySelector("#scheduleIntervalMinutes");
  const daily = document.querySelector("#scheduleDailyTime");
  const weekly = document.querySelector("#scheduleWeeklyTime");
  const weekday = document.querySelector("#scheduleWeekday");
  if (name) name.value = "";
  if (preset) preset.value = "once";
  if (missed) missed.value = "ask";
  if (concurrency) concurrency.value = "skip_if_running";
  if (interval) interval.value = "60";
  if (daily) daily.value = "09:00";
  if (weekly) weekly.value = "09:00";
  if (weekday) weekday.value = "1";
  if (activeConnectionId && document.querySelector("#scheduleConnection")) document.querySelector("#scheduleConnection").value = activeConnectionId;
  setDefaultTimezone();
  setDefaultOnceTime();
  renderRecurrenceFields();
  renderBudgetSummary();
}

function setDefaultTimezone() {
  const input = document.querySelector("#scheduleTimezone");
  if (!input || input.value) return;
  input.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function setDefaultOnceTime() {
  const input = document.querySelector("#scheduleOnceAt");
  if (!input || input.value) return;
  const date = new Date(Date.now() + 60 * 60_000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  input.value = local;
}

function renderRecurrenceFields() {
  const kind = document.querySelector("#schedulePreset")?.value || "once";
  document.querySelectorAll("[data-schedule-fields]").forEach((element) => { element.hidden = element.dataset.scheduleFields !== kind; });
}

function renderBudgetSummary() {
  const selected = selectedSkill();
  const summary = document.querySelector("#scheduleBudgetSummary");
  if (!summary) return;
  if (!selected) {
    summary.textContent = "Choose an approved job to see its safety limits.";
    return;
  }
  const origins = selected.allowedOrigins?.length || 0;
  summary.textContent = `Safety limits from this exact skill version: up to ${selected.budgets?.maxSteps || "?"} steps, ${selected.budgets?.maxMinutes || "?"} minutes, across ${origins} approved site${origins === 1 ? "" : "s"}.`;
}

async function savePreparedSchedule() {
  const button = document.querySelector("#scheduleSaveDraft");
  const name = String(document.querySelector("#scheduleName")?.value || "").replace(/\s+/g, " ").trim();
  const skill = selectedSkill();
  const providerRef = document.querySelector("#scheduleConnection")?.value || "";
  const timezone = String(document.querySelector("#scheduleTimezone")?.value || "").trim();
  if (!name) return announce("Give this prepared schedule a short name.");
  if (!skill) return announce("Choose an approved job before saving this schedule.");
  if (!providerRef) return announce("Choose the AI connection this schedule should use.");
  if (!timezone) return announce("Choose the timezone for this schedule.");

  let recurrence;
  try {
    recurrence = readRecurrence();
  } catch (error) {
    announce(error.message);
    return;
  }

  const existing = preparedSchedules.find((item) => item.id === editingScheduleId);
  const schedule = {
    schemaVersion: 1,
    id: existing?.id || `schedule-${crypto.randomUUID()}`,
    name,
    enabled: false,
    skillRef: { id: skill.id, version: skill.version },
    timezone,
    recurrence,
    missedRunPolicy: document.querySelector("#scheduleMissedPolicy")?.value || "ask",
    concurrencyPolicy: document.querySelector("#scheduleConcurrency")?.value || "skip_if_running",
    providerRef,
    grantRefs: Array.isArray(existing?.grantRefs) ? existing.grantRefs : [],
    budgets: {
      maxSteps: Number(skill.budgets?.maxSteps || 10),
      maxMinutes: Number(skill.budgets?.maxMinutes || 10)
    },
    ...(existing?.createdAt ? { createdAt: existing.createdAt } : {})
  };

  busy(button, true, "Saving…");
  try {
    const response = await portRequest(SCHEDULES_PORT, { type: "saveDraft", schedule });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not save this prepared schedule.");
    announce("Prepared schedule saved. It is still off and no alarm was registered.");
    closeScheduleSetup();
    await loadPreparedSchedules();
    renderPreparedSchedules();
  } catch (error) {
    announce(error.message || "BrowserCrew could not save this prepared schedule.");
  } finally {
    busy(button, false, "Save prepared schedule");
  }
}

function readRecurrence() {
  const kind = document.querySelector("#schedulePreset")?.value || "once";
  if (kind === "once") {
    const raw = document.querySelector("#scheduleOnceAt")?.value || "";
    const when = new Date(raw).getTime();
    if (!raw || !Number.isFinite(when) || when <= Date.now()) throw new Error("Choose a future date and time for this one-time schedule.");
    return { kind: "once", when };
  }
  if (kind === "daily") {
    const [hour, minute] = readClock("#scheduleDailyTime", "Choose a daily time.");
    return { kind: "daily", hour, minute };
  }
  if (kind === "weekly") {
    const [hour, minute] = readClock("#scheduleWeeklyTime", "Choose a weekly time.");
    const weekday = Number(document.querySelector("#scheduleWeekday")?.value);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error("Choose a day of the week.");
    return { kind: "weekly", weekday, hour, minute };
  }
  const everyMinutes = Number(document.querySelector("#scheduleIntervalMinutes")?.value);
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 43_200) throw new Error("Custom interval must be between 1 and 43,200 minutes.");
  return { kind: "interval", everyMinutes };
}

function readClock(selector, message) {
  const raw = document.querySelector(selector)?.value || "";
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) throw new Error(message);
  return [Number(match[1]), Number(match[2])];
}

async function onPreparedScheduleAction(event) {
  const edit = event.target.closest("[data-edit-schedule]");
  const remove = event.target.closest("[data-delete-schedule]");
  if (edit) {
    const schedule = preparedSchedules.find((item) => item.id === edit.dataset.editSchedule);
    if (schedule) editPreparedSchedule(schedule);
    return;
  }
  if (!remove) return;
  const schedule = preparedSchedules.find((item) => item.id === remove.dataset.deleteSchedule);
  if (!schedule || !confirm(`Delete the prepared schedule “${schedule.name}”? It is currently off and no scheduled run will be dispatched.`)) return;
  busy(remove, true, "Deleting…");
  try {
    const response = await portRequest(SCHEDULES_PORT, { type: "delete", scheduleId: schedule.id });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not delete that prepared schedule.");
    announce("Prepared schedule deleted.");
    if (editingScheduleId === schedule.id) closeScheduleSetup();
    await loadPreparedSchedules();
    renderPreparedSchedules();
  } catch (error) {
    announce(error.message || "BrowserCrew could not delete that prepared schedule.");
  } finally {
    busy(remove, false, "Delete");
  }
}

function editPreparedSchedule(schedule) {
  editingScheduleId = schedule.id;
  const panel = document.querySelector("#scheduleSetupPanel");
  if (!panel) return;
  panel.hidden = false;
  document.querySelector("#scheduleSetupTitle").textContent = "Edit prepared schedule";
  document.querySelector("#scheduleName").value = schedule.name || "";
  document.querySelector("#scheduleSkill").value = `${schedule.skillRef?.id || ""}@@${schedule.skillRef?.version || ""}`;
  document.querySelector("#scheduleConnection").value = schedule.providerRef || "";
  document.querySelector("#scheduleTimezone").value = schedule.timezone || "UTC";
  document.querySelector("#scheduleMissedPolicy").value = schedule.missedRunPolicy || "ask";
  document.querySelector("#scheduleConcurrency").value = schedule.concurrencyPolicy || "skip_if_running";
  document.querySelector("#schedulePreset").value = schedule.recurrence?.kind || "once";

  if (schedule.recurrence?.kind === "once") {
    const date = new Date(schedule.recurrence.when);
    document.querySelector("#scheduleOnceAt").value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  } else if (schedule.recurrence?.kind === "daily") {
    document.querySelector("#scheduleDailyTime").value = clockValue(schedule.recurrence.hour, schedule.recurrence.minute);
  } else if (schedule.recurrence?.kind === "weekly") {
    document.querySelector("#scheduleWeekday").value = String(schedule.recurrence.weekday);
    document.querySelector("#scheduleWeeklyTime").value = clockValue(schedule.recurrence.hour, schedule.recurrence.minute);
  } else if (schedule.recurrence?.kind === "interval") {
    document.querySelector("#scheduleIntervalMinutes").value = String(schedule.recurrence.everyMinutes || 60);
  }
  renderRecurrenceFields();
  renderBudgetSummary();
  document.querySelector("#scheduleName")?.focus();
}

function selectedSkill() {
  const raw = document.querySelector("#scheduleSkill")?.value || "";
  const separator = raw.lastIndexOf("@@");
  if (separator < 1) return null;
  const id = raw.slice(0, separator);
  const version = raw.slice(separator + 2);
  return approvedSkills.find((skill) => skill.id === id && skill.version === version) || null;
}

function describeRecurrence(schedule) {
  const recurrence = schedule.recurrence || {};
  if (recurrence.kind === "once") return `Once · ${formatDateTime(recurrence.when)}`;
  if (recurrence.kind === "daily") return `Every day · ${clockValue(recurrence.hour, recurrence.minute)} · ${schedule.timezone}`;
  if (recurrence.kind === "weekly") return `Every ${weekdayName(recurrence.weekday)} · ${clockValue(recurrence.hour, recurrence.minute)} · ${schedule.timezone}`;
  if (recurrence.kind === "interval") return `Every ${recurrence.everyMinutes} minute${recurrence.everyMinutes === 1 ? "" : "s"}`;
  return "Custom schedule";
}

function formatDateTime(epoch) {
  const date = new Date(epoch);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "saved time";
}

function clockValue(hour, minute) {
  return `${String(Number(hour) || 0).padStart(2, "0")}:${String(Number(minute) || 0).padStart(2, "0")}`;
}

function weekdayName(value) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(value)] || "week";
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

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
