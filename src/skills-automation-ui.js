const WATCH_PORT = "browsercrew-watch-control";
const SKILLS_PORT = "browsercrew-skills";
const SCHEDULES_PORT = "browsercrew-schedules";
let watchState = null;
let skillVersions = [];
let scheduleRuns = [];
let scheduleCapabilities = { alarmsAvailable: false, schedulerBooted: false };
let watchPollTimer = null;

window.addEventListener("DOMContentLoaded", () => {
  const view = document.querySelector("#view-skills");
  const heading = view?.querySelector(".view-heading");
  if (!view || !heading) return;
  if (view.querySelector("#watchMeCard")) return;

  heading.querySelector("h1").textContent = "Teach and reuse browser jobs";
  const intro = heading.querySelector(".view-intro");
  if (intro) intro.textContent = "Save a way to do a browser job, or show BrowserCrew how you do it once. Recorded jobs stay drafts until you review and approve them.";

  const fragment = document.createDocumentFragment();
  fragment.append(createWatchCard(), createVersionedSkillsCard(), createSchedulesCard());
  heading.after(fragment);
  bindAutomationEvents();
  Promise.all([refreshWatchState(), refreshSkillLibrary(), refreshScheduleReview()]).catch(() => {});
});

function createWatchCard() {
  const card = document.createElement("article");
  card.className = "card card-accent";
  card.id = "watchMeCard";
  card.innerHTML = `
    <div class="card-heading"><div><p class="step-label">TEACH BROWSERCREW</p><h2>Watch me do it</h2></div><span class="badge" id="watchMeBadge">Ready</span></div>
    <p class="helper">Do the job once while BrowserCrew watches the page you choose. It records the steps, not your passwords or secret values.</p>
    <div class="example-box">👀 BrowserCrew watches only the tab and website you approve. If you leave that site, recording pauses for review.</div>
    <div class="button-row" id="watchMeStartRow">
      <button class="button button-primary tactile" id="watchMeStartButton" type="button">Watch me do it</button>
    </div>
    <div id="watchMeRunning" hidden>
      <div class="selection-summary" id="watchMeStatus" aria-live="polite">Watching this page…</div>
      <label class="field-label" for="watchMeCompletionText">What text tells you this worked?</label>
      <input id="watchMeCompletionText" type="text" maxlength="160" placeholder="Example: Ready to review" autocomplete="off" />
      <p class="helper">At the end, enter a short status or heading you can see on the page. Don’t use a name, email, account number, password, or other private value.</p>
      <div class="button-row">
        <button class="button tactile" id="watchMePauseButton" type="button">Pause watching</button>
        <button class="button button-primary tactile" id="watchMeStopButton" type="button">Stop and review steps</button>
      </div>
    </div>
    <div id="watchMeDraftResult" hidden aria-live="polite"></div>`;
  return card;
}

function createVersionedSkillsCard() {
  const card = document.createElement("article");
  card.className = "card";
  card.id = "versionedSkillsCard";
  card.innerHTML = `
    <div class="card-heading"><div><p class="step-label">REVIEWED SKILLS</p><h2>Saved ways to do a job</h2></div><span class="badge" id="versionedSkillCount">0</span></div>
    <p class="helper">A recorded job starts as a draft. Review the steps and requested sites before you approve it. Approval never grants new site or write permissions.</p>
    <div id="versionedSkillList"><div class="empty">No recorded skill drafts yet.</div></div>`;
  return card;
}

function createSchedulesCard() {
  const card = document.createElement("article");
  card.className = "card";
  card.id = "schedulesPreviewCard";
  card.innerHTML = `
    <div class="card-heading"><div><p class="step-label">AUTOMATION</p><h2>Run on a schedule</h2></div><span class="badge badge-warning">Feature track</span></div>
    <p class="helper">Choose an approved skill, then run it once, every day, every week, or on a custom interval. Scheduled runs use the same permissions and safety checks as a normal job.</p>
    <div class="plain-list">
      <div><span>🕒</span><p><strong>Your timezone:</strong> calendar schedules stay at the time you chose, including daylight-saving changes.</p></div>
      <div><span>🔒</span><p><strong>No hidden authority:</strong> expired grants, changed pages, unavailable AI, or an already-running job block the scheduled run.</p></div>
      <div><span>💤</span><p><strong>If the computer sleeps:</strong> BrowserCrew cannot wake it. You choose whether a missed job is skipped, run once later, or waits for you.</p></div>
    </div>
    <div class="selection-summary" id="scheduleCapabilityStatus" aria-live="polite">Scheduling is not active in this build.</div>
    <div class="card-heading"><div><p class="step-label">NEEDS YOUR CHOICE</p><h3>Missed jobs waiting for you</h3></div><span class="badge" id="scheduleReviewCount">0</span></div>
    <p class="helper">If you chose “Ask me” for a missed job, BrowserCrew waits here. Nothing runs until you choose what to do.</p>
    <div id="scheduleReviewList"><div class="empty">No missed scheduled jobs need your choice.</div></div>
    <button class="button tactile full" id="scheduleSetupButton" type="button" disabled>Schedule setup unlocks after the v0.2 release is frozen</button>`;
  return card;
}

