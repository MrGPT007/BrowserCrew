const STORAGE_KEY = "browsercrew.tasks.v1";
const INVOICE_PORT = "browsercrew-invoice-download";
const MAX_INVOICES = 20;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const invoiceControllers = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== INVOICE_PORT) return;
  port.onMessage.addListener((message) => {
    handleInvoiceMessage(message, port).catch((error) => {
      try { port.postMessage({ type: "INVOICE_ERROR", ok: false, error: serializeInvoiceError(error) }); } catch {}
    });
  });
});

reconcilePendingInvoiceTasks().catch(() => {});

async function handleInvoiceMessage(message, port) {
  switch (message?.type) {
    case "LIST_INVOICES": {
      const tab = message.tab;
      validateInvoiceTab(tab);
      await ensureInvoiceSitePermission(tab.url);
      const portal = await observeInvoicePortal(tab.id, tab.url);
      port.postMessage({ type: "INVOICE_LIST", ok: true, portal });
      return;
    }
    case "RUN_INVOICE_TASK":
      await runInvoiceTask(message.payload, port);
      return;
    case "CANCEL_INVOICE_TASK":
      await cancelInvoiceTask(message.taskId);
      try { port.postMessage({ type: "INVOICE_CANCELLED", ok: true, taskId: message.taskId }); } catch {}
      return;
    default:
      port.postMessage({ type: "INVOICE_ERROR", ok: false, error: { code: "UNKNOWN_INVOICE_MESSAGE", message: "BrowserCrew received an unknown invoice request." } });
  }
}

async function runInvoiceTask(payload, port) {
  validateInvoicePayload(payload);
  await ensureInvoiceSitePermission(payload.tab.url);
  const observation = await observeInvoicePortal(payload.tab.id, payload.tab.url);
  const selectedIds = [...new Set(payload.invoiceIds.map((value) => String(value)))];
  const selected = selectedIds.map((id) => observation.invoices.find((invoice) => invoice.id === id)).filter(Boolean);
  if (selected.length !== selectedIds.length) throw invoiceError("INVOICE_SELECTION_CHANGED", "One of the selected invoices is no longer listed on this portal page. Refresh the invoice list before downloading.");
  if (selected.length > MAX_INVOICES) throw invoiceError("TOO_MANY_INVOICES", `Choose no more than ${MAX_INVOICES} invoices in one job.`);

  const task = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    kind: "invoice_collection",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: `Collect ${selected.length} selected invoice${selected.length === 1 ? "" : "s"} from ${observation.accountLabel || observation.accountId}`,
    status: "running",
    selectedResource: payload.tab,
    checkpoint: "invoice_selection_locked",
    account: { id: observation.accountId, label: observation.accountLabel },
    portalUrl: observation.url,
    selectedInvoices: selected.map((invoice) => ({ ...invoice })),
    manifest: [],
    journal: [],
    result: null,
    error: null
  };
  await upsertInvoiceTask(task);
  const controller = { cancelled: false, currentDownloadId: null };
  invoiceControllers.set(task.id, controller);
  postInvoiceProgress(port, task.id, `Starting ${selected.length} selected invoice download${selected.length === 1 ? "" : "s"}…`);

  try {
    for (let index = 0; index < selected.length; index += 1) {
      if (controller.cancelled) break;
      const invoice = selected[index];
      postInvoiceProgress(port, task.id, `Downloading ${invoice.id} · ${index + 1} of ${selected.length}`);
      const manifestEntry = await downloadInvoice(task, invoice, controller);
      await mutateInvoiceTask(task.id, (current) => {
        const existing = current.manifest.findIndex((entry) => entry.invoiceId === invoice.id);
        if (existing >= 0) current.manifest[existing] = manifestEntry;
        else current.manifest.push(manifestEntry);
        current.checkpoint = `invoice_${index + 1}_verified`;
      });
    }

    const latest = await getInvoiceTask(task.id);
    if (controller.cancelled || latest?.status === "cancelled") {
      await mutateInvoiceTask(task.id, (current) => {
        current.status = "cancelled";
        current.checkpoint = "invoice_collection_cancelled";
        current.result = buildInvoiceResult(current, false);
      });
      try { port.postMessage({ type: "INVOICE_DONE", ok: false, task: await getInvoiceTask(task.id) }); } catch {}
      return;
    }

    const verifiedCount = latest.manifest.filter((entry) => entry.verified).length;
    const complete = verifiedCount === selected.length;
    await mutateInvoiceTask(task.id, (current) => {
      current.status = complete ? "completed" : "partially_completed";
      current.checkpoint = complete ? "completed" : "invoice_collection_partial";
      current.result = buildInvoiceResult(current, false);
      current.error = complete ? null : {
        code: "INVOICE_DOWNLOAD_PARTIAL",
        message: "Some selected invoices could not be verified as completed downloads. BrowserCrew did not count filenames alone as success."
      };
    });
    const finished = await getInvoiceTask(task.id);
    try { port.postMessage({ type: "INVOICE_DONE", ok: complete, task: finished, error: finished.error || undefined }); } catch {}
  } catch (error) {
    const latest = await getInvoiceTask(task.id);
    if (controller.cancelled || latest?.status === "cancelled") {
      await mutateInvoiceTask(task.id, (current) => {
        current.status = "cancelled";
        current.checkpoint = "invoice_collection_cancelled";
        current.result = buildInvoiceResult(current, false);
      });
      try { port.postMessage({ type: "INVOICE_DONE", ok: false, task: await getInvoiceTask(task.id) }); } catch {}
    } else {
      const serialized = serializeInvoiceError(error);
      await mutateInvoiceTask(task.id, (current) => {
        current.status = current.manifest.some((entry) => entry.verified) ? "partially_completed" : "failed";
        current.checkpoint = "invoice_collection_failed";
        current.error = serialized;
        current.result = buildInvoiceResult(current, false);
      });
      try { port.postMessage({ type: "INVOICE_DONE", ok: false, task: await getInvoiceTask(task.id), error: serialized }); } catch {}
    }
  } finally {
    invoiceControllers.delete(task.id);
  }
}

