import { assertPreparedScheduleMetadataForSkill } from "./schedule-prepared-metadata.js";
import { assertScheduleGrantMatches } from "./schedule-grants-contract.js";

const SCHEDULES_PORT = "browsercrew-schedules";
const GRANTS_PORT = "browsercrew-schedule-grants";
const SKILLS_PORT = "browsercrew-skills";
const CONNECTIONS_PORT = "browsercrew-connections";
let refreshPromise = null;

window.addEventListener("DOMContentLoaded", () => {
  const list = document.querySelector("#preparedScheduleList");
  if (!list || list.dataset.grantReviewMounted === "true") return;
  list.dataset.grantReviewMounted = "true";
  list.addEventListener("click", onGrantAction);
  new MutationObserver(() => refreshGrantCards().catch(() => {})).observe(list, { childList: true });
  window.addEventListener("browsercrew:schedule-binding-updated", () => refreshGrantCards().catch(() => {}));
  refreshGrantCards().catch(() => {});
});

function refreshGrantCards() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = Promise.all([
    portRequest(SCHEDULES_PORT, { type: "list" }),
    portRequest(GRANTS_PORT, { type: "list" }),
    portRequest(SKILLS_PORT, { type: "list" }),
    portRequest(CONNECTIONS_PORT, { type: "GET_CONNECTIONS" })
  ]).then(([scheduleResponse, grantResponse, skillResponse, connectionResponse]) => {
    if (!scheduleResponse.ok) throw new Error(scheduleResponse.error?.message || "Could not load prepared schedules.");
    if (!grantResponse.ok) throw new Error(grantResponse.error?.message || "Could not load schedule permissions.");
    if (!skillResponse.ok) throw new Error(skillResponse.error?.message || "Could not load approved jobs.");
    if (!connectionResponse.ok) throw new Error(connectionResponse.error?.message || "Could not load AI connections.");
    const schedules = scheduleResponse.schedules || [];
    const grants = grantResponse.grants || [];
    const skills = skillResponse.skills || [];
    const connections = connectionResponse.connections || [];
    for (const card of document.querySelectorAll("[data-prepared-schedule]")) {
      const schedule = schedules.find((item) => item.id === card.dataset.preparedSchedule);
      if (schedule) renderGrantCard(card, schedule, grants, skills, connections);
    }
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function renderGrantCard(card, schedule, grants, skills, connections) {
  let box = card.querySelector("[data-schedule-grant-review]");
  if (!box) {
    box = document.createElement("div");
    box.className = "selection-summary";
    box.dataset.scheduleGrantReview = schedule.id;
    const binding = card.querySelector("[data-schedule-binding-review]");
    if (binding) binding.after(box);
    else card.querySelector("[data-schedule-boundaries]")?.after(box);
  }

  const skill = skills.find((item) => item.id === schedule.skillRef?.id && item.version === schedule.skillRef?.version && item.status === "approved");
  const connection = connections.find((item) => item.id === schedule.providerRef);
  if (!skill || !bindingMatches(schedule, skill)) {
    box.innerHTML = `<p><strong>Future permission:</strong> Not approved.</p><p class="helper">Review the exact starting page first. BrowserCrew will not create durable schedule permission from an incomplete or stale binding.</p>`;
    return;
  }

  const referencedIds = Array.isArray(schedule.grantRefs) ? schedule.grantRefs : [];
  const referenced = referencedIds.map((id) => grants.find((grant) => grant.id === id)).filter(Boolean);
  const active = referenced.find((grant) => grant.status === "active" && grant.revoked !== true);
  if (active) {
    try {
      assertScheduleGrantMatches(schedule, skill, active, { now: Date.now() });
      box.innerHTML = `
        <p><strong>Future permission:</strong> Approved until ${escapeHtml(formatDateTime(active.expiresAt))}.</p>
        <p><strong>AI connection:</strong> ${escapeHtml(connectionLabel(connection, schedule.providerRef))}</p>
        <p><strong>Scope:</strong> ${escapeHtml(scopeSummary(active))}</p>
        <p class="helper">The schedule is still off. This permission does not register an alarm or run anything by itself.</p>
        <button class="button button-small tactile" type="button" data-revoke-schedule-grant="${escapeAttr(schedule.id)}" data-grant-id="${escapeAttr(active.id)}">Revoke future permission</button>`;
      return;
    } catch (error) {
      box.innerHTML = `
        <p><strong>Future permission:</strong> Needs review.</p>
        <p class="helper">${escapeHtml(error.message || "The saved permission no longer matches this schedule.")} Revoke it before approving a replacement.</p>
        <button class="button button-small tactile" type="button" data-revoke-schedule-grant="${escapeAttr(schedule.id)}" data-grant-id="${escapeAttr(active.id)}">Revoke stale permission</button>`;
      return;
    }
  }

  renderGrantApproval(box, schedule, connection);
}

function renderGrantApproval(box, schedule, connection) {
  const plan = schedule.authorityPlan;
  box.innerHTML = `
    <p><strong>Future permission:</strong> Not approved.</p>
    <p><strong>AI connection:</strong> ${escapeHtml(connectionLabel(connection, schedule.providerRef))}</p>
    <p><strong>Starting page:</strong> ${escapeHtml(schedule.startResource?.url || "Not reviewed")}</p>
    <p><strong>Scope to approve:</strong> ${escapeHtml(scopeSummary(plan))}</p>
    <p class="helper">Approving this creates revocable permission for this exact schedule, exact Skill version, named AI connection, and reviewed scope. It still does not turn the schedule on.</p>
    <label class="field-label" for="scheduleGrantDays-${escapeAttr(schedule.id)}">Permission expires after</label>
    <select id="scheduleGrantDays-${escapeAttr(schedule.id)}" data-schedule-grant-days="${escapeAttr(schedule.id)}">
      <option value="7">7 days</option>
      <option value="30" selected>30 days</option>
      <option value="90">90 days</option>
      <option value="365">1 year</option>
    </select>
    <button class="button button-small button-primary tactile" type="button" data-approve-schedule-grant="${escapeAttr(schedule.id)}">Approve future permission</button>`;
}

async function onGrantAction(event) {
  const approve = event.target.closest("[data-approve-schedule-grant]");
  const revoke = event.target.closest("[data-revoke-schedule-grant]");
  if (approve) {
    const scheduleId = approve.dataset.approveScheduleGrant;
    const box = approve.closest("[data-schedule-grant-review]");
    const days = Number(box?.querySelector(`[data-schedule-grant-days="${cssEscape(scheduleId)}"]`)?.value || 30);
    if (![7, 30, 90, 365].includes(days)) return announce("Choose a supported permission duration.");
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
    busy(approve, true, "Approving…");
    try {
      const response = await portRequest(GRANTS_PORT, { type: "approve", scheduleId, expiresAt });
      if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not approve that schedule permission.");
      if (response.schedule?.enabled !== false || response.grant?.status !== "active" || response.grant?.scheduleId !== scheduleId || !(response.schedule?.grantRefs || []).includes(response.grant.id)) {
        throw new Error("BrowserCrew refused an unsafe schedule-permission state.");
      }
      announce("Future permission approved. The schedule is still off and no alarm was registered.");
      await refreshGrantCards();
    } catch (error) {
      announce(error.message || "BrowserCrew could not approve that schedule permission.");
    } finally {
      busy(approve, false, "Approve future permission");
    }
    return;
  }
  if (!revoke) return;
  const scheduleId = revoke.dataset.revokeScheduleGrant;
  const grantId = revoke.dataset.grantId;
  busy(revoke, true, "Revoking…");
  try {
    const response = await portRequest(GRANTS_PORT, { type: "revoke", scheduleId, grantId });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not revoke that schedule permission.");
    if (response.grant?.status !== "revoked" || (response.schedule?.grantRefs || []).includes(grantId)) throw new Error("BrowserCrew refused an incomplete schedule-permission revocation.");
    announce("Future permission revoked. This prepared schedule still cannot run.");
    await refreshGrantCards();
  } catch (error) {
    announce(error.message || "BrowserCrew could not revoke that schedule permission.");
  } finally {
    busy(revoke, false, "Revoke future permission");
  }
}

function bindingMatches(schedule, skill) {
  try { return assertPreparedScheduleMetadataForSkill(schedule, skill) === true; }
  catch { return false; }
}

function scopeSummary(value) {
  const actions = value?.actionClasses?.length ? value.actionClasses.join(", ") : "no page actions";
  const resources = value?.resources?.length ? value.resources.join(", ") : "no named resources";
  const destinations = value?.dataDestinations?.length ? value.dataDestinations.join(", ") : "no data destinations";
  return `Actions: ${actions} · Resources: ${resources} · Data: ${destinations}`;
}

function connectionLabel(connection, fallback) { return connection ? `${connection.name}${connection.model ? ` · ${connection.model}` : ""}` : `Saved connection ${fallback || "unavailable"}`; }
function formatDateTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "saved expiry"; }

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
function busy(button, state, label) { if (!button) return; button.disabled = state; button.textContent = label; }
function announce(message) { const toast = document.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.hidden = false; clearTimeout(announce.timer); announce.timer = setTimeout(() => { toast.hidden = true; }, 4000); }
function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