function bindAutomationEvents() {
  document.querySelector("#watchMeStartButton")?.addEventListener("click", startWatchMe);
  document.querySelector("#watchMePauseButton")?.addEventListener("click", toggleWatchPause);
  document.querySelector("#watchMeStopButton")?.addEventListener("click", stopWatchMe);
  document.querySelector("#versionedSkillList")?.addEventListener("click", onSkillAction);
  document.querySelector("#scheduleReviewList")?.addEventListener("click", onScheduleReviewAction);
}

async function startWatchMe() {
  const button = document.querySelector("#watchMeStartButton");
  busy(button, true, "Checking this page…");
  try {
    const active = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
    if (!active?.ok) throw new Error(active?.error?.message || "Open the page you want BrowserCrew to watch.");
    const origin = new URL(active.tab.url).origin;
    const pattern = `${origin}/*`;
    let granted = await chrome.permissions.contains({ origins: [pattern] });
    if (!granted) granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("BrowserCrew did not start watching because site access was not approved.");

    const response = await portRequest(WATCH_PORT, { type: "start", tab: active.tab });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not start watching this page.");
    watchState = response.state;
    const completion = document.querySelector("#watchMeCompletionText");
    if (completion) completion.value = "";
    renderWatchState();
    syncWatchPolling();
  } catch (error) {
    announce(error.message || "BrowserCrew could not start Watch me do it.");
  } finally {
    busy(button, false, "Watch me do it");
  }
}

async function toggleWatchPause() {
  const button = document.querySelector("#watchMePauseButton");
  const paused = watchState?.session?.status === "paused";
  const response = await portRequest(WATCH_PORT, { type: paused ? "resume" : "pause" });
  if (!response.ok) { announce(response.error?.message || "BrowserCrew could not change the recording state."); return; }
  watchState = response.state;
  renderWatchState();
  syncWatchPolling();
}

async function stopWatchMe() {
  const button = document.querySelector("#watchMeStopButton");
  const completionInput = document.querySelector("#watchMeCompletionText");
  const completionText = String(completionInput?.value || "").replace(/\s+/g, " ").trim();
  if (!completionText) {
    announce("Add a short piece of text that is visible when this job has worked.");
    completionInput?.focus();
    return;
  }
  busy(button, true, "Checking the result…");
  try {
    const response = await portRequest(WATCH_PORT, { type: "stop", draft: { title: "My recorded browser job", completionText } });
    if (!response.ok) throw new Error(response.error?.message || "BrowserCrew could not create the draft skill.");
    watchState = response.state;
    renderWatchState();
    syncWatchPolling();
    showDraftSummary(response.draft);
    if (completionInput) completionInput.value = "";
    await refreshSkillLibrary();
  } catch (error) {
    announce(error.message || "BrowserCrew could not stop this recording safely.");
  } finally {
    busy(button, false, "Stop and review steps");
  }
}

async function refreshWatchState() {
  try {
    const response = await portRequest(WATCH_PORT, { type: "get" });
    if (response.ok) watchState = response.state;
  } catch {}
  renderWatchState();
  syncWatchPolling();
}

function syncWatchPolling() {
  const active = ["watching", "paused", "scope_review"].includes(watchState?.session?.status);
  if (!active) {
    if (watchPollTimer) clearTimeout(watchPollTimer);
    watchPollTimer = null;
    return;
  }
  if (watchPollTimer) return;
  watchPollTimer = setTimeout(async () => {
    watchPollTimer = null;
    await refreshWatchState();
  }, 400);
}