async function downloadInvoice(task, invoice, controller) {
  validateInvoiceDownload(invoice, task.portalUrl);
  const intentAt = new Date().toISOString();
  const filename = `BrowserCrew/Invoices/${sanitizeInvoiceFilename(invoice.id)}.pdf`;
  await journalInvoice(task.id, "invoice_download.intent", {
    invoiceId: invoice.id,
    url: invoice.downloadUrl,
    filename,
    intentAt
  });

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: invoice.downloadUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch (error) {
    throw invoiceError("DOWNLOAD_DISPATCH_FAILED", `Chrome could not start the download for ${invoice.id}. ${error?.message || ""}`.trim());
  }

  controller.currentDownloadId = downloadId;
  await journalInvoice(task.id, "invoice_download.dispatched", { invoiceId: invoice.id, downloadId, intentAt });
  await mutateInvoiceTask(task.id, (current) => {
    const entry = current.manifest.find((item) => item.invoiceId === invoice.id);
    const partial = makeManifestEntry(task, invoice, { downloadId, intentAt, verified: false, state: "in_progress" });
    if (entry) Object.assign(entry, partial); else current.manifest.push(partial);
  });

  const item = await waitForInvoiceDownload(downloadId, controller);
  controller.currentDownloadId = null;
  if (controller.cancelled) throw invoiceError("INVOICE_CANCELLED", "Invoice collection was stopped.");
  return verifyInvoiceDownload(task, invoice, item, intentAt);
}

async function cancelInvoiceTask(taskId) {
  const task = await getInvoiceTask(taskId);
  if (!task || task.kind !== "invoice_collection") throw invoiceError("INVOICE_TASK_NOT_FOUND", "This invoice collection job could not be found.");
  const controller = invoiceControllers.get(taskId);
  if (controller) {
    controller.cancelled = true;
    if (Number.isInteger(controller.currentDownloadId)) {
      try { await chrome.downloads.cancel(controller.currentDownloadId); } catch {}
    }
  }
  await mutateInvoiceTask(taskId, (current) => {
    current.status = "cancelled";
    current.checkpoint = "invoice_cancel_recorded";
    current.error = null;
  });
}

