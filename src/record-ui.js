const RECORD_PORT = "browsercrew-record-update";
const recordState = { selectedTab: null, taskId: null, changeHash: null };
const rq = (selector) => document.querySelector(selector);
const rqa = (selector) => [...document.querySelectorAll(selector)];

installRecordWorkspace();

document.addEventListener("DOMContentLoaded", () => {
  bindRecordUi();
});

function installRecordWorkspace() {
  const install = () => {
    const modeGrid = rq(".mode-choice-grid");
    if (modeGrid && !rq('[data-job-mode="record"]')) {
      modeGrid.insertAdjacentHTML("beforeend", `
        <button class="mode-choice tactile" type="button" data-job-mode="record" role="radio" aria-checked="false">
          <strong>Update a record</strong>
          <span>Preview one record change, approve it, save once, and verify the result.</span>
        </button>`);
      const helper = modeGrid.previousElementSibling;
      if (helper?.classList.contains("helper")) {
        helper.textContent = "Choose a read-only job, a reviewed form fill, a page comparison, a bounded directory export, or one reviewed record update. BrowserCrew explains what each job can change before it starts.";
      }
    }

    const anchor = rq("#readStartCard");
    if (anchor && !rq("#recordJobCard")) {
      anchor.insertAdjacentHTML("beforebegin", `
        <article class="card" id="recordJobCard" hidden>
          <div class="card-heading">
            <div><p class="step-label">2 · RECORD</p><h2>Tell BrowserCrew what should change</h2></div>
            <span class="badge badge-warning">Save approval required</span>
          </div>
          <label class="field-label" for="recordDetailsInput">What should I change on this record?</label>
          <textarea id="recordDetailsInput" rows="6" placeholder="Example:&#10;Status: Paused&#10;Owner: Priya Sharma&#10;Notes: Review pricing in October."></textarea>
          <p class="helper">Use clear <strong>Field: value</strong> lines. BrowserCrew only proposes values that appear in what you typed, and it shows every Before → After change before saving.</p>
          <div class="example-box">✋ Previewing changes nothing. Approval is tied to this exact record and these exact values.</div>
          <button class="button button-primary tactile full" id="previewRecordButton" type="button">Preview record update</button>
        </article>

        <article class="card form-preview-card" id="recordPreviewCard" hidden aria-live="polite">
          <div class="card-heading">
            <div><p class="step-label">3 · SAVE APPROVAL</p><h2>Review this record before Save</h2></div>
            <span class="badge badge-warning">Waiting for you</span>
          </div>
          <div class="selection-summary" id="recordIdentityBox"></div>
          <div class="form-change-list" id="recordChangeList"></div>
          <div class="warning-box">⚠️ Approving will press <strong>Save once</strong> on this exact record. This changes website data. If BrowserCrew loses contact around the save, it will inspect the record and will <strong>not</strong> automatically press Save again.</div>
          <div class="button-row">
            <button class="button tactile" id="cancelRecordPreviewButton" type="button">Cancel update</button>
            <button class="button button-primary tactile" id="approveRecordButton" type="button">Approve and save this record</button>
          </div>
        </article>

        <article class="card result-card" id="recordResultCard" hidden aria-live="polite">
          <div class="card-heading">
            <div><p class="step-label">RECORD RESULT</p><h2>Saved record was checked</h2></div>
            <span class="badge badge-safe" id="recordResultBadge">Verified</span>
          </div>
          <dl class="result-grid" id="recordResultGrid"></dl>
          <div class="evidence-box" id="recordEvidenceBox"></div>
        </article>`);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

function bindRecordUi() {
  rqa("[data-job-mode]").forEach((button) => {
    button.addEventListener("click", () => queueMicrotask(() => syncRecordMode(button.dataset.jobMode)));
  });
  rq("#selectTabButton")?.addEventListener("click", captureRecordPage, { capture: true });
  rq("#previewRecordButton")?.addEventListener("click", previewRecordUpdate);
  rq("#approveRecordButton")?.addEventListener("click", approveRecordUpdate);
  rq("#cancelRecordPreviewButton")?.addEventListener("click", () => cancelRecordPreview(false));
}

function syncRecordMode(mode) {
  const active = mode === "record";
  setRecordHidden("#recordJobCard", !active);
  if (!active) {
    setRecordHidden("#recordPreviewCard", true);
    setRecordHidden("#recordResultCard", true);
    if (recordState.taskId) cancelRecordPreview(true).catch(() => {});
    return;
  }

  rqa("[data-job-mode]").forEach((button) => {
    const selected = button.dataset.jobMode === "record";
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });

  for (const selector of [
    "#readJobCard", "#readStartCard", "#formJobCard", "#formPreviewCard", "#formResultCard",
    "#compareJobCard", "#compareRunCard", "#compareResultCard", "#directoryJobCard", "#directoryRunCard",
    "#directoryResultCard", "#runCard", "#resultCard"
  ]) setRecordHidden(selector, true);

  const intro = rq("#view-workspace .view-intro");
  if (intro) intro.textContent = "Choose one supported record page, describe exact Field: value changes, then approve one Save action after reviewing the Before → After preview.";
}

async function captureRecordPage() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
  if (response?.ok) recordState.selectedTab = response.tab;
}

async function previewRecordUpdate() {
  if (rq("#pageStatus")?.dataset.state !== "ok" || !recordState.selectedTab) {
    notifyRecord("Choose the exact record page first.");
    return;
  }
  const details = rq("#recordDetailsInput")?.value.trim() || "";
  if (!details) {
    notifyRecord("Tell BrowserCrew exactly what should change. Use clear Field: value lines.");
    return;
  }

  const settings = collectRecordSettings();
  if (!(await requestRecordOrigin(recordState.selectedTab.url))) {
    notifyRecord("Chrome access is needed for this record page. Approve the permission prompt to continue.");
    return;
  }
  if (!(await requestRecordOrigin(settings.baseUrl))) {
    notifyRecord("This preview needs your selected AI service. Open Connect AI, test it, and approve Chrome's permission prompt.");
    return;
  }

  if (recordState.taskId) await cancelRecordPreview(true);
  setRecordBusy(rq("#previewRecordButton"), true, "Preparing record preview…");
  const response = await requestRecordWorker({
    type: "PREVIEW_RECORD_TASK",
    payload: {
      details,
      tab: recordState.selectedTab,
      settings,
      secret: secretForRecordRequest()
    }
  });
  setRecordBusy(rq("#previewRecordButton"), false, "Preview record update");

  if (!response?.ok) {
    notifyRecord(response?.error?.message || "BrowserCrew could not prepare a safe record preview.");
    refreshRecordHistory();
    return;
  }

  recordState.taskId = response.task.id;
  recordState.changeHash = response.task.recordPlan?.changeHash || null;
  renderRecordPreview(response.task);
  refreshRecordHistory();
}

function renderRecordPreview(task) {
  const plan = task?.recordPlan;
  if (!plan?.changes?.length) return;
  setRecordHidden("#recordResultCard", true);
  setRecordHidden("#recordPreviewCard", false);
  rq("#recordIdentityBox").innerHTML = `<strong>Record ${escapeRecordText(plan.recordId)}</strong><span>${escapeRecordText(plan.pageTitle)}</span>`;
  rq("#recordChangeList").innerHTML = plan.changes.map((change) => {
    const before = change.before === "" ? "Empty" : change.before;
    const after = change.afterLabel || change.value || "Empty";
    return `<article class="form-change"><strong>${escapeRecordText(change.label)}</strong><div class="form-change-values"><div class="form-value"><small>Before</small>${escapeRecordText(before)}</div><span class="form-arrow" aria-hidden="true">→</span><div class="form-value"><small>After approval</small>${escapeRecordText(after)}</div></div></article>`;
  }).join("");
  rq("#recordPreviewCard")?.scrollIntoView({ block: "nearest" });
}

async function approveRecordUpdate() {
  if (!recordState.taskId || !recordState.changeHash) {
    notifyRecord("Prepare a fresh record preview before approving Save.");
    return;
  }
  setRecordBusy(rq("#approveRecordButton"), true, "Saving approved record…");
  const response = await requestRecordWorker({
    type: "COMMIT_RECORD_TASK",
    taskId: recordState.taskId,
    approvedChangeHash: recordState.changeHash
  });
  setRecordBusy(rq("#approveRecordButton"), false, "Approve and save this record");
  setRecordHidden("#recordPreviewCard", true);

  if (response?.task?.result) renderRecordResult(response.task);
  if (response?.ok) {
    notifyRecord("The approved record was saved once and verified.");
  } else {
    notifyRecord(response?.task?.error?.message || response?.error?.message || "BrowserCrew could not prove the final saved state. It will not press Save again automatically.");
  }
  recordState.taskId = null;
  recordState.changeHash = null;
  refreshRecordHistory();
}

async function cancelRecordPreview(silent = false) {
  const taskId = recordState.taskId;
  recordState.taskId = null;
  recordState.changeHash = null;
  setRecordHidden("#recordPreviewCard", true);
  if (taskId) {
    const response = await requestRecordWorker({ type: "CANCEL_RECORD_TASK", taskId });
    if (!silent && !response?.ok) {
      notifyRecord(response?.error?.message || "The record preview could not be cancelled.");
      return;
    }
  }
  if (!silent) notifyRecord("Record update cancelled. Save was not pressed.");
  refreshRecordHistory();
}

function renderRecordResult(task) {
  const result = task?.result;
  if (!result?.recordChanges?.length) return;
  setRecordHidden("#recordResultCard", false);
  const verified = task.status === "completed";
  rq("#recordResultBadge").textContent = verified ? "Verified" : "Review needed";
  rq("#recordResultBadge").classList.toggle("badge-safe", verified);
  rq("#recordResultBadge").classList.toggle("badge-warning", !verified);
  rq("#recordResultGrid").innerHTML = result.recordChanges.map((change) => {
    const after = change.afterLabel || change.after || "Empty";
    return `<dt>${escapeRecordText(change.label)}</dt><dd>${escapeRecordText(change.before || "Empty")} → ${escapeRecordText(after)}</dd>`;
  }).join("");

  const evidence = result.evidence || {};
  const checks = Array.isArray(evidence.verification) ? evidence.verification.map((line) => `<li>${escapeRecordText(line)}</li>`).join("") : "";
  const receiptText = evidence.saveReceipt?.after?.text || "No independent save receipt was available.";
  const recovered = evidence.recovered ? " BrowserCrew recovered this result after its worker restarted and verified the record instead of pressing Save again." : "";
  rq("#recordEvidenceBox").innerHTML = `<strong>Record ${escapeRecordText(result.recordId)}</strong><p>BrowserCrew checked the selected record at <a href="${escapeRecordAttribute(evidence.sourceUrl || "")}" target="_blank" rel="noreferrer">${escapeRecordText(evidence.pageTitle || "record page")}</a>.</p><ul>${checks}</ul><p><strong>Save evidence:</strong> ${escapeRecordText(receiptText)}.${escapeRecordText(recovered)}</p>`;
  rq("#recordResultCard")?.scrollIntoView({ block: "nearest" });
}

function collectRecordSettings() {
  const selected = rq(".provider-card.is-selected")?.dataset.provider || "openai";
  return {
    kind: selected,
    model: rq("#modelInput")?.value.trim() || "",
    baseUrl: rq("#serverInput")?.value.trim() || ""
  };
}

function secretForRecordRequest() {
  const provider = rq(".provider-card.is-selected")?.dataset.provider || "openai";
  if (provider !== "openai") return "";
  const typed = rq("#apiKeyInput")?.value || "";
  return typed.length ? typed : undefined;
}

async function requestRecordOrigin(urlText) {
  try {
    const url = new URL(urlText);
    const pattern = `${url.origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return chrome.permissions.request({ origins: [pattern] });
  } catch {
    notifyRecord("That address is not valid. Check it and try again.");
    return false;
  }
}

function requestRecordWorker(message) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: RECORD_PORT });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(value);
    };
    port.onMessage.addListener((response) => finish(response));
    port.onDisconnect.addListener(() => {
      if (!settled) finish({ ok: false, error: { code: "RECORD_WORKER_DISCONNECTED", message: "BrowserCrew's record worker stopped before replying. Review the record before trying again." } });
    });
    port.postMessage(message);
  });
}

function refreshRecordHistory() {
  rq("#refreshHistoryButton")?.click();
  rq("#refreshMemoryButton")?.click();
}

function setRecordHidden(selector, hidden) {
  const element = rq(selector);
  if (element) element.hidden = hidden;
}

function setRecordBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function notifyRecord(message) {
  const toast = rq("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyRecord.timer);
  notifyRecord.timer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function escapeRecordText(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function escapeRecordAttribute(value) { return escapeRecordText(value); }