function renderWatchState() {
  const startRow = document.querySelector("#watchMeStartRow");
  const running = document.querySelector("#watchMeRunning");
  const badge = document.querySelector("#watchMeBadge");
  const status = document.querySelector("#watchMeStatus");
  const pauseButton = document.querySelector("#watchMePauseButton");
  if (!startRow || !running || !badge || !status || !pauseButton) return;

  const value = watchState?.session?.status;
  const active = ["watching", "paused", "scope_review"].includes(value);
  startRow.hidden = active;
  running.hidden = !active;
  pauseButton.disabled = false;
  if (!active) {
    badge.textContent = watchState?.draftRef ? "Draft saved" : "Ready";
    return;
  }
  const count = watchState.session.events?.length || 0;
  if (value === "watching") {
    badge.textContent = "Watching";
    status.textContent = `● Watching ${watchState.tabTitle || "this page"} · ${count} step${count === 1 ? "" : "s"} recorded`;
    pauseButton.textContent = "Pause watching";
  } else if (value === "paused") {
    badge.textContent = "Paused";
    status.textContent = `Paused · ${count} step${count === 1 ? "" : "s"} recorded. Nothing new is being recorded.`;
    pauseButton.textContent = "Resume watching";
  } else {
    badge.textContent = "Site changed";
    status.textContent = "Recording paused because the watched tab moved to a different website. Stop and review the draft before expanding scope.";
    pauseButton.textContent = "Review required";
    pauseButton.disabled = true;
  }
}

function showDraftSummary(draft) {
  const box = document.querySelector("#watchMeDraftResult");
  if (!box || !draft) return;
  box.hidden = false;
  const inputs = Object.values(draft.inputs || {});
  const secrets = inputs.filter((item) => item.secret).length;
  const finalCheck = draft.steps?.at(-1)?.expect?.visibleText || "saved result check";
  box.className = "evidence-box";
  box.innerHTML = `<strong>Draft ready for review</strong><p>${escapeHtml(String(draft.steps?.length || 0))} semantic steps · ${escapeHtml(String(inputs.length))} runtime inputs${secrets ? ` · ${escapeHtml(String(secrets))} private input${secrets === 1 ? "" : "s"}` : ""}.</p><p>BrowserCrew will finish only after it can verify: “${escapeHtml(finalCheck)}”. Nothing will replay until you approve this exact version.</p>`;
}

async function refreshSkillLibrary() {
  try {
    const response = await portRequest(SKILLS_PORT, { type: "list" });
    if (!response.ok) throw new Error(response.error?.message || "Could not load recorded skills.");
    skillVersions = response.skills || [];
    renderSkillLibrary();
  } catch (error) {
    const list = document.querySelector("#versionedSkillList");
    if (list) list.innerHTML = `<div class="empty">${escapeHtml(error.message || "Could not load recorded skills.")}</div>`;
  }
}

function renderSkillLibrary() {
  const list = document.querySelector("#versionedSkillList");
  const count = document.querySelector("#versionedSkillCount");
  if (!list || !count) return;
  count.textContent = String(skillVersions.length);
  if (!skillVersions.length) {
    list.innerHTML = `<div class="empty">No recorded skill drafts yet. Choose “Watch me do it” and perform a browser job once.</div>`;
    return;
  }
  list.innerHTML = skillVersions.map((skill) => {
    const status = skill.status === "approved" ? "Approved" : skill.status === "archived" ? "Archived" : "Needs review";
    const action = skill.status === "draft" ? `<button class="button button-small button-primary tactile" type="button" data-approve-skill="${escapeAttr(skill.id)}" data-skill-version="${escapeAttr(skill.version)}">Approve this version</button>` : "";
    const finalCheck = skill.steps?.at(-1)?.expect?.visibleText;
    return `<article class="skill-card"><div><strong>${escapeHtml(skill.title)}</strong><p>${escapeHtml(skill.description)}</p><small>${escapeHtml(status)} · v${escapeHtml(skill.version)} · ${escapeHtml(String(skill.steps?.length || 0))} steps${finalCheck ? ` · checks “${escapeHtml(finalCheck)}”` : ""}</small></div><div class="skill-actions">${action}</div></article>`;
  }).join("");
}