async function observeInvoicePortal(tabId, expectedUrl) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { throw invoiceError("PORTAL_TAB_GONE", "The selected invoice portal tab is no longer open."); }
  if (!tab?.url || tab.url !== expectedUrl) throw invoiceError("PAGE_CHANGED", "The selected tab changed. BrowserCrew will not collect invoices from a different page.");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clean = (value, max = 300) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
      const root = document.querySelector("[data-browsercrew-invoice-portal]");
      if (!root) return { ok: false, code: "UNSUPPORTED_INVOICE_PORTAL" };
      const accountId = clean(root.getAttribute("data-account-id"));
      const accountLabel = clean(root.getAttribute("data-account-label") || accountId);
      if (!accountId) return { ok: false, code: "MISSING_ACCOUNT_ID" };
      const invoices = [...root.querySelectorAll("[data-browsercrew-invoice]")].slice(0, 100).map((row) => {
        const id = clean(row.getAttribute("data-invoice-id"));
        const date = clean(row.getAttribute("data-invoice-date"));
        const amount = clean(row.getAttribute("data-invoice-amount"));
        const link = row.querySelector("[data-browsercrew-invoice-download]");
        const href = link?.href || "";
        return { id, date, amount, downloadUrl: href, label: clean(row.getAttribute("data-invoice-label") || id) };
      }).filter((invoice) => invoice.id && invoice.downloadUrl);
      return { ok: true, title: document.title, url: location.href, accountId, accountLabel, invoices };
    }
  });

  if (!result?.ok) {
    if (result?.code === "UNSUPPORTED_INVOICE_PORTAL") throw invoiceError("UNSUPPORTED_INVOICE_PORTAL", "This page is not a supported invoice portal yet.");
    if (result?.code === "MISSING_ACCOUNT_ID") throw invoiceError("MISSING_ACCOUNT_ID", "BrowserCrew could not confirm which account these invoices belong to.");
    throw invoiceError("INVOICE_OBSERVE_FAILED", "BrowserCrew could not inspect this invoice portal.");
  }

  const safeInvoices = [];
  for (const invoice of result.invoices) {
    try {
      validateInvoiceDownload(invoice, result.url);
      safeInvoices.push(invoice);
    } catch {}
  }
  return { ...result, invoices: safeInvoices, observedAt: new Date().toISOString() };
}

function validateInvoiceDownload(invoice, portalUrl) {
  const portal = new URL(portalUrl);
  const download = new URL(invoice.downloadUrl, portal);
  if (download.origin !== portal.origin) throw invoiceError("INVOICE_CROSS_ORIGIN", `Invoice ${invoice.id} points outside the approved portal site.`);
  const loopback = ["127.0.0.1", "localhost"].includes(download.hostname);
  if (download.protocol !== "https:" && !(download.protocol === "http:" && loopback)) {
    throw invoiceError("UNSAFE_INVOICE_URL", `Invoice ${invoice.id} is not using a secure download address.`);
  }
  if (!/\.pdf(?:$|[?#])/i.test(download.href)) throw invoiceError("INVOICE_NOT_PDF", `Invoice ${invoice.id} is not a supported PDF download.`);
}

function waitForInvoiceDownload(downloadId, controller) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const finish = (error, item) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      if (error) reject(error); else resolve(item);
    };
    const inspect = async () => {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (!item) return finish(invoiceError("DOWNLOAD_NOT_FOUND", "Chrome no longer reports this invoice download."));
      if (item.state === "complete") return finish(null, item);
      if (item.state === "interrupted") return finish(invoiceError("DOWNLOAD_INTERRUPTED", `Chrome interrupted the download for ${item.filename || "this invoice"}.`));
    };
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (controller.cancelled) return inspect().catch((error) => finish(error));
      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") inspect().catch((error) => finish(error));
    };
    chrome.downloads.onChanged.addListener(listener);
    const timer = setTimeout(() => finish(invoiceError("DOWNLOAD_TIMEOUT", "Chrome did not finish this invoice download within 60 seconds.")), DOWNLOAD_TIMEOUT_MS);
    try { await inspect(); } catch (error) { finish(error); }
  });
}

