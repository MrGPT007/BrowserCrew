const AGENT_PORT = "browsercrew-agent";
const CONNECTIONS_KEY = "browsercrew.connections.v1";

const agentUiState = {
  port: null,
  pendingRpc: new Map(),
  runs: [],
  currentRunId: null,
  pendingPreview: null,
  connections: []
};

installAgentConsole();
document.addEventListener("DOMContentLoaded", initAgentConsole);

function installAgentConsole() {
  if (document.querySelector("#agentCompareCard")) return;
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "src/styles/agent-console.css";
  document.head.append(style);

  const card = document.createElement("article");
  card.className = "card agent-compare-card";
  card.id = "agentCompareCard";
  card.innerHTML = `
    <div class="card-heading agent-heading">
      <div>
        <p class="step-label">MULTI-MODEL</p>
        <h2>Compare two AIs safely</h2>
      </div>
      <span class="badge badge-safe">Bounded</span>
    </div>
    <p class="helper">Use two AI connections you already tested. BrowserCrew shows both destinations and the transfer boundary before anything is sent.</p>

    <label class="field-label" for="agentMode">How should the second AI help?</label>
    <select id="agentMode">
      <option value="compare">Compare independently</option>
      <option value="specialist">Review the first AI as a specialist</option>
    </select>
    <p class="helper" id="agentModeHelp">Both AIs get the same question independently. They do not receive each other’s answer.</p>

    <div class="agent-model-grid">
      <div>
        <label class="field-label" for="agentPrimaryConnection">First AI</label>
        <select id="agentPrimaryConnection"></select>
      </div>
      <div>
        <label class="field-label" for="agentSecondaryConnection">Second AI</label>
        <select id="agentSecondaryConnection"></select>
      </div>
    </div>

    <label class="field-label" for="agentPrompt">Question for this multi-model run</label>
    <textarea id="agentPrompt" rows="4" maxlength="12000" placeholder="Example: Compare these two approaches and recommend the safer option."></textarea>
    <div class="agent-budget-strip" aria-label="Run limits">
      <span><strong>2</strong> model calls max</span>
      <span><strong>0</strong> tools</span>
      <span><strong>1</strong> cross-model handoff max</span>
    </div>
    <p class="helper">This C5 workflow never sends current-chat history, page text, attachments, MCP results, browser cookies, or secret keys. Use normal Chat controls separately when you want those contexts.</p>

    <div class="button-row">
      <button class="button tactile" id="agentHistoryButton" type="button">Past runs</button>
      <button class="button button-primary tactile" id="agentReviewButton" type="button">Review destinations</button>
      <button class="button button-danger tactile" id="agentStopButton" type="button" hidden>Stop run</button>
    </div>
    <div class="status-box" id="agentStatus" hidden></div>

    <section class="agent-results" id="agentResults" hidden>
      <div class="agent-result-card">
        <p class="step-label">FIRST AI</p>
        <strong id="agentPrimaryResultTitle">Waiting</strong>
        <div class="agent-result-text" id="agentPrimaryResult"></div>
      </div>
      <div class="agent-result-card">
        <p class="step-label">SECOND AI</p>
        <strong id="agentSecondaryResultTitle">Waiting</strong>
        <div class="agent-result-text" id="agentSecondaryResult"></div>
      </div>
    </section>

    <details class="agent-activity">
      <summary>Multi-model activity</summary>
      <p class="helper">Shows dispatches, limits, handoffs, stops, and verification. It never shows private hidden chain-of-thought.</p>
      <ol id="agentActivityList"></ol>
    </details>
  `;

  const connectionCard = document.querySelector(".chat-connection-card");
  if (connectionCard) connectionCard.insertAdjacentElement("afterend", card);
  else document.querySelector("#view-chat")?.append(card);

  const review = document.createElement("div");
  review.className = "agent-review-backdrop";
  review.id = "agentReviewDialog";
  review.hidden = true;
  review.innerHTML = `
    <section class="agent-review-card" role="dialog" aria-modal="true" aria-labelledby="agentReviewTitle">
      <p class="eyebrow">CHECK BEFORE SENDING</p>
      <h2 id="agentReviewTitle">Send this question to two AIs?</h2>
      <div id="agentReviewDestinations"></div>
      <div class="warning-box" id="agentReviewContext"></div>
      <div class="agent-review-budget">
        <strong>Hard limits for this run</strong>
        <span>2 model calls maximum</span>
        <span>0 tool calls</span>
        <span>1 cross-model handoff maximum</span>
      </div>
      <p class="helper">Stop is checked before every new model or handoff dispatch. BrowserCrew will not silently switch to another provider.</p>
      <div class="button-row">
        <button class="button tactile" id="agentCancelReviewButton" type="button">Go back</button>
        <button class="button button-primary tactile" id="agentApproveRunButton" type="button">Start approved run</button>
      </div>
    </section>
  `;
  document.body.append(review);
}