async function onSkillAction(event) {
  const approve = event.target.closest("[data-approve-skill]");
  if (!approve) return;
  if (!confirm("Approve this exact skill version? BrowserCrew will still ask for any site or write permission required when it runs.")) return;
  busy(approve, true, "Approving…");
  const response = await portRequest(SKILLS_PORT, { type: "approve", skillId: approve.dataset.approveSkill, version: approve.dataset.skillVersion });
  if (!response.ok) announce(response.error?.message || "BrowserCrew could not approve this skill.");
  else announce("Skill version approved. Permissions are still checked when it runs.");
  await refreshSkillLibrary();
}

async function refreshScheduleReview() {
  const list = document.querySelector("#scheduleReviewList");
  try {
    const [capabilities, runs] = await Promise.all([
      portRequest(SCHEDULES_PORT, { type: "capabilities" }),
      portRequest(SCHEDULES_PORT, { type: "listRuns" })
    ]);
    if (!capabilities.ok) throw new Error(capabilities.error?.message || "Could not check scheduling availability.");
    if (!runs.ok) throw new Error(runs.error?.message || "Could not load scheduled job history.");
    scheduleCapabilities = { alarmsAvailable: capabilities.alarmsAvailable === true, schedulerBooted: capabilities.schedulerBooted === true };
    scheduleRuns = runs.runs || [];
    renderScheduleReview();
  } catch (error) {
    if (list) list.innerHTML = `<div class="empty">${escapeHtml(error.message || "Could not load missed scheduled jobs.")}</div>`;
  }
}

function renderScheduleReview() {
  const list = document.querySelector("#scheduleReviewList");
  const count = document.querySelector("#scheduleReviewCount");
  const status = document.querySelector("#scheduleCapabilityStatus");
  if (!list || !count || !status) return;

  if (scheduleCapabilities.schedulerBooted) status.textContent = "Scheduling is active. Every run still rechecks permissions, provider availability, and page freshness.";
  else status.textContent = "Scheduling is not active in this build. You can review stored missed-job choices, but BrowserCrew will not start a scheduled run yet.";

  const pending = scheduleRuns.filter((run) => run.status === "needs_review");
  count.textContent = String(pending.length);
  if (!pending.length) {
    list.innerHTML = `<div class="empty">No missed scheduled jobs need your choice.</div>`;
    return;
  }

  list.innerHTML = pending.map((run) => {
    const scheduled = formatScheduleTime(run.scheduledFor || run.firedAt);
    const lateMinutes = Math.max(0, Math.round(Number(run.latenessMs || 0) / 60_000));
    return `<article class="skill-card" data-schedule-review-card="${escapeAttr(run.id)}">
      <div><strong>${escapeHtml(run.scheduleId || "Scheduled job")}</strong><p>Missed ${escapeHtml(scheduled)}${lateMinutes ? ` · ${escapeHtml(String(lateMinutes))} min late` : ""}. BrowserCrew is waiting for your choice.</p><small>Nothing has been dispatched for this missed occurrence.</small></div>
      <div class="skill-actions">
        <button class="button button-small button-primary tactile" type="button" data-review-missed="${escapeAttr(run.id)}" data-review-decision="run_once">Run this missed job once</button>
        <button class="button button-small tactile" type="button" data-review-missed="${escapeAttr(run.id)}" data-review-decision="skip">Skip this missed job</button>
      </div>
    </article>`;
  }).join("");
}

async function onScheduleReviewAction(event) {
  const button = event.target.closest("[data-review-missed]");
  if (!button) return;
  const decision = button.dataset.reviewDecision;
  const runId = button.dataset.reviewMissed;
  if (decision === "run_once" && !confirm("Run this missed job once? BrowserCrew will recheck its permissions, provider, page, and safety limits before it can start.")) return;
  busy(button, true, decision === "skip" ? "Skipping…" : "Checking…");
  try {
    const response = await portRequest(SCHEDULES_PORT, { type: "reviewMissed", runId, decision });
    if (!response.ok) {
      announce(response.error?.message || "BrowserCrew could not apply that missed-job choice.");
    } else if (decision === "skip") {
      announce("Missed job skipped. Nothing was dispatched.");
    } else if (response.queued) {
      announce("One missed run is queued. BrowserCrew will recheck it after the current run finishes.");
    } else {
      announce("Missed job finished after a fresh safety check.");
    }
  } catch (error) {
    announce(error.message || "BrowserCrew could not apply that missed-job choice.");
  } finally {
    busy(button, false, decision === "skip" ? "Skip this missed job" : "Run this missed job once");
    await refreshScheduleReview();
  }
}

function formatScheduleTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "at its saved time";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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