function verifyInvoiceDownload(task, invoice, item, intentAt) {
  const exactUrl = item.url === invoice.downloadUrl || item.finalUrl === invoice.downloadUrl;
  const complete = item.state === "complete";
  const exists = item.exists !== false;
  const bytesReceived = Number(item.bytesReceived || 0);
  const verified = complete && exists && exactUrl && bytesReceived > 0;
  if (!verified) {
    throw invoiceError("DOWNLOAD_UNVERIFIED", `Chrome did not provide enough evidence to verify ${invoice.id}. BrowserCrew will not treat its filename as proof.`);
  }
  return makeManifestEntry(task, invoice, {
    downloadId: item.id,
    intentAt,
    verified: true,
    state: item.state,
    filename: item.filename,
    bytesReceived,
    finalUrl: item.finalUrl || item.url,
    verifiedAt: new Date().toISOString(),
    verificationMethod: "Chrome download complete + exact source URL + file exists + bytes received"
  });
}

function makeManifestEntry(task, invoice, extra = {}) {
  return {
    invoiceId: invoice.id,
    invoiceLabel: invoice.label,
    invoiceDate: invoice.date,
    amount: invoice.amount,
    accountId: task.account.id,
    accountLabel: task.account.label,
    portalUrl: task.portalUrl,
    downloadUrl: invoice.downloadUrl,
    downloadId: extra.downloadId ?? null,
    state: extra.state || "pending",
    verified: Boolean(extra.verified),
    filename: extra.filename || null,
    bytesReceived: Number(extra.bytesReceived || 0),
    finalUrl: extra.finalUrl || null,
    intentAt: extra.intentAt || null,
    verifiedAt: extra.verifiedAt || null,
    verificationMethod: extra.verificationMethod || null
  };
}

function buildInvoiceResult(task, recovered) {
  const entries = Array.isArray(task.manifest) ? task.manifest.map((entry) => ({ ...entry })) : [];
  return {
    kind: "invoice_collection",
    account: task.account,
    portalUrl: task.portalUrl,
    selectedCount: task.selectedInvoices?.length || 0,
    verifiedCount: entries.filter((entry) => entry.verified).length,
    entries,
    recovered: Boolean(recovered),
    verificationMethod: "Each invoice is verified from Chrome's download state and exact source URL; filenames alone are not proof."
  };
}

async function reconcilePendingInvoiceTasks() {
  const tasks = await getInvoiceTasks();
  for (const task of tasks) {
    if (task?.kind !== "invoice_collection") continue;
    if (["running", "recovering"].includes(task.status) || String(task.checkpoint || "").startsWith("invoice_")) {
      if (["completed", "partially_completed", "cancelled", "failed"].includes(task.status)) continue;
      await reconcileInvoiceTask(task.id);
    }
  }
}

async function reconcileInvoiceTask(taskId) {
  const task = await getInvoiceTask(taskId);
  if (!task) return;
  await mutateInvoiceTask(taskId, (current) => {
    current.status = "recovering";
    current.checkpoint = "invoice_reconciling";
  });

  try {
    const manifest = Array.isArray(task.manifest) ? [...task.manifest] : [];
    const selected = Array.isArray(task.selectedInvoices) ? task.selectedInvoices : [];
    for (const invoice of selected) {
      let entry = manifest.find((item) => item.invoiceId === invoice.id);
      if (entry?.verified) continue;
      let item = null;
      if (Number.isInteger(entry?.downloadId)) {
        [item] = await chrome.downloads.search({ id: entry.downloadId });
      }
      if (!item) item = await findRecentInvoiceDownload(invoice.downloadUrl, entry?.intentAt || task.createdAt);
      if (!item) {
        return markInvoiceOutcomeUnknown(taskId, `BrowserCrew restarted around the download for ${invoice.id} and cannot prove whether Chrome started it. It will not start a duplicate automatically.`);
      }
      if (item.state === "in_progress") {
        try { item = await waitForInvoiceDownload(item.id, { cancelled: false }); }
        catch { return markInvoiceOutcomeUnknown(taskId, `BrowserCrew found the existing download for ${invoice.id}, but cannot prove it completed. It will not start another copy automatically.`); }
      }
      if (item.state !== "complete") {
        return markInvoiceOutcomeUnknown(taskId, `The existing Chrome download for ${invoice.id} did not complete. BrowserCrew will not start another copy automatically.`);
      }
      const verifiedEntry = verifyInvoiceDownload(task, invoice, item, entry?.intentAt || task.createdAt);
      const existingIndex = manifest.findIndex((value) => value.invoiceId === invoice.id);
      if (existingIndex >= 0) manifest[existingIndex] = verifiedEntry; else manifest.push(verifiedEntry);
    }

    await mutateInvoiceTask(taskId, (current) => {
      current.manifest = manifest;
      current.status = "completed";
      current.checkpoint = "completed";
      current.error = null;
      current.result = buildInvoiceResult({ ...current, manifest }, true);
      current.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "invoice_collection.recovered", data: { verifiedCount: manifest.filter((entry) => entry.verified).length } });
    });
  } catch {
    await markInvoiceOutcomeUnknown(taskId, "BrowserCrew restarted during invoice collection and could not safely reconcile the existing Chrome downloads. It will not create duplicate downloads automatically.");
  }
}

