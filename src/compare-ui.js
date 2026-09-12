const COMPARE_PORT = "browsercrew-compare-read";
const compareState = { tabs: [], port: null, taskId: null };
const q = (selector) => document.querySelector(selector);
const qa = (selector) => [...document.querySelectorAll(selector)];

installCompareWorkspace();

document.addEventListener("DOMContentLoaded", () => {
  bindCompareUi();
});

function installCompareWorkspace() {
  const install = () => {
    const singlePageCard = q("#selectTabButton")?.closest(".card");
    if (singlePageCard) singlePageCard.id = "singlePageCard";

    const modeGrid = q(".mode-choice-grid");
    if (modeGrid && !q('[data-job-mode="compare"]')) {
      modeGrid.insertAdjacentHTML("beforeend", '<button class="mode-choice tactile" type="button" data-job-mode="compare" role="radio" aria-checked="false"><strong>Compare pages</strong><span>Choose 2–5 open pages and compare the same facts across all of them.</span></button>');
    }

    const anchor = q("#readStartCard");
    if (anchor && !q("#compareJobCard")) {
      anchor.insertAdjacentHTML("beforebegin", `
        <article class="card" id="compareJobCard" hidden>
          <div class="card-heading"><div><p class="step-label">2 · PAGES</p><h2>Choose the pages to compare</h2></div><span class="badge badge-safe">Read only</span></div>
          <p class="helper">BrowserCrew can compare 2 to 5 normal website tabs from this window. Each selected page stays read only.</p>
          <button class="button tactile full" id="refreshCompareTabsButton" type="button">Refresh open pages</button>
          <div class="provider-grid" id="compareTabList"><div class="empty">Open the supplier pages you want to compare, then refresh this list.</div></div>
          <label class="field-label" for="compareCriteriaInput">What should I compare?</label>
          <textarea id="compareCriteriaInput" rows="5" placeholder="Example:&#10;Price&#10;Minimum order&#10;Lead time&#10;Shipping"></textarea>
          <p class="helper">Put each item on its own line, or separate items with commas. BrowserCrew checks each returned value against the page text and marks missing information clearly.</p>
          <div class="example-box">👀 BrowserCrew reads only the pages you select. It does not contact suppliers or change any page.</div>
          <button class="button button-primary tactile full" id="runCompareButton" type="button">Compare selected pages</button>
        </article>

        <article class="card run-card" id="compareRunCard" hidden aria-live="polite">
          <div class="run-head"><div><p class="step-label">CURRENT COMPARISON</p><h2>Checking selected pages…</h2></div><span class="badge" id="compareRunBadge">Running</span></div>
          <p class="helper" id="compareProgressText">Starting comparison…</p>
          <button class="button button-danger tactile full" id="stopCompareButton" type="button">Stop comparison</button>
        </article>

        <article class="card result-card" id="compareResultCard" hidden aria-live="polite">
          <div class="card-heading"><div><p class="step-label">COMPARISON RESULT</p><h2>Page-by-page comparison</h2></div><span class="badge badge-safe" id="compareResultBadge">Checked</span></div>
          <div class="evidence-box" id="compareTableWrap"></div>
          <div class="evidence-box" id="compareEvidenceBox"></div>
        </article>`);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

function bindCompareUi() {
  q('[data-job-mode="compare"]')?.addEventListener("click", renderCompareTabs);
  q("#refreshCompareTabsButton")?.addEventListener("click", renderCompareTabs);
  q("#compareTabList")?.addEventListener("click", onCompareTabClick);
  q("#runCompareButton")?.addEventListener("click", runComparison);
  q("#stopCompareButton")?.addEventListener("click", stopComparison);
}

function onCompareTabClick(event) {
  const button = event.target.closest("[data-compare-tab-id]");
  if (!button) return;
  const selected = !button.classList.contains("is-selected");
  button.classList.toggle("is-selected", selected);
  button.setAttribute("aria-pressed", String(selected));
}

async function renderCompareTabs() {
  setButtonBusy(q("#refreshCompareTabsButton"), true, "Checking open pages…");
  const response = await requestCompareOnce({ type: "GET_COMPARE_TABS" }, "COMPARE_TABS");
  setButtonBusy(q("#refreshCompareTabsButton"), false, "Refresh open pages");
  const list = q("#compareTabList");
  if (!response?.ok) {
    list.innerHTML = '<div class="empty">BrowserCrew could not load the open page list.</div>';
    notify(response?.error?.message || "Could not load open pages.");
    return;
  }
  compareState.tabs = response.tabs || [];
  if (!compareState.tabs.length) {
    list.innerHTML = '<div class="empty">No normal website tabs are open in this window.</div>';
    return;
  }
  list.innerHTML = compareState.tabs.map((tab) => {
    const host = safeHost(tab.url);
    return `<button class="setting-choice tactile" type="button" data-compare-tab-id="${tab.id}" aria-pressed="false"><strong>${escapeText(tab.title)}</strong><span>${escapeText(host)}</span></button>`;
  }).join("");
}

async function runComparison() {
  const selectedIds = qa("[data-compare-tab-id].is-selected").map((button) => Number(button.dataset.compareTabId)).filter(Number.isFinite);
  if (selectedIds.length < 2 || selectedIds.length > 5) {
    notify("Choose between 2 and 5 pages to compare.");
    return;
  }
  const criteria = q("#compareCriteriaInput")?.value.trim() || "";
  if (!criteria) {
    notify("Tell BrowserCrew what details you want to compare.");
    return;
  }

  const selectedTabs = selectedIds.map((id) => compareState.tabs.find((tab) => tab.id === id)).filter(Boolean);
  if (selectedTabs.length !== selectedIds.length) {
    notify("The open-page list changed. Refresh it and choose the pages again.");
    return;
  }

  const originPatterns = [...new Set(selectedTabs.map((tab) => originPattern(tab.url)).filter(Boolean))];
  if (!(await requestOrigins(originPatterns))) {
    notify("Chrome access is needed for the selected pages. Approve the permission prompt to continue.");
    return;
  }

  const settings = collectSettings();
  const providerPattern = originPattern(settings.baseUrl);
  if (!providerPattern || !(await requestOrigins([providerPattern]))) {
    notify("This comparison needs access to your selected AI service. Open Connect AI, test it, and approve Chrome's permission prompt.");
    return;
  }

  setHidden("#compareResultCard", true);
  setHidden("#compareRunCard", false);
  q("#compareProgressText").textContent = `Starting comparison of ${selectedIds.length} pages…`;
  q("#compareRunBadge").textContent = "Running";
  setButtonBusy(q("#runCompareButton"), true, "Comparison is running…");

  closeComparePort();
  const port = chrome.runtime.connect({ name: COMPARE_PORT });
  compareState.port = port;
  compareState.taskId = null;

  port.onMessage.addListener((message) => {
    if (message?.type === "COMPARE_PROGRESS") {
      if (message.taskId) compareState.taskId = message.taskId;
      q("#compareProgressText").textContent = message.message || "Working…";
      return;
    }
    if (message?.type === "COMPARE_CANCELLED") {
      q("#compareRunBadge").textContent = "Stopping";
      return;
    }
    if (message?.type === "COMPARE_DONE") finishComparison(message);
  });
  port.onDisconnect.addListener(() => {
    if (compareState.port === port) {
      compareState.port = null;
      if (!q("#compareRunCard")?.hidden) {
        q("#compareRunBadge").textContent = "Interrupted";
        q("#compareProgressText").textContent = "The comparison worker stopped before replying. Check History before starting again.";
        setButtonBusy(q("#runCompareButton"), false, "Compare selected pages");
      }
    }
  });

  const selectedResources = selectedTabs.map(({ id, title, url }) => ({ id, title, url }));
  port.postMessage({ type: "RUN_COMPARE_TASK", payload: { tabIds: selectedIds, selectedResources, criteria, settings, secret: secretForRequest() } });
}

function finishComparison(message) {
  setButtonBusy(q("#runCompareButton"), false, "Compare selected pages");
  setHidden("#compareRunCard", true);
  compareState.taskId = null;
  closeComparePort();

  if (message?.task?.result) renderComparisonResult(message.task);
  if (message?.ok) {
    notify(message.partial ? "Comparison finished with some page errors. Missing or failed values are marked." : "Comparison finished and the returned values were checked against each page.");
  } else {
    notify(message?.error?.message || "The comparison could not finish safely.");
  }
  requestHistoryRefresh();
}

async function stopComparison() {
  if (!compareState.port || !compareState.taskId) {
    notify("BrowserCrew has not started a comparison step yet.");
    return;
  }
  q("#compareRunBadge").textContent = "Stopping";
  q("#compareProgressText").textContent = "Stopping after the current page is reconciled…";
  compareState.port.postMessage({ type: "CANCEL_COMPARE_TASK", taskId: compareState.taskId });
}

function renderComparisonResult(task) {
  const result = task?.result;
  if (!result?.rows?.length) return;
  const criteria = result.criteria || [];
  const header = `<tr><th>Page</th>${criteria.map((criterion) => `<th>${escapeText(criterion)}</th>`).join("")}</tr>`;
  const rows = result.rows.map((row) => {
    const values = criteria.map((criterion) => {
      const item = row.values?.find((value) => value.criterion === criterion);
      const text = item?.value || (row.status === "failed" ? "Page failed" : "Not found");
      return `<td>${escapeText(text)}</td>`;
    }).join("");
    return `<tr><th scope="row"><a href="${escapeAttribute(row.url)}" target="_blank" rel="noreferrer">${escapeText(row.title || row.host)}</a><small>${escapeText(row.host || "")}</small></th>${values}</tr>`;
  }).join("");

  q("#compareTableWrap").innerHTML = `<div class="compare-table-scroll"><table class="compare-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;
  const failures = result.rows.filter((row) => row.status === "failed");
  const missing = result.rows.flatMap((row) => row.values || []).filter((item) => !item.found).length;
  q("#compareEvidenceBox").innerHTML = `<strong>Evidence and missing values</strong><p>BrowserCrew checked ${result.rows.length} selected page${result.rows.length === 1 ? "" : "s"}. ${missing} comparison cell${missing === 1 ? "" : "s"} ${missing === 1 ? "is" : "are"} missing or unverified.</p>${failures.length ? `<p><strong>Page errors:</strong> ${escapeText(failures.map((row) => `${row.host}: ${row.error?.message || "Could not complete"}`).join(" · "))}</p>` : ""}<p>Click a page name in the table to review the source.</p>`;
  q("#compareResultBadge").textContent = task.status === "partially_completed" ? "Partial" : "Checked";
  setHidden("#compareResultCard", false);
  q("#compareResultCard")?.scrollIntoView({ block: "nearest" });
}

function requestCompareOnce(message, expectedType) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: COMPARE_PORT });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(value);
    };
    port.onMessage.addListener((response) => { if (response?.type === expectedType) finish(response); });
    port.onDisconnect.addListener(() => { if (!settled) finish({ ok: false, error: { code: "COMPARE_WORKER_DISCONNECTED", message: "BrowserCrew's comparison worker stopped before replying." } }); });
    port.postMessage(message);
  });
}

async function requestOrigins(patterns) {
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
function safeHost(urlText) { try { return new URL(urlText).hostname; } catch { return "Unknown site"; } }
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
function requestHistoryRefresh() {
  q("#refreshHistoryButton")?.click();
  q("#refreshMemoryButton")?.click();
}
function closeComparePort() {
  const port = compareState.port;
  compareState.port = null;
  if (port) { try { port.disconnect(); } catch {} }
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