function initAgentConsole() {
  connectAgentPort();
  bindAgentUi();
  refreshAgentConnections();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CONNECTIONS_KEY]) refreshAgentConnections();
  });
  installAgentCommandBridge();
}

function bindAgentUi() {
  document.querySelector("#agentMode")?.addEventListener("change", updateAgentModeHelp);
  document.querySelector("#agentReviewButton")?.addEventListener("click", reviewAgentRun);
  document.querySelector("#agentStopButton")?.addEventListener("click", stopAgentRun);
  document.querySelector("#agentHistoryButton")?.addEventListener("click", showLatestAgentRun);
  document.querySelector("#agentCancelReviewButton")?.addEventListener("click", closeAgentReview);
  document.querySelector("#agentApproveRunButton")?.addEventListener("click", approveAgentRun);
  document.querySelector("#agentReviewDialog")?.addEventListener("click", (event) => {
    if (event.target.id === "agentReviewDialog") closeAgentReview();
  });
}

function connectAgentPort() {
  agentUiState.port = chrome.runtime.connect({ name: AGENT_PORT });
  agentUiState.port.onMessage.addListener(onAgentMessage);
  agentUiState.port.onDisconnect.addListener(() => {
    for (const pending of agentUiState.pendingRpc.values()) pending.reject(new Error("Multi-model connection restarted."));
    agentUiState.pendingRpc.clear();
    setAgentStatus("BrowserCrew restarted the multi-model connection. Reopen Chat to refresh the run.", "warning");
    setTimeout(connectAgentPort, 300);
  });
  rpc("GET_AGENT_STATE").catch((error) => setAgentStatus(error.message, "error"));
}

function onAgentMessage(message) {
  if (!message) return;
  if (message.requestId && agentUiState.pendingRpc.has(message.requestId)) {
    const pending = agentUiState.pendingRpc.get(message.requestId);
    agentUiState.pendingRpc.delete(message.requestId);
    if (message.ok === false && message.type === "AGENT_ERROR") pending.reject(new Error(message.error?.message || "Multi-model request failed."));
    else pending.resolve(message);
  }
  if (Array.isArray(message.runs)) {
    agentUiState.runs = message.runs;
    if (!agentUiState.currentRunId && agentUiState.runs[0]) agentUiState.currentRunId = agentUiState.runs[0].id;
    renderCurrentAgentRun();
  }
  if (message.run) {
    upsertAgentRun(message.run);
    agentUiState.currentRunId = message.run.id;
    renderCurrentAgentRun();
  }
}

async function refreshAgentConnections() {
  const stored = await chrome.storage.local.get(CONNECTIONS_KEY);
  agentUiState.connections = Array.isArray(stored[CONNECTIONS_KEY]) ? stored[CONNECTIONS_KEY] : [];
  renderAgentConnectionSelects();
}