async function findRecentInvoiceDownload(url, sinceText) {
  const since = Date.parse(sinceText || "") || 0;
  const items = await chrome.downloads.search({ limit: 100, orderBy: ["-startTime"] });
  return items.find((item) => {
    const started = Date.parse(item.startTime || "") || 0;
    return started >= since - 5000 && (item.url === url || item.finalUrl === url);
  }) || null;
}

async function markInvoiceOutcomeUnknown(taskId, message) {
  await mutateInvoiceTask(taskId, (current) => {
    current.status = "awaiting_user";
    current.checkpoint = "invoice_outcome_unknown";
    current.error = { code: "INVOICE_OUTCOME_UNKNOWN", message };
    current.result = buildInvoiceResult(current, true);
  });
}

function validateInvoiceTab(tab) {
  if (!tab?.id || !/^https?:/.test(tab?.url || "")) throw invoiceError("MISSING_PORTAL_PAGE", "Choose the invoice portal page first.");
}

function validateInvoicePayload(payload) {
  validateInvoiceTab(payload?.tab);
  if (!Array.isArray(payload?.invoiceIds) || !payload.invoiceIds.length) throw invoiceError("NO_INVOICES_SELECTED", "Choose at least one invoice to download.");
  if (payload.invoiceIds.length > MAX_INVOICES) throw invoiceError("TOO_MANY_INVOICES", `Choose no more than ${MAX_INVOICES} invoices in one job.`);
}

async function ensureInvoiceSitePermission(urlText) {
  const url = new URL(urlText);
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw invoiceError("SITE_PERMISSION_DENIED", `BrowserCrew does not have permission to read or download from ${url.hostname}.`);
}

function sanitizeInvoiceFilename(value) {
  const cleaned = String(value || "invoice").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || "invoice";
}

function postInvoiceProgress(port, taskId, message) {
  try { port.postMessage({ type: "INVOICE_PROGRESS", taskId, message }); } catch {}
}

function invoiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeInvoiceError(error) {
  return { code: error?.code || "INVOICE_ERROR", message: error?.message || "BrowserCrew could not complete this invoice collection." };
}

async function getInvoiceTasks() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

async function getInvoiceTask(taskId) {
  return (await getInvoiceTasks()).find((task) => task.id === taskId) || null;
}

async function upsertInvoiceTask(task) {
  const tasks = await getInvoiceTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks[index] = task; else tasks.unshift(task);
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) });
}

async function mutateInvoiceTask(taskId, mutate) {
  const tasks = await getInvoiceTasks();
  const index = tasks.findIndex((item) => item.id === taskId);
  if (index < 0) throw invoiceError("INVOICE_TASK_NOT_FOUND", "This invoice collection job could not be found.");
  mutate(tasks[index]);
  tasks[index].journal = Array.isArray(tasks[index].journal) ? tasks[index].journal : [];
  tasks[index].updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) });
  return tasks[index];
}

async function journalInvoice(taskId, type, data) {
  await mutateInvoiceTask(taskId, (task) => {
    task.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, data });
  });
}
