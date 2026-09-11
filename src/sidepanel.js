const presets = {
  openai: { model: "gpt-5.6", baseUrl: "https://api.openai.com/v1", needsKey: true },
  lmstudio: { model: "local-model", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  ollama: { model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false }
};

const VIEW_KEY = "browsercrew.activeView";
const THEME_KEY = "browsercrew.theme";
const validViews = new Set(["workspace", "ai", "history", "settings"]);
const state = { selectedTab: null, providerKind: "openai", currentTaskId: null, lastConnectionOk: false, hasSecret: false };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  restoreTheme();
  showView(localStorage.getItem(VIEW_KEY) || "workspace", false);
  const response = await send({ type: "GET_SETTINGS" });
  if (response.ok) applySettings(response.settings, response.hasSecret);
  await renderHistory();
}

function bindEvents() {
  $$(".function-tab").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
    button.addEventListener("keydown", onTabKeydown);
  });
  $$("[data-go-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.goView)));
  $$(".chip").forEach((button) => button.addEventListener("click", () => { $("#goalInput").value = button.dataset.example; }));
  $$(".provider-card").forEach((button) => button.addEventListener("click", () => chooseProvider(button.dataset.provider, true)));
  $$("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => setThemePreference(button.dataset.themeChoice)));
  $("#selectTabButton").addEventListener("click", selectCurrentTab);
  $("#testConnectionButton").addEventListener("click", testConnection);
  $("#runButton").addEventListener("click", runJob);
  $("#pauseButton").addEventListener("click", () => controlJob("PAUSE_TASK"));
  $("#stopButton").addEventListener("click", () => controlJob("STOP_TASK"));
  $("#refreshHistoryButton").addEventListener("click", renderHistory);
  $("#themeButton").addEventListener("click", toggleTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyThemePreference("system");
  });
}