function renderAgentConnectionSelects() {
  const connected = agentUiState.connections.filter((item) => item.status === "connected");
  const primary = document.querySelector("#agentPrimaryConnection");
  const secondary = document.querySelector("#agentSecondaryConnection");
  if (!primary || !secondary) return;
  const previousPrimary = primary.value;
  const previousSecondary = secondary.value;
  primary.replaceChildren();
  secondary.replaceChildren();

  if (connected.length < 2) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Connect and test at least two AIs first";
    primary.append(option.cloneNode(true));
    secondary.append(option);
    document.querySelector("#agentReviewButton").disabled = true;
    return;
  }

  for (const profile of connected) {
    for (const select of [primary, secondary]) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name} — ${profile.model} · ${safeHost(profile.baseUrl)}`;
      select.append(option);
    }
  }
  primary.value = connected.some((item) => item.id === previousPrimary) ? previousPrimary : connected[0].id;
  secondary.value = connected.some((item) => item.id === previousSecondary && item.id !== primary.value)
    ? previousSecondary
    : connected.find((item) => item.id !== primary.value)?.id || connected[1].id;
  document.querySelector("#agentReviewButton").disabled = false;
}

function updateAgentModeHelp() {
  const mode = document.querySelector("#agentMode")?.value;
  document.querySelector("#agentModeHelp").textContent = mode === "specialist"
    ? "The first AI gets your question. After it answers, the second AI receives your question plus the first answer for a bounded second opinion."
    : "Both AIs get the same question independently. They do not receive each other’s answer.";
}

async function reviewAgentRun() {
  const prompt = document.querySelector("#agentPrompt")?.value.trim();
  const primaryId = document.querySelector("#agentPrimaryConnection")?.value;
  const secondaryId = document.querySelector("#agentSecondaryConnection")?.value;
  const mode = document.querySelector("#agentMode")?.value || "compare";
  if (!prompt) {
    setAgentStatus("Type the question you want the two AIs to work on.", "warning");
    document.querySelector("#agentPrompt")?.focus();
    return;
  }
  if (!primaryId || !secondaryId || primaryId === secondaryId) {
    setAgentStatus("Choose two different connected AI profiles.", "warning");
    return;
  }
  setAgentStatus("Preparing the destination review…", "info");
  try {
    const response = await rpc("PREVIEW_AGENT_RUN", {
      payload: {
        mode,
        prompt,
        primaryId,
        secondaryId,
        budgets: { modelCalls: 2, toolCalls: 0, handoffs: 1 }
      }
    });
    agentUiState.pendingPreview = response.preview;
    renderAgentReview(response.preview);
  } catch (error) {
    setAgentStatus(error.message, "error");
  }
}

function renderAgentReview(preview) {
  const destinations = document.querySelector("#agentReviewDestinations");
  destinations.replaceChildren(
    reviewDestination("First AI", preview.primary),
    reviewDestination(preview.mode === "specialist" ? "Specialist reviewer" : "Second AI", preview.secondary)
  );
  document.querySelector("#agentReviewContext").textContent = `What crosses: ${preview.contextSummary} ${preview.dataBoundary}`;
  document.querySelector("#agentReviewDialog").hidden = false;
  document.querySelector("#agentApproveRunButton")?.focus();
}

function reviewDestination(label, profile) {
  const box = document.createElement("div");
  box.className = "agent-review-destination";
  const title = document.createElement("strong");
  title.textContent = `${label}: ${profile.name}`;
  const detail = document.createElement("span");
  detail.textContent = `${profile.model} · ${profile.destination}`;
  box.append(title, detail);
  return box;
}

function closeAgentReview() {
  document.querySelector("#agentReviewDialog").hidden = true;
  agentUiState.pendingPreview = null;
}

async function approveAgentRun() {
  const preview = agentUiState.pendingPreview;
  if (!preview) return closeAgentReview();
  const button = document.querySelector("#agentApproveRunButton");
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    const response = await rpc("START_AGENT_RUN", {
      approvalId: preview.approvalId,
      planDigest: preview.planDigest
    });
    agentUiState.pendingPreview = null;
    document.querySelector("#agentReviewDialog").hidden = true;
    if (response.run) {
      upsertAgentRun(response.run);
      agentUiState.currentRunId = response.run.id;
      renderCurrentAgentRun();
    }
    setAgentStatus("Approved run started. BrowserCrew will stop automatically at the displayed limits.", "success");
  } catch (error) {
    setAgentStatus(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Start approved run";
  }
}

async function stopAgentRun() {
  const run = currentAgentRun();
  if (!run || !["running", "stopping"].includes(run.status)) return;
  try {
    await rpc("STOP_AGENT_RUN", { runId: run.id });
    setAgentStatus("Stop recorded. BrowserCrew will not start another model or handoff step.", "warning");
  } catch (error) {
    setAgentStatus(error.message, "error");
  }
}

function showLatestAgentRun() {
  if (!agentUiState.runs.length) {
    setAgentStatus("No multi-model runs have been saved yet.", "info");
    return;
  }
  agentUiState.currentRunId = agentUiState.runs[0].id;
  renderCurrentAgentRun();
  document.querySelector("#agentResults")?.scrollIntoView({ block: "nearest" });
}

function renderCurrentAgentRun() {
  const run = currentAgentRun();
  const results = document.querySelector("#agentResults");
  const stop = document.querySelector("#agentStopButton");
  if (!run) {
    if (results) results.hidden = true;
    if (stop) stop.hidden = true;
    return;
  }

  if (results) results.hidden = false;
  if (stop) stop.hidden = !["running", "stopping"].includes(run.status);
  document.querySelector("#agentPrimaryResultTitle").textContent = `${run.primary?.name || "First AI"} · ${run.primary?.model || ""}`;
  document.querySelector("#agentSecondaryResultTitle").textContent = `${run.secondary?.name || "Second AI"} · ${run.secondary?.model || ""}`;
  document.querySelector("#agentPrimaryResult").textContent = run.results?.primary?.text || statusPlaceholder(run, "primary");
  document.querySelector("#agentSecondaryResult").textContent = run.results?.secondary?.text || statusPlaceholder(run, "secondary");

  const list = document.querySelector("#agentActivityList");
  list.replaceChildren();
  for (const event of run.activity || []) {
    const item = document.createElement("li");
    const summary = document.createElement("span");
    summary.textContent = event.summary;
    const time = document.createElement("time");
    time.textContent = shortTime(event.at);
    item.append(time, summary);
    list.append(item);
  }

  const budget = run.budgets || {};
  const usage = run.usage || {};
  const text = run.status === "completed"
    ? `✓ Completed inside limits: ${usage.modelCalls}/${budget.modelCalls} model calls, ${usage.toolCalls}/${budget.toolCalls} tools, ${usage.handoffs}/${budget.handoffs} handoffs.`
    : run.status === "budget_exhausted"
      ? `Stopped at the declared budget. ${run.error?.message || "No further dispatch was allowed."}`
      : run.status === "stopped"
        ? "Stopped. No further model or handoff dispatch was allowed."
        : run.status === "interrupted"
          ? "Interrupted by a BrowserCrew restart. The run was not replayed automatically."
          : run.status === "failed"
            ? (run.error?.message || "This run could not finish.")
            : `Running · ${usage.modelCalls}/${budget.modelCalls} model calls used.`;
  setAgentStatus(text, run.status === "completed" ? "success" : ["failed"].includes(run.status) ? "error" : "info");
}

function statusPlaceholder(run, slot) {
  if (run.status === "budget_exhausted" && slot === "secondary") return "Not contacted because the approved model-call or handoff budget was exhausted.";
  if (run.status === "stopped" && slot === "secondary") return "Not contacted after Stop was recorded.";
  if (run.status === "interrupted" && !run.results?.[slot]) return "Not replayed after BrowserCrew restarted.";
  return run.status === "running" || run.status === "stopping" ? "Working…" : "No answer was produced.";
}

function upsertAgentRun(run) {
  agentUiState.runs = [run, ...agentUiState.runs.filter((item) => item.id !== run.id)].slice(0, 30);
}

function currentAgentRun() {
  return agentUiState.runs.find((item) => item.id === agentUiState.currentRunId) || null;
}

function setAgentStatus(message, kind = "info") {
  const box = document.querySelector("#agentStatus");
  if (!box) return;
  box.hidden = false;
  box.className = `status-box status-${kind}`;
  box.textContent = message;
}

function rpc(type, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!agentUiState.port) return reject(new Error("Multi-model connection is not ready."));
    const requestId = crypto.randomUUID();
    agentUiState.pendingRpc.set(requestId, { resolve, reject });
    agentUiState.port.postMessage({ type, requestId, ...extra });
    setTimeout(() => {
      if (!agentUiState.pendingRpc.has(requestId)) return;
      agentUiState.pendingRpc.delete(requestId);
      reject(new Error("BrowserCrew did not answer the multi-model request in time."));
    }, 35000);
  });
}

function installAgentCommandBridge() {
  const search = document.querySelector("#commandSearch");
  const list = document.querySelector("#commandList");
  if (!search || !list) return;

  const addCommand = () => {
    const query = search.value.trim().toLowerCase();
    if (query && !"compare models specialist handoff multi model".includes(query)) return;
    if (list.querySelector("[data-agent-command='compare']")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-item tactile";
    button.dataset.agentCommand = "compare";
    button.setAttribute("role", "option");
    button.innerHTML = "<span><strong>Compare two models</strong><small>Multi-model</small></span>";
    button.addEventListener("click", openAgentFromCommand);
    list.append(button);
  };

  new MutationObserver(addCommand).observe(list, { childList: true });
  search.addEventListener("input", () => setTimeout(addCommand, 0));
  search.addEventListener("keydown", (event) => {
    const query = search.value.trim().toLowerCase();
    if (event.key === "Enter" && (query === "compare" || query === "compare models" || query === "specialist" || query === "handoff")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openAgentFromCommand();
    }
  }, true);
  setTimeout(addCommand, 0);
}

function openAgentFromCommand() {
  const palette = document.querySelector("#commandPalette");
  if (palette) palette.hidden = true;
  document.querySelector("#tab-chat")?.click();
  const card = document.querySelector("#agentCompareCard");
  card?.scrollIntoView({ block: "start", behavior: "smooth" });
  document.querySelector("#agentPrompt")?.focus();
}

function safeHost(value) {
  try { return new URL(value).host; } catch { return "unknown address"; }
}

function shortTime(value) {
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}
