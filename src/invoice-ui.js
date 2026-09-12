const INVOICE_PORT = "browsercrew-invoice-download";
const invoiceState = {
  selectedTab: null,
  portal: null,
  port: null,
  taskId: null,
  result: null
};
const iq = (selector) => document.querySelector(selector);
const iqa = (selector) => [...document.querySelectorAll(selector)];

installInvoiceWorkspace();

document.addEventListener("DOMContentLoaded", () => {
  bindInvoiceUi();
});

function installInvoiceWorkspace() {
  const install = () => {
    const modeGrid = iq(".mode-choice-grid");
    if (modeGrid && !iq('[data-job-mode="invoice"]')) {
      modeGrid.insertAdjacentHTML("beforeend", `
        <button class="mode-choice tactile" type="button" data-job-mode="invoice" role="radio" aria-checked="false">
          <strong>Collect invoices</strong>
          <span>Choose exact invoice records, download their PDFs, and keep a checked manifest.</span>
        </button>`);
      const helper = modeGrid.previousElementSibling;
      if (helper?.classList.contains("helper")) {
        helper.textContent = "Choose a read-only job, reviewed write, bounded export, or selected invoice collection. BrowserCrew explains exactly what each job can read, change, or save before it starts.";
      }
    }

    const anchor = iq("#readStartCard");
    if (anchor && !iq("#invoiceJobCard")) {
      anchor.insertAdjacentHTML("beforebegin", `
        <article class="card" id="invoiceJobCard" hidden>
          <div class="card-heading">
            <div><p class="step-label">2 · INVOICES</p><h2>Choose the invoices to save</h2></div>
            <span class="badge">PDF files</span>
          </div>
          <p class="helper">Open the account's invoice page first. BrowserCrew will show the invoice records it can identify on that exact page. You choose which ones to download.</p>
          <button class="button tactile full" id="loadInvoicesButton" type="button">Show invoices from this page</button>
          <div class="selection-summary" id="invoiceAccountBox" hidden></div>
          <div class="invoice-choice-list" id="invoiceChoiceList" hidden></div>
          <div class="selection-summary" id="invoiceSelectionSummary" hidden></div>
          <div class="warning-box" id="invoiceDownloadWarning" hidden>⬇️ BrowserCrew will save only the invoices you select. PDFs go through Chrome's normal Downloads system under <strong>BrowserCrew/Invoices</strong>. This does not edit the account, pay an invoice, or contact anyone.</div>
          <button class="button button-primary tactile full" id="runInvoiceButton" type="button" hidden disabled>Download selected invoices</button>
        </article>

        <article class="card run-card" id="invoiceRunCard" hidden aria-live="polite">
          <div class="run-head">
            <div><p class="step-label">CURRENT INVOICE JOB</p><h2>Saving selected invoices…</h2></div>
            <span class="badge" id="invoiceRunBadge">Running</span>
          </div>
          <p class="helper" id="invoiceProgressText">Starting invoice collection…</p>
          <button class="button button-danger tactile full" id="stopInvoiceButton" type="button">Stop invoice collection</button>
        </article>

        <article class="card result-card" id="invoiceResultCard" hidden aria-live="polite">
          <div class="card-heading">
            <div><p class="step-label">INVOICE RESULT</p><h2>Downloaded files were checked</h2></div>
            <span class="badge badge-safe" id="invoiceResultBadge">Verified</span>
          </div>
          <div class="evidence-box" id="invoiceSummaryBox"></div>
          <div class="evidence-box" id="invoiceManifestWrap"></div>
          <button class="button tactile full" id="downloadInvoiceManifestButton" type="button">Download manifest JSON</button>
          <p class="helper">The manifest links every verified file to its invoice record, account, portal page, and exact source URL. A filename alone is never treated as proof of a successful download.</p>
        </article>`);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

function bindInvoiceUi() {
  iqa("[data-job-mode]").forEach((button) => {
    button.addEventListener("click", () => queueMicrotask(() => syncInvoiceMode(button.dataset.jobMode)));
  });
  iq("#selectTabButton")?.addEventListener("click", captureInvoicePortalPage, { capture: true });
  iq("#loadInvoicesButton")?.addEventListener("click", loadInvoicesFromPage);
  iq("#invoiceChoiceList")?.addEventListener("change", updateInvoiceSelection);
  iq("#runInvoiceButton")?.addEventListener("click", runInvoiceCollection);
  iq("#stopInvoiceButton")?.addEventListener("click", stopInvoiceCollection);
  iq("#downloadInvoiceManifestButton")?.addEventListener("click", downloadInvoiceManifest);
}

function syncInvoiceMode(mode) {
  const active = mode === "invoice";
  setInvoiceHidden("#invoiceJobCard", !active);
  if (!active) {
    setInvoiceHidden("#invoiceRunCard", true);
    setInvoiceHidden("#invoiceResultCard", true);
    return;
  }

  iqa("[data-job-mode]").forEach((button) => {
    const selected = button.dataset.jobMode === "invoice";
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });

  for (const selector of [
    "#readJobCard", "#readStartCard", "#formJobCard", "#formPreviewCard", "#formResultCard",
    "#compareJobCard", "#compareRunCard", "#compareResultCard", "#directoryJobCard", "#directoryRunCard",
    "#directoryResultCard", "#recordJobCard", "#recordPreviewCard", "#recordResultCard", "#runCard", "#resultCard"
  ]) setInvoiceHidden(selector, true);

  const intro = iq("#view-workspace .view-intro");
  if (intro) intro.textContent = "Open the account's invoice page, choose the exact invoices you want, and BrowserCrew will save only those PDFs and verify each Chrome download before building a manifest.";
}

async function captureInvoicePortalPage() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
  if (response?.ok) {
    invoiceState.selectedTab = response.tab;
    invoiceState.portal = null;
    clearInvoiceChoices();
  }
}

async function loadInvoicesFromPage() {
  if (iq("#pageStatus")?.dataset.state !== "ok" || !invoiceState.selectedTab) {
    notifyInvoice("Choose the account's invoice page first.");
    return;
  }
  if (!(await requestInvoiceOrigin(invoiceState.selectedTab.url))) {
    notifyInvoice("Chrome access is needed for this invoice portal. Approve the permission prompt to continue.");
    return;
  }

  setInvoiceBusy(iq("#loadInvoicesButton"), true, "Reading invoice records…");
  const response = await requestInvoiceOnce({ type: "LIST_INVOICES", tab: invoiceState.selectedTab });
  setInvoiceBusy(iq("#loadInvoicesButton"), false, "Show invoices from this page");
  if (!response?.ok || !response.portal) {
    notifyInvoice(response?.error?.message || "BrowserCrew could not identify supported invoice records on this page.");
    return;
  }

  invoiceState.portal = response.portal;
  renderInvoiceChoices(response.portal);
}

function renderInvoiceChoices(portal) {
  const account = iq("#invoiceAccountBox");
  account.hidden = false;
  account.innerHTML = `<strong>${escapeInvoiceText(portal.accountLabel || portal.accountId)}</strong><span>Account ${escapeInvoiceText(portal.accountId)} · ${portal.invoices.length} invoice${portal.invoices.length === 1 ? "" : "s"} available</span>`;

  const list = iq("#invoiceChoiceList");
  list.hidden = false;
  if (!portal.invoices.length) {
    list.innerHTML = `<p class="helper">No supported PDF invoice records were found on this page.</p>`;
  } else {
    list.innerHTML = portal.invoices.map((invoice) => `
      <label class="invoice-choice">
        <input type="checkbox" value="${escapeInvoiceAttribute(invoice.id)}" data-invoice-id="${escapeInvoiceAttribute(invoice.id)}" />
        <span><strong>${escapeInvoiceText(invoice.label || invoice.id)}</strong><small>${escapeInvoiceText(invoice.date || "Date not shown")} · ${escapeInvoiceText(invoice.amount || "Amount not shown")}</small></span>
      </label>`).join("");
  }
  iq("#invoiceDownloadWarning").hidden = portal.invoices.length === 0;
  iq("#runInvoiceButton").hidden = portal.invoices.length === 0;
  updateInvoiceSelection();
}

function updateInvoiceSelection() {
  const selected = selectedInvoiceIds();
  const summary = iq("#invoiceSelectionSummary");
  if (selected.length) {
    summary.hidden = false;
    summary.innerHTML = `<strong>${selected.length} selected</strong><span>BrowserCrew will request exactly ${selected.length} PDF download${selected.length === 1 ? "" : "s"}.</span>`;
  } else {
    summary.hidden = true;
    summary.textContent = "";
  }
  const run = iq("#runInvoiceButton");
  if (run) run.disabled = selected.length === 0 || selected.length > 20;
}

async function runInvoiceCollection() {
  if (!invoiceState.selectedTab || !invoiceState.portal) {
    notifyInvoice("Show the invoice records from this page before downloading.");
    return;
  }
  const invoiceIds = selectedInvoiceIds();
  if (!invoiceIds.length) {
    notifyInvoice("Choose at least one invoice to download.");
    return;
  }
  if (invoiceIds.length > 20) {
    notifyInvoice("Choose no more than 20 invoices in one job.");
    return;
  }
  if (!(await requestInvoiceOrigin(invoiceState.selectedTab.url))) {
    notifyInvoice("Chrome access is needed for this invoice portal before downloads can start.");
    return;
  }

  closeInvoicePort();
  invoiceState.result = null;
  setInvoiceHidden("#invoiceResultCard", true);
  setInvoiceHidden("#invoiceRunCard", false);
  setInvoiceBusy(iq("#runInvoiceButton"), true, "Invoice collection is running…");
  iq("#invoiceRunBadge").textContent = "Running";
  iq("#invoiceProgressText").textContent = `Starting ${invoiceIds.length} selected invoice download${invoiceIds.length === 1 ? "" : "s"}…`;

  const port = chrome.runtime.connect({ name: INVOICE_PORT });
  invoiceState.port = port;
  invoiceState.taskId = null;

  port.onMessage.addListener((message) => {
    if (message?.type === "INVOICE_PROGRESS") {
      if (message.taskId) invoiceState.taskId = message.taskId;
      iq("#invoiceProgressText").textContent = message.message || "Working…";
      return;
    }
    if (message?.type === "INVOICE_CANCELLED") {
      iq("#invoiceRunBadge").textContent = "Stopping";
      return;
    }
    if (message?.type === "INVOICE_DONE") finishInvoiceCollection(message);
    if (message?.type === "INVOICE_ERROR") finishInvoiceCollection(message);
  });

  port.onDisconnect.addListener(() => {
    if (invoiceState.port === port) {
      invoiceState.port = null;
      if (!iq("#invoiceRunCard")?.hidden) {
        iq("#invoiceRunBadge").textContent = "Interrupted";
        iq("#invoiceProgressText").textContent = "The invoice worker stopped before replying. Check History before starting another collection so you do not create duplicate files.";
        setInvoiceBusy(iq("#runInvoiceButton"), false, "Download selected invoices");
      }
    }
  });

  port.postMessage({ type: "RUN_INVOICE_TASK", payload: { tab: invoiceState.selectedTab, invoiceIds } });
}

function finishInvoiceCollection(message) {
  setInvoiceBusy(iq("#runInvoiceButton"), false, "Download selected invoices");
  setInvoiceHidden("#invoiceRunCard", true);
  invoiceState.taskId = null;
  closeInvoicePort();

  if (message?.task?.result) {
    invoiceState.result = message.task.result;
    renderInvoiceResult(message.task);
  }

  if (message?.task?.status === "cancelled") {
    notifyInvoice("Invoice collection stopped. BrowserCrew will not start another invoice download for this job.");
  } else if (message?.ok) {
    notifyInvoice("Selected invoices were downloaded and verified. The manifest is ready.");
  } else {
    notifyInvoice(message?.task?.error?.message || message?.error?.message || "BrowserCrew could not verify every selected invoice download.");
  }
  refreshInvoiceHistory();
}

async function stopInvoiceCollection() {
  if (!invoiceState.port || !invoiceState.taskId) {
    notifyInvoice("BrowserCrew has not started an invoice download yet.");
    return;
  }
  iq("#invoiceRunBadge").textContent = "Stopping";
  iq("#invoiceProgressText").textContent = "Stopping this collection before another invoice is started…";
  invoiceState.port.postMessage({ type: "CANCEL_INVOICE_TASK", taskId: invoiceState.taskId });
}

function renderInvoiceResult(task) {
  const result = task?.result;
  if (!result) return;
  setInvoiceHidden("#invoiceResultCard", false);
  const allVerified = result.verifiedCount === result.selectedCount && result.selectedCount > 0;
  const badge = iq("#invoiceResultBadge");
  badge.textContent = allVerified ? "Verified" : "Review needed";
  badge.classList.toggle("badge-safe", allVerified);
  badge.classList.toggle("badge-warning", !allVerified);

  iq("#invoiceSummaryBox").innerHTML = `<strong>${escapeInvoiceText(result.account?.label || result.account?.id || "Invoice account")}</strong><p>${result.verifiedCount} of ${result.selectedCount} selected invoice${result.selectedCount === 1 ? "" : "s"} verified as completed Chrome downloads.${result.recovered ? " This result was reconciled after BrowserCrew restarted without starting duplicate downloads." : ""}</p>`;

  const rows = (result.entries || []).map((entry) => `<tr><td>${escapeInvoiceText(entry.invoiceId)}</td><td>${escapeInvoiceText(entry.invoiceDate || "—")}</td><td>${escapeInvoiceText(entry.amount || "—")}</td><td>${entry.verified ? "Verified" : escapeInvoiceText(entry.state || "Unknown")}</td><td>${escapeInvoiceText(entry.bytesReceived ? `${entry.bytesReceived} bytes` : "—")}</td></tr>`).join("");
  iq("#invoiceManifestWrap").innerHTML = `<strong>Download manifest</strong><div class="table-scroll"><table class="compare-table"><thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Download</th><th>Received</th></tr></thead><tbody>${rows}</tbody></table></div><p class="helper">Checked with Chrome download state, exact source URL, file existence, and received bytes.</p>`;
  iq("#invoiceResultCard")?.scrollIntoView({ block: "nearest" });
}

function downloadInvoiceManifest() {
  if (!invoiceState.result) {
    notifyInvoice("Finish an invoice collection before downloading its manifest.");
    return;
  }
  const result = invoiceState.result;
  const manifest = {
    kind: "browsercrew.invoice_manifest",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: result.account,
    portalUrl: result.portalUrl,
    selectedCount: result.selectedCount,
    verifiedCount: result.verifiedCount,
    recovered: Boolean(result.recovered),
    verificationMethod: result.verificationMethod,
    entries: Array.isArray(result.entries) ? result.entries.map((entry) => ({ ...entry })) : []
  };
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `browsercrew-invoices-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function selectedInvoiceIds() {
  return iqa('#invoiceChoiceList input[data-invoice-id]:checked').map((input) => input.dataset.invoiceId).filter(Boolean);
}

function clearInvoiceChoices() {
  for (const selector of ["#invoiceAccountBox", "#invoiceChoiceList", "#invoiceSelectionSummary", "#invoiceDownloadWarning", "#runInvoiceButton", "#invoiceResultCard"]) {
    setInvoiceHidden(selector, true);
  }
  const list = iq("#invoiceChoiceList");
  if (list) list.innerHTML = "";
}

async function requestInvoiceOrigin(urlText) {
  try {
    const url = new URL(urlText);
    const pattern = `${url.origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return chrome.permissions.request({ origins: [pattern] });
  } catch {
    notifyInvoice("That page address is not valid. Choose the invoice portal again.");
    return false;
  }
}

function requestInvoiceOnce(message) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: INVOICE_PORT });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(value);
    };
    port.onMessage.addListener((response) => finish(response));
    port.onDisconnect.addListener(() => {
      if (!settled) finish({ ok: false, error: { code: "INVOICE_WORKER_DISCONNECTED", message: "BrowserCrew's invoice worker stopped before replying." } });
    });
    port.postMessage(message);
  });
}

function closeInvoicePort() {
  if (!invoiceState.port) return;
  try { invoiceState.port.disconnect(); } catch {}
  invoiceState.port = null;
}

function refreshInvoiceHistory() {
  iq("#refreshHistoryButton")?.click();
  iq("#refreshMemoryButton")?.click();
}

function setInvoiceHidden(selector, hidden) {
  const element = iq(selector);
  if (element) element.hidden = hidden;
}

function setInvoiceBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function notifyInvoice(message) {
  const toast = iq("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyInvoice.timer);
  notifyInvoice.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function escapeInvoiceText(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function escapeInvoiceAttribute(value) { return escapeInvoiceText(value); }