function showView(name, save = true) {
  const viewName = validViews.has(name) ? name : "workspace";
  $$(".function-tab").forEach((tab) => {
    const active = tab.dataset.view === viewName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  if (save) localStorage.setItem(VIEW_KEY, viewName);
  if (viewName === "history") renderHistory();
  if (viewName === "settings") syncThemeChoices();
}

function onTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = $$(".function-tab");
  const current = tabs.indexOf(event.currentTarget);
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = tabs.length - 1;
  tabs[next].focus();
  showView(tabs[next].dataset.view);
}

async function selectCurrentTab() {
  setBusy($("#selectTabButton"), true, "Checking this page…");
  const active = await send({ type: "GET_ACTIVE_TAB" });
  if (!active.ok) { toast(active.error.message); setPageStatus("error", "Not available"); setBusy($("#selectTabButton"), false, "Use the page I’m looking at"); return; }
  const granted = await requestOriginPermission(active.tab.url);
  const access = granted ? await send({ type: "REQUEST_SITE_ACCESS", tab: active.tab }) : { ok: false, granted: false, error: { message: "You did not give BrowserCrew access to this site. Nothing was read." } };
  setBusy($("#selectTabButton"), false, "Use the page I’m looking at");
  if (!access.ok || !access.granted) { toast(access.error?.message || "Site access was not granted."); setPageStatus("warn", "Permission needed"); return; }
  state.selectedTab = active.tab;
  $("#selectedTabSummary").hidden = false;
  $("#selectedTabSummary").textContent = `✓ Ready: ${active.tab.title} — ${new URL(active.tab.url).hostname}`;
  setPageStatus("ok", "Ready");
}

async function testConnection() {
  const settings = collectSettings();
  const secret = secretForRequest();
  const box = $("#connectionResult");
  setBusy($("#testConnectionButton"), true, "Testing connection…");
  box.hidden = true;
  const permissionGranted = await requestOriginPermission(settings.baseUrl);
  if (!permissionGranted) {
    setBusy($("#testConnectionButton"), false, "Test this AI connection");
    box.hidden = false; box.className = "connection-result error"; box.textContent = "Connection not tested because Chrome access to this AI address was not approved."; setAiStatus("warn", "Permission needed"); return;
  }
  await send({ type: "SAVE_SETTINGS", settings, secret });
  const response = await send({ type: "TEST_PROVIDER", settings, secret });
  setBusy($("#testConnectionButton"), false, "Test this AI connection");
  box.hidden = false;
  if (response.ok) {
    state.lastConnectionOk = true;
    state.hasSecret = presets[state.providerKind].needsKey ? Boolean($("#apiKeyInput").value || state.hasSecret) : false;
    box.className = "connection-result success";
    box.textContent = `✓ Connected. ${response.model} answered in about ${response.latencyMs} ms.`;
    setAiStatus("ok", "Connected"); toast("AI connection works.");
  } else {
    state.lastConnectionOk = false; box.className = "connection-result error";
    box.textContent = `Could not connect: ${response.error.message}`;
    setAiStatus("error", "Connection failed");
  }
}

async function runJob() {
  if (!state.selectedTab) { toast("Choose the page you want BrowserCrew to read first."); return; }
  const goal = $("#goalInput").value.trim();
  if (!goal) { toast("Tell BrowserCrew what you want it to find."); return; }
  const settings = collectSettings();
  const secret = secretForRequest();
  if (!(await requestOriginPermission(state.selectedTab.url))) { toast("This job needs access to the selected page. Approve Chrome's permission prompt to continue."); return; }
  if (!(await requestOriginPermission(settings.baseUrl))) { toast("This job needs access to your selected AI service. Open Connect AI, test it, and approve Chrome's permission prompt."); return; }
  await send({ type: "SAVE_SETTINGS", settings, secret });
  showRunState("running");
  setProgress(0);
  setBusy($("#runButton"), true, "Job is running…");

  const timer1 = setTimeout(() => setProgress(1), 350);
  const timer2 = setTimeout(() => setProgress(2), 900);
  const response = await send({ type: "RUN_TASK", payload: { goal, tab: state.selectedTab, settings, secret } });
  clearTimeout(timer1); clearTimeout(timer2);
  setBusy($("#runButton"), false, "Start this read-only job");

  if (response.task?.id) state.currentTaskId = response.task.id;
  if (response.ok) {
    setProgress(3); showRunState("completed"); renderResult(response.task); toast("Job finished and evidence was saved.");
  } else {
    showRunState(response.task?.status || "failed");
    toast(response.error?.message || "The job could not finish.");
  }
  await renderHistory();
}

function setProgress(index) {
  const steps = ["Check permission for the selected page", "Read a bounded text snapshot", "Ask your selected AI to extract the facts", "Verify the answer and save evidence"];
  $("#progressList").innerHTML = steps.map((step, i) => `<li class="${i < index ? "is-done" : i === index ? "is-active" : ""}">${escapeHtml(step)}</li>`).join("");
}

function showRunState(status) {
  $("#runCard").hidden = false;
  const map = {
    running:["Working on this page…","Running"], completed:["Job finished","Completed"],
    paused:["Job paused","Paused"], cancelled:["Job stopped","Stopped"], failed:["Job could not finish","Failed"]
  };
  const [title,badge] = map[status] || map.failed;
  $("#runTitle").textContent = title; $("#runBadge").textContent = badge;
}

function renderResult(task) {
  const result = task.result;
  if (!result) return;
  $("#resultCard").hidden = false;
  const rows = [["Product", result.values.productName || "Not found"],["Price", result.values.price || "Not found"],["Notes", result.values.notes || "None"]];
  $("#resultGrid").innerHTML = rows.map(([label,value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  const verification = result.evidence.verification.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  $("#evidenceBox").innerHTML = `<strong>Evidence</strong><p>Read from <a href="${escapeAttr(result.evidence.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(result.evidence.pageTitle)}</a>.</p><ul>${verification}</ul>`;
}

async function controlJob(type) {
  if (!state.currentTaskId) { toast("There is no running job to control."); return; }
  const response = await send({ type, taskId: state.currentTaskId });
  if (response.ok) { showRunState(response.task.status); toast(response.task.status === "paused" ? "Job paused. No new step will start." : "Job stopped. No new step will start."); }
}

async function renderHistory() {
  const response = await send({ type: "GET_TASKS" });
  const list = $("#historyList");
  if (!response.ok || !response.tasks.length) { list.innerHTML = `<div class="empty">No saved jobs yet. Your first completed or interrupted job will appear here.</div>`; return; }
  list.innerHTML = response.tasks.slice(0,30).map((task) => `<article class="history-item"><strong>${escapeHtml(task.goal)}</strong><p>Status: ${escapeHtml(prettyStatus(task.status))}</p><p>${escapeHtml(task.selectedResource?.title || task.selectedResource?.url || "Unknown page")}</p><time datetime="${escapeAttr(task.updatedAt)}">${escapeHtml(new Date(task.updatedAt).toLocaleString())}</time></article>`).join("");
}

async function requestOriginPermission(urlText) {
  try {
    const url = new URL(urlText);
    const pattern = `${url.origin}/*`;
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return true;
    return chrome.permissions.request({ origins: [pattern] });
  } catch {
    toast("That address is not valid. Check it and try again.");
    return false;
  }
}

function chooseProvider(kind, overwrite = false) {
  state.providerKind = kind;
  $$(".provider-card").forEach((card) => { const selected = card.dataset.provider === kind; card.classList.toggle("is-selected", selected); card.setAttribute("aria-checked", String(selected)); });
  const preset = presets[kind];
  if (overwrite) {
    $("#modelInput").value = preset.model; $("#serverInput").value = preset.baseUrl; $("#apiKeyInput").value = "";
    state.lastConnectionOk = false; setAiStatus("idle", "Not tested");
  }
  $("#apiKeyGroup").hidden = !preset.needsKey;
}

function applySettings(settings, hasSecret) {
  state.hasSecret = Boolean(hasSecret);
  chooseProvider(settings.kind || "openai", false);
  $("#modelInput").value = settings.model || presets[state.providerKind].model;
  $("#serverInput").value = settings.baseUrl || presets[state.providerKind].baseUrl;
  if (hasSecret) $("#apiKeyInput").placeholder = "Saved for this Chrome session";
}

function collectSettings() { return { kind: state.providerKind, model: $("#modelInput").value.trim(), baseUrl: $("#serverInput").value.trim() }; }
function secretForRequest() {
  if (!presets[state.providerKind].needsKey) return "";
  const typed = $("#apiKeyInput").value;
  return typed.length ? typed : undefined;
}
function setAiStatus(stateName,label) { const el=$("#aiStatus"); el.dataset.state=stateName; el.querySelector(".status-label").textContent=label; }
function setPageStatus(stateName,label) { const el=$("#pageStatus"); el.dataset.state=stateName; el.querySelector(".status-label").textContent=label; }
function setBusy(button,busy,label) { button.disabled=busy; button.textContent=label; }
function prettyStatus(status) { return String(status || "unknown").replaceAll("_"," ").replace(/^./,(c)=>c.toUpperCase()); }
function toast(message) { const el=$("#toast"); el.textContent=message; el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>{el.hidden=true;},3500); }
function send(message) { return chrome.runtime.sendMessage(message); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }
function escapeAttr(value) { return escapeHtml(value); }

function restoreTheme() { applyThemePreference(localStorage.getItem(THEME_KEY) || "system"); }
function setThemePreference(preference) { localStorage.setItem(THEME_KEY, preference); applyThemePreference(preference); syncThemeChoices(); }
function applyThemePreference(preference) {
  const effective = preference === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = effective === "dark" ? "dark" : "light";
}
function syncThemeChoices() {
  const current = localStorage.getItem(THEME_KEY) || "system";
  $$("[data-theme-choice]").forEach((button) => {
    const selected = button.dataset.themeChoice === current;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setThemePreference(next);
}
