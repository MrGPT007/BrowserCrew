const FORM_PORT = "browsercrew-form-write";
const formState = { mode: "read", selectedTab: null, formTaskId: null, changeHash: null };
const q = (selector) => document.querySelector(selector);
const qa = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  bindFormUi();
  setFormMode("read", false);
});

function bindFormUi() {
  qa("[data-job-mode]").forEach((button) => button.addEventListener("click", () => setFormMode(button.dataset.jobMode)));
  q("#previewFormButton")?.addEventListener("click", previewFormChanges);
  q("#approveFormButton")?.addEventListener("click", approveFormChanges);
  q("#cancelFormPreviewButton")?.addEventListener("click", () => cancelFormPreview(false));
  q("#selectTabButton")?.addEventListener("click", captureSelectedPage, { capture: true });
}

async function captureSelectedPage() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
  if (response?.ok) formState.selectedTab = response.tab;
}

function setFormMode(mode, cancelPending = true) {
  const next = mode === "form" ? "form" : "read";
  if (cancelPending && next !== formState.mode && formState.formTaskId) cancelFormPreview(true);
  formState.mode = next;
  qa("[data-job-mode]").forEach((button) => {
    const selected = button.dataset.jobMode === next;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  const formMode = next === "form";
  setHidden("#readJobCard", formMode);
  setHidden("#readStartCard", formMode);
  setHidden("#formJobCard", !formMode);
  if (formMode) {
    setHidden("#runCard", true);
    setHidden("#resultCard", true);
  } else {
    setHidden("#formPreviewCard", true);
    setHidden("#formResultCard", true);
  }
}

async function previewFormChanges() {
  if (q("#pageStatus")?.dataset.state !== "ok" || !formState.selectedTab) {
    notify("Choose the page containing the form first.");
    return;
  }
  const details = q("#formDetailsInput")?.value.trim() || "";
  if (!details) { notify("Tell BrowserCrew exactly what information you want placed into the form."); return; }

  const settings = collectSettings();
  const secret = secretForRequest();
  if (!(await requestOriginPermission(formState.selectedTab.url))) { notify("This preview needs access to the selected page. Approve Chrome's permission prompt to continue."); return; }
  if (!(await requestOriginPermission(settings.baseUrl))) { notify("This preview needs your selected AI service. Open Connect AI, test it, and approve Chrome's permission prompt."); return; }

  if (formState.formTaskId) await cancelFormPreview(true);
  setButtonBusy(q("#previewFormButton"), true, "Preparing preview…");
  const response = await requestFormWorker({ type: "PREVIEW_FORM_TASK", payload: { details, tab: formState.selectedTab, settings, secret } });
  setButtonBusy(q("#previewFormButton"), false, "Preview form changes");
  if (!response?.ok) {
    notify(response?.error?.message || "BrowserCrew could not prepare a safe form preview.");
    requestHistoryRefresh();
    return;
  }
  formState.formTaskId = response.task.id;
  formState.changeHash = response.task.formPlan?.changeHash || null;
  renderFormPreview(response.task);
  requestHistoryRefresh();
}

function renderFormPreview(task) {
  const plan = task.formPlan;
  if (!plan?.changes?.length) return;
  setHidden("#formResultCard", true);
  setHidden("#formPreviewCard", false);
  q("#formChangeList").innerHTML = plan.changes.map((change) => {
    const before = change.before === "" ? "Empty" : change.before;
    const after = change.value === "" ? "Empty" : change.value;
    return `<article class="form-change"><strong>${escapeText(change.label)}</strong><div class="form-change-values"><div class="form-value"><small>Before</small>${escapeText(before)}</div><span class="form-arrow" aria-hidden="true">→</span><div class="form-value"><small>After approval</small>${escapeText(after)}</div></div></article>`;
  }).join("");
  q("#formPreviewCard")?.scrollIntoView({ block: "nearest" });
}

async function approveFormChanges() {
  if (!formState.formTaskId || !formState.changeHash) { notify("Prepare a fresh form preview before approving changes."); return; }
  setButtonBusy(q("#approveFormButton"), true, "Filling approved fields…");
  const response = await requestFormWorker({ type: "COMMIT_FORM_TASK", taskId: formState.formTaskId, approvedChangeHash: formState.changeHash });
  setButtonBusy(q("#approveFormButton"), false, "Approve and fill these fields");
  setHidden("#formPreviewCard", true);
  if (response?.ok) {
    renderFormResult(response.task);
    notify("Approved fields were filled and checked. The form was not submitted.");
  } else {
    notify(response?.error?.message || "BrowserCrew stopped before it could safely finish the form write.");
  }
  formState.formTaskId = null;
  formState.changeHash = null;
  requestHistoryRefresh();
}

async function cancelFormPreview(silent = false) {
  const taskId = formState.formTaskId;
  formState.formTaskId = null;
  formState.changeHash = null;
  setHidden("#formPreviewCard", true);
  if (taskId) {
    const response = await requestFormWorker({ type: "CANCEL_FORM_TASK", taskId });
    if (!silent && !response?.ok) { notify(response?.error?.message || "The preview could not be cancelled."); return; }
  }
  if (!silent) notify("Form preview cancelled. Nothing was changed.");
  requestHistoryRefresh();
}

function renderFormResult(task) {
  const result = task?.result;
  if (!result?.formChanges) return;
  setHidden("#formResultCard", false);
  q("#formResultGrid").innerHTML = result.formChanges.map((change) => `<dt>${escapeText(change.label)}</dt><dd>${escapeText(change.before || "Empty")} → ${escapeText(change.after || "Empty")}</dd>`).join("");
  const checks = result.evidence?.verification?.map((line) => `<li>${escapeText(line)}</li>`).join("") || "";
  const recovered = result.evidence?.recovered ? " BrowserCrew recovered this result after its worker restarted and verified the page instead of repeating the write." : "";
  q("#formEvidenceBox").innerHTML = `<strong>Checked on the page</strong><p>BrowserCrew verified the approved field values on <a href="${escapeAttribute(result.evidence.sourceUrl)}" target="_blank" rel="noreferrer">${escapeText(result.evidence.pageTitle)}</a>.</p><ul>${checks}</ul><p><strong>Not submitted:</strong> BrowserCrew did not press the form's submit or send button.${escapeText(recovered)}</p>`;
  q("#formResultCard")?.scrollIntoView({ block: "nearest" });
}

function collectSettings() {
  const selected = q(".provider-card.is-selected")?.dataset.provider || "openai";
  return { kind: selected, model: q("#modelInput")?.value.trim() || "", baseUrl: q("#serverInput")?.value.trim() || "" };
}

function secretForRequest() {
  const provider = q(".provider-card.is-selected")?.dataset.provider || "openai";
  if (provider !== "openai") return "";
  const typed = q("#apiKeyInput")?.value || "";
  return typed.length ? typed : undefined;
}

async function requestOriginPermission(urlText) {
  try {
    const url = new URL(urlText);
    const pattern = `${url.origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return chrome.permissions.request({ origins: [pattern] });
  } catch {
    notify("That address is not valid. Check it and try again.");
    return false;
  }
}

function requestFormWorker(message) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: FORM_PORT });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(value);
    };
    port.onMessage.addListener((response) => finish(response));
    port.onDisconnect.addListener(() => {
      if (!settled) finish({ ok: false, error: { code: "FORM_WORKER_DISCONNECTED", message: "BrowserCrew's form worker stopped before replying. Review the page before trying again." } });
    });
    port.postMessage(message);
  });
}

function requestHistoryRefresh() {
  q("#refreshHistoryButton")?.click();
  q("#refreshMemoryButton")?.click();
}

function setHidden(selector, hidden) { const element = q(selector); if (element) element.hidden = hidden; }
function setButtonBusy(button, busy, label) { if (!button) return; button.disabled = busy; button.textContent = label; }
function notify(message) {
  const toast = q("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}
function escapeText(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function escapeAttribute(value) { return escapeText(value); }
