const DIRECTORY_PORT = "browsercrew-directory-extract";
const directoryState = {
  selectedTab: null,
  port: null,
  taskId: null,
  result: null
};
const dq = (selector) => document.querySelector(selector);
const dqa = (selector) => [...document.querySelectorAll(selector)];

installDirectoryWorkspace();

document.addEventListener("DOMContentLoaded", () => {
  bindDirectoryUi();
  refreshDedupeChoices();
});

function installDirectoryWorkspace() {
  const install = () => {
    const modeGrid = dq(".mode-choice-grid");
    if (modeGrid && !dq('[data-job-mode="directory"]')) {
      modeGrid.insertAdjacentHTML("beforeend", `
        <button class="mode-choice tactile" type="button" data-job-mode="directory" role="radio" aria-checked="false">
          <strong>Extract a directory</strong>
          <span>Move through a bounded set of directory pages and export checked rows.</span>
        </button>`);
      const helper = modeGrid.previousElementSibling;
      if (helper?.classList.contains("helper")) {
        helper.textContent = "Choose a read-only job, a reviewed form fill, a page comparison, or a bounded directory export. BrowserCrew explains what each job can change before it starts.";
      }
    }

    const anchor = dq("#readStartCard");
    if (anchor && !dq("#directoryJobCard")) {
      anchor.insertAdjacentHTML("beforebegin", `
        <article class="card" id="directoryJobCard" hidden>
          <div class="card-heading">
            <div><p class="step-label">2 · DIRECTORY</p><h2>Choose the columns to export</h2></div>
            <span class="badge badge-safe">Read only</span>
          </div>
          <p class="helper">Start on page 1 of the directory. BrowserCrew follows only same-site <strong>Next</strong> links and stops at the page limit you choose.</p>

          <label class="field-label" for="directoryColumnsInput">What should each row contain?</label>
          <textarea id="directoryColumnsInput" rows="5" placeholder="Example:&#10;Company&#10;City&#10;Phone&#10;Notes">Company
City
Phone
Notes</textarea>
          <p class="helper">Put one column on each line. BrowserCrew asks the AI for these exact columns and removes any value it cannot verify in the page text.</p>

          <label class="field-label" for="directoryDedupeKey">Which column identifies the same record?</label>
          <select id="directoryDedupeKey"></select>
          <p class="helper">BrowserCrew uses this column to explain duplicates. Exact duplicates are removed. Conflicting duplicates are kept and marked so you do not lose data.</p>

          <label class="field-label" for="directoryPageLimit">Maximum pages to read</label>
          <input id="directoryPageLimit" type="number" inputmode="numeric" min="1" max="10" value="3" />
          <p class="helper">BrowserCrew will read no more than 10 pages in one job. If another page exists after your limit, the result tells you the limit was reached.</p>

          <div class="example-box">👀 BrowserCrew may move the selected tab through the directory pages. It does not edit records, submit forms, contact anyone, or leave the approved website.</div>
          <button class="button button-primary tactile full" id="runDirectoryButton" type="button">Extract this directory</button>
        </article>

        <article class="card run-card" id="directoryRunCard" hidden aria-live="polite">
          <div class="run-head">
            <div><p class="step-label">CURRENT DIRECTORY JOB</p><h2>Reading directory pages…</h2></div>
            <span class="badge" id="directoryRunBadge">Running</span>
          </div>
          <p class="helper" id="directoryProgressText">Starting directory extraction…</p>
          <button class="button button-danger tactile full" id="stopDirectoryButton" type="button">Stop directory extraction</button>
        </article>

        <article class="card result-card" id="directoryResultCard" hidden aria-live="polite">
          <div class="card-heading">
            <div><p class="step-label">DIRECTORY RESULT</p><h2>Checked rows are ready</h2></div>
            <span class="badge badge-safe" id="directoryResultBadge">Checked</span>
          </div>
          <div class="evidence-box" id="directorySummaryBox"></div>
          <div class="evidence-box" id="directoryTableWrap"></div>
          <div class="evidence-box" id="directoryDuplicateBox"></div>
          <div class="button-row">
            <button class="button button-primary tactile" id="downloadDirectoryCsvButton" type="button">Download safe CSV</button>
            <button class="button tactile" id="downloadDirectoryJsonButton" type="button">Download JSON</button>
          </div>
          <p class="helper">CSV cells that could be interpreted as spreadsheet formulas are prefixed with an apostrophe before export. JSON keeps the original verified text.</p>
        </article>`);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

function bindDirectoryUi() {
  dqa("[data-job-mode]").forEach((button) => {
    button.addEventListener("click", () => queueMicrotask(() => syncDirectoryMode(button.dataset.jobMode)));
  });
  dq("#selectTabButton")?.addEventListener("click", captureDirectoryStartPage, { capture: true });
  dq("#directoryColumnsInput")?.addEventListener("input", refreshDedupeChoices);
  dq("#runDirectoryButton")?.addEventListener("click", runDirectoryExtraction);
  dq("#stopDirectoryButton")?.addEventListener("click", stopDirectoryExtraction);
  dq("#downloadDirectoryCsvButton")?.addEventListener("click", () => exportDirectory("csv"));
  dq("#downloadDirectoryJsonButton")?.addEventListener("click", () => exportDirectory("json"));
}

function syncDirectoryMode(mode) {
  const active = mode === "directory";
  setDirectoryHidden("#directoryJobCard", !active);
  if (!active) {
    setDirectoryHidden("#directoryRunCard", true);
    setDirectoryHidden("#directoryResultCard", true);
    return;
  }

  dqa("[data-job-mode]").forEach((button) => {
    const selected = button.dataset.jobMode === "directory";
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });

  for (const selector of [
    "#readJobCard", "#readStartCard", "#formJobCard", "#formPreviewCard", "#formResultCard",
    "#compareJobCard", "#compareRunCard", "#compareResultCard", "#runCard", "#resultCard"
  ]) setDirectoryHidden(selector, true);

  const intro = dq("#view-workspace .view-intro");
  if (intro) intro.textContent = "Start on page 1, choose the columns you need, and BrowserCrew will move through a bounded number of same-site directory pages before preparing safe CSV and JSON exports.";
}

async function captureDirectoryStartPage() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
  if (response?.ok) directoryState.selectedTab = response.tab;
}

function refreshDedupeChoices() {
  const select = dq("#directoryDedupeKey");
  if (!select) return;
  const previous = select.value;
  const columns = parseColumns();
  select.innerHTML = columns.map((column) => `<option value="${escapeAttribute(column)}">${escapeText(column)}</option>`).join("");
  if (columns.includes(previous)) select.value = previous;
}

async function runDirectoryExtraction() {
  if (dq("#pageStatus")?.dataset.state !== "ok" || !directoryState.selectedTab) {
    notifyDirectory("Choose page 1 of the directory first.");
    return;
  }

  const columns = parseColumns();
  if (!columns.length) {
    notifyDirectory("Add at least one export column.");
    return;
  }
  if (columns.length > 12) {
    notifyDirectory("Use no more than 12 columns for one directory job.");
    return;
  }

  const dedupeKey = dq("#directoryDedupeKey")?.value || columns[0];
  const pageLimit = Math.max(1, Math.min(10, Number.parseInt(dq("#directoryPageLimit")?.value || "1", 10) || 1));
  dq("#directoryPageLimit").value = String(pageLimit);

  const settings = collectDirectorySettings();
  if (!(await requestDirectoryOrigins([originPattern(directoryState.selectedTab.url)].filter(Boolean)))) {
    notifyDirectory("Chrome access is needed for this directory site. Approve the permission prompt to continue.");
    return;
  }
  if (!(await requestDirectoryOrigins([originPattern(settings.baseUrl)].filter(Boolean)))) {
    notifyDirectory("This job needs access to your selected AI service. Open Connect AI, test it, and approve Chrome's permission prompt.");
    return;
  }

  closeDirectoryPort();
  directoryState.result = null;
  setDirectoryHidden("#directoryResultCard", true);
  setDirectoryHidden("#directoryRunCard", false);
  setDirectoryBusy(dq("#runDirectoryButton"), true, "Directory extraction is running…");
  dq("#directoryRunBadge").textContent = "Running";
  dq("#directoryProgressText").textContent = `Starting a job capped at ${pageLimit} page${pageLimit === 1 ? "" : "s"}…`;

  const port = chrome.runtime.connect({ name: DIRECTORY_PORT });
  directoryState.port = port;
  directoryState.taskId = null;

  port.onMessage.addListener((message) => {
    if (message?.type === "DIRECTORY_PROGRESS") {
      if (message.taskId) directoryState.taskId = message.taskId;
      dq("#directoryProgressText").textContent = message.message || "Working…";
      return;
    }
    if (message?.type === "DIRECTORY_CANCELLED") {
      dq("#directoryRunBadge").textContent = "Stopping";
      return;
    }
    if (message?.type === "DIRECTORY_DONE") finishDirectoryExtraction(message);
  });

  port.onDisconnect.addListener(() => {
    if (directoryState.port === port) {
      directoryState.port = null;
      if (!dq("#directoryRunCard")?.hidden) {
        dq("#directoryRunBadge").textContent = "Interrupted";
        dq("#directoryProgressText").textContent = "The directory worker stopped before replying. Check History before starting again.";
        setDirectoryBusy(dq("#runDirectoryButton"), false, "Extract this directory");
      }
    }
  });

  port.postMessage({
    type: "RUN_DIRECTORY_TASK",
    payload: {
      tab: directoryState.selectedTab,
      columns,
      dedupeKey,
      pageLimit,
      settings,
      secret: secretForDirectoryRequest()
    }
  });
}

function finishDirectoryExtraction(message) {
  setDirectoryBusy(dq("#runDirectoryButton"), false, "Extract this directory");
  setDirectoryHidden("#directoryRunCard", true);
  directoryState.taskId = null;
  closeDirectoryPort();

  if (message?.task?.result) {
    directoryState.result = message.task.result;
    renderDirectoryResult(message.task);
  }

  if (message?.task?.status === "cancelled") {
    notifyDirectory("Directory extraction stopped. No additional page was read after the stop was recorded.");
  } else if (message?.ok) {
    notifyDirectory(message.task.status === "partially_completed"
      ? "Directory extraction finished with some omitted rows. Review the result notes before exporting."
      : "Directory extraction finished. Verified rows are ready to export.");
  } else {
    notifyDirectory(message?.task?.error?.message || message?.error?.message || "The directory job could not finish safely.");
  }

  requestDirectoryHistoryRefresh();
}

async function stopDirectoryExtraction() {
  if (!directoryState.port || !directoryState.taskId) {
    notifyDirectory("BrowserCrew has not started a directory page yet.");
    return;
  }
  dq("#directoryRunBadge").textContent = "Stopping";
  dq("#directoryProgressText").textContent = "Stopping before another page is read…";
  directoryState.port.postMessage({ type: "CANCEL_DIRECTORY_TASK", taskId: directoryState.taskId });
}

function renderDirectoryResult(task) {
  const result = task?.result;
  if (!result?.rows?.length) return;

  const duplicateCount = result.duplicates?.length || 0;
  const droppedCount = result.droppedRows?.length || 0;
  const limitNote = result.pageLimitReached
    ? ` BrowserCrew stopped at your ${result.pageLimit}-page limit even though another page was available.`
    : "";

  dq("#directorySummaryBox").innerHTML = `
    <strong>${result.rows.length} export row${result.rows.length === 1 ? "" : "s"} from ${result.pageCount} page${result.pageCount === 1 ? "" : "s"}</strong>
    <p>${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} explained. ${droppedCount} row${droppedCount === 1 ? "" : "s"} omitted because the duplicate key was missing or unverified.${escapeText(limitNote)}</p>
    <p><strong>Duplicate key:</strong> ${escapeText(result.dedupeKey)} · <strong>Page cap:</strong> ${result.pageLimit}</p>`;

  const header = `<tr>${result.schema.map((column) => `<th>${escapeText(column)}</th>`).join("")}<th>Source</th><th>Duplicate note</th></tr>`;
  const rows = result.rows.map((row) => `
    <tr>
      ${result.schema.map((column) => `<td>${escapeText(row.values?.[column] ?? "Not found")}</td>`).join("")}
      <td><a href="${escapeAttribute(row.sourceUrl)}" target="_blank" rel="noreferrer">Page ${row.sourcePage}</a></td>
      <td>${escapeText(row.duplicateStatus || "—")}</td>
    </tr>`).join("");

  dq("#directoryTableWrap").innerHTML = `<div class="compare-table-scroll"><table class="compare-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;

  const duplicates = result.duplicates || [];
  dq("#directoryDuplicateBox").innerHTML = duplicates.length
    ? `<strong>Duplicate report</strong><ul>${duplicates.map((item) => `<li><strong>${escapeText(item.key)}</strong>: ${escapeText(item.message)}</li>`).join("")}</ul>`
    : "<strong>Duplicate report</strong><p>No duplicates were found with the selected duplicate key.</p>";

  dq("#directoryResultBadge").textContent = task.status === "partially_completed" ? "Partial" : "Checked";
  setDirectoryHidden("#directoryResultCard", false);
  dq("#directoryResultCard")?.scrollIntoView({ block: "nearest" });
}

function exportDirectory(format) {
  const result = directoryState.result;
  if (!result?.rows?.length) {
    notifyDirectory("Run a directory extraction before downloading a file.");
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    const payload = {
      schemaVersion: 1,
      kind: "browsercrew.directory_export",
      exportedAt: new Date().toISOString(),
      schema: result.schema,
      dedupeKey: result.dedupeKey,
      pageCount: result.pageCount,
      pageLimit: result.pageLimit,
      pageLimitReached: result.pageLimitReached,
      sourceUrls: result.sourceUrls,
      rows: result.rows,
      duplicates: result.duplicates,
      droppedRows: result.droppedRows
    };
    downloadTextFile(`browsercrew-directory-${stamp}.json`, `${JSON.stringify(payload, null, 2)}\n`, "application/json");
    return;
  }

  const csv = buildSafeCsv(result);
  downloadTextFile(`browsercrew-directory-${stamp}.csv`, csv, "text/csv;charset=utf-8");
}

function buildSafeCsv(result) {
  const headers = [...result.schema, "_source_url", "_source_page", "_duplicate_status"];
  const lines = [headers.map(csvCell).join(",")];

  for (const row of result.rows) {
    const values = result.schema.map((column) => neutralizeSpreadsheetCell(row.values?.[column] ?? ""));
    values.push(row.sourceUrl || "", String(row.sourcePage || ""), row.duplicateStatus || "");
    lines.push(values.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function neutralizeSpreadsheetCell(value) {
  const text = String(value ?? "");
  return /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadTextFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function parseColumns() {
  return [...new Set(String(dq("#directoryColumnsInput")?.value || "")
    .split(/\r?\n|,/)
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean))];
}

function collectDirectorySettings() {
  const selected = dq(".provider-card.is-selected")?.dataset.provider || "openai";
  return {
    kind: selected,
    model: dq("#modelInput")?.value.trim() || "",
    baseUrl: dq("#serverInput")?.value.trim() || ""
  };
}

function secretForDirectoryRequest() {
  const provider = dq(".provider-card.is-selected")?.dataset.provider || "openai";
  if (provider !== "openai") return "";
  const typed = dq("#apiKeyInput")?.value || "";
  return typed.length ? typed : undefined;
}

async function requestDirectoryOrigins(patterns) {
  const unique = [...new Set(patterns.filter(Boolean))];
  if (!unique.length) return false;
  const missing = [];
  for (const pattern of unique) {
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) missing.push(pattern);
  }
  if (!missing.length) return true;
  return chrome.permissions.request({ origins: missing });
}

function originPattern(urlText) {
  try { return `${new URL(urlText).origin}/*`; } catch { return null; }
}

function closeDirectoryPort() {
  const port = directoryState.port;
  directoryState.port = null;
  if (port) {
    try { port.disconnect(); } catch {}
  }
}

function requestDirectoryHistoryRefresh() {
  dq("#refreshHistoryButton")?.click();
  dq("#refreshMemoryButton")?.click();
}

function setDirectoryHidden(selector, hidden) {
  const element = dq(selector);
  if (element) element.hidden = hidden;
}

function setDirectoryBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function notifyDirectory(message) {
  const toast = dq("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyDirectory.timer);
  notifyDirectory.timer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

function escapeAttribute(value) {
  return escapeText(value);
}
