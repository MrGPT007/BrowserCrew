const C5_PORT = "browsercrew-chat-c5";
const c5Ui = { port: null, pending: new Map(), requestId: 0, state: null, currentRunId: null };

installC5Surface();
document.addEventListener("DOMContentLoaded", initC5Ui);

function installC5Surface() {
  if (document.querySelector("#c5Card")) return;
  const anchor = document.querySelector("#mcpChatCard") || document.querySelector("#chatToolsCard") || document.querySelector(".chat-context-card");
  if (!anchor) return;
  const card = document.createElement("article");
  card.className = "card c5-card";
  card.id = "c5Card";
  card.innerHTML = `
    <div class="card-heading">
      <div><p class="step-label">COMPARE OR HAND OFF</p><h2>Ask another AI, with limits</h2></div>
      <span class="badge badge-safe">Bounded</span>
    </div>
    <p class="helper">Use only AI connections you already saved. BrowserCrew shows exactly where the chat context will go and waits for your approval before another provider receives it.</p>

    <label class="field-label" for="c5Mode">What do you want to do?</label>
    <select id="c5Mode">
      <option value="compare">Compare two AIs</option>
      <option value="specialist">Hand off to another AI</option>
    </select>
    <p class="helper" id="c5ModeHelp">Compare sends the same bounded saved-chat text and your instruction to the current AI and one other AI. Maximum: 2 AI calls, 0 tool calls, 1 compare transfer.</p>

    <label class="field-label" for="c5Target">Second AI connection</label>
    <select id="c5Target"><option value="">Choose another connected AI</option></select>
    <p class="helper" id="c5TargetHelp">Only saved connections with Connected status appear here.</p>

    <label class="field-label" for="c5Instruction">What should the AIs do?</label>
    <textarea id="c5Instruction" rows="3" maxlength="4000" placeholder="Example: Compare your recommendations and focus on the trade-offs that matter most."></textarea>
    <p class="helper">This instruction is included only after you approve the transfer review below.</p>

    <button class="button button-primary tactile full" id="c5ReviewButton" type="button">Review what will be sent</button>
    <div class="c5-review" id="c5Review" hidden aria-live="polite"></div>
    <div class="c5-results" id="c5Results" hidden aria-live="polite"></div>
    <div class="c5-status-row"><span id="c5Status">Ready</span><button class="button button-danger button-small tactile" id="c5StopButton" type="button" hidden>Stop compare / handoff</button></div>`;
  anchor.after(card);

  if (!document.querySelector('link[href="src/styles/chat-c5.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "src/styles/chat-c5.css";
    document.head.append(css);
  }
}

function initC5Ui() {
  connectC5Port();
  document.querySelector("#c5Mode")?.addEventListener("change", updateModeCopy);
  document.querySelector("#c5ReviewButton")?.addEventListener("click", prepareC5Run);
  document.querySelector("#c5Review")?.addEventListener("click", onReviewClick);
  document.querySelector("#c5StopButton")?.addEventListener("click", stopC5Run);
  document.querySelector("#chatNewButton")?.addEventListener("click", clearC5Draft);
  document.querySelector("#chatConversationSelect")?.addEventListener("change", clearC5Draft);
  updateModeCopy();
}

function connectC5Port() {
  try { c5Ui.port?.disconnect(); } catch {}
  const port = chrome.runtime.connect({ name: C5_PORT });
  c5Ui.port = port;
  port.onMessage.addListener(onC5Message);
  port.onDisconnect.addListener(() => {
    if (c5Ui.port === port) {
      c5Ui.port = null;
      setStatus("Compare / handoff connection restarted. Reopen Chat if a run did not finish.");
      setTimeout(connectC5Port, 300);
    }
  });
  rpc("GET_C5_STATE").catch(() => {});
}

function onC5Message(message) {
  if (!message) return;
  if (message.requestId && c5Ui.pending.has(message.requestId)) {
    const pending = c5Ui.pending.get(message.requestId);
    c5Ui.pending.delete(message.requestId);
    if (message.ok === false && message.type === "C5_ERROR") pending.reject(new Error(message.error?.message || "The compare or handoff request failed."));
    else pending.resolve(message);
  }
  if (message.type === "C5_STATE") {
    c5Ui.state = message;
    renderTargetConnections();
    restoreLatestRun();
  }
  if (message.type === "C5_PREVIEW_READY" && message.preview) {
    c5Ui.currentRunId = message.preview.runId;
    renderReview(message.preview);
    setStatus("Waiting for your approval. No new AI request has started.");
  }
  if (message.type === "C5_RUN_STARTED") {
    c5Ui.currentRunId = message.run?.id || c5Ui.currentRunId;
    setRunning(true);
    setStatus("Approved. BrowserCrew is staying inside the shown run limits.");
  }
  if (message.type === "C5_RESULT" && message.run) renderResults(message.run);
  if (message.type === "C5_RUN_DONE" && message.run) {
    c5Ui.currentRunId = message.run.id;
    setRunning(false);
    hideReview();
    renderResults(message.run);
    if (message.ok) setStatus(message.run.mode === "compare" ? "Comparison complete." : "Specialist handoff complete.");
    else if (message.stopped) setStatus("Stopped. BrowserCrew did not start another model step.");
    else if (message.budgetExhausted) setStatus("Run limit reached. BrowserCrew blocked another dispatch.");
    else setStatus(message.error?.message || "Could not finish safely.");
  }
}

async function prepareC5Run() {
  const mode = document.querySelector("#c5Mode")?.value || "compare";
  const targetConnectionId = document.querySelector("#c5Target")?.value || "";
  const instruction = document.querySelector("#c5Instruction")?.value.trim() || "";
  const conversationId = document.querySelector("#chatConversationSelect")?.value || null;
  if (!targetConnectionId) return notifyC5("Choose the second AI connection first.");
  if (!instruction) return notifyC5("Describe what you want the AIs to compare or what the specialist should do.");
  setReviewBusy(true);
  try {
    const response = await rpc("PREPARE_C5_RUN", { payload: { mode, targetConnectionId, instruction, conversationId } });
    c5Ui.currentRunId = response.preview?.runId || response.run?.id || null;
    if (response.preview) renderReview(response.preview);
  } catch (error) {
    notifyC5(error.message || "BrowserCrew could not prepare that compare or handoff.");
  } finally { setReviewBusy(false); }
}

async function onReviewClick(event) {
  const button = event.target.closest("button[data-c5-action]");
  if (!button || !c5Ui.currentRunId) return;
  button.disabled = true;
  if (button.dataset.c5Action === "cancel") {
    try { await rpc("CANCEL_C5_RUN", { runId: c5Ui.currentRunId }); hideReview(); setStatus("Cancelled before any new AI received the transfer."); }
    catch (error) { notifyC5(error.message); button.disabled = false; }
    return;
  }
  button.textContent = "Running within limits…";
  setRunning(true);
  rpc("APPROVE_C5_RUN", { runId: c5Ui.currentRunId }).catch((error) => {
    setRunning(false);
    notifyC5(error.message || "BrowserCrew could not finish that run safely.");
  });
}

async function stopC5Run() {
  if (!c5Ui.currentRunId) return;
  const button = document.querySelector("#c5StopButton");
  button.disabled = true;
  try {
    await rpc("STOP_C5_RUN", { runId: c5Ui.currentRunId });
    setStatus("Stop recorded. BrowserCrew will not start another model dispatch for this run.");
  } catch (error) { notifyC5(error.message); }
}

function renderTargetConnections() {
  const select = document.querySelector("#c5Target");
  if (!select || !c5Ui.state) return;
  const previous = select.value;
  const choices = (c5Ui.state.connections || []).filter((item) => item.id !== c5Ui.state.activeId && item.status === "connected");
  select.innerHTML = '<option value="">Choose another connected AI</option>' + choices.map((item) => `<option value="${escapeAttribute(item.id)}">${escapeHtml(item.name)} — ${escapeHtml(item.model)} · ${escapeHtml(safeHost(item.destination))}</option>`).join("");
  if (choices.some((item) => item.id === previous)) select.value = previous;
  const active = (c5Ui.state.connections || []).find((item) => item.id === c5Ui.state.activeId);
  const help = document.querySelector("#c5TargetHelp");
  if (help) help.textContent = active ? `Current AI: ${active.name} — ${active.model}. Choose a different Connected destination.` : "Choose and test an AI connection in Connect AI first.";
}

function renderReview(preview) {
  const box = document.querySelector("#c5Review");
  if (!box) return;
  const budget = preview.policy?.budget || {};
  box.hidden = false;
  box.innerHTML = `
    <div class="c5-review-head"><div><p class="step-label">CHECK BEFORE SENDING</p><h3>${preview.mode === "compare" ? "Compare across two destinations?" : "Send this chat context to another AI?"}</h3></div><span class="badge badge-warning">Approval required</span></div>
    <p>${escapeHtml(preview.disclosure)}</p>
    <div class="c5-destinations">
      <div><small>${preview.mode === "compare" ? "AI 1" : "Current AI"}</small><strong>${escapeHtml(preview.source.name)} · ${escapeHtml(preview.source.model)}</strong><span>${escapeHtml(preview.source.destination)}</span></div>
      <div><small>${preview.mode === "compare" ? "AI 2" : "Destination"}</small><strong>${escapeHtml(preview.target.name)} · ${escapeHtml(preview.target.model)}</strong><span>${escapeHtml(preview.target.destination)}</span></div>
    </div>
    <dl class="c5-context-summary">
      <div><dt>Saved chat messages</dt><dd>${Number(preview.context.messageCount || 0)}</dd></div>
      <div><dt>Chat characters</dt><dd>${Number(preview.context.characters || 0).toLocaleString()}</dd></div>
      <div><dt>Maximum AI calls</dt><dd>${Number(budget.modelCalls?.max || 0)}</dd></div>
      <div><dt>Maximum tool calls</dt><dd>${Number(budget.toolCalls?.max || 0)}</dd></div>
      <div><dt>Maximum transfers</dt><dd>${Number(budget.handoffs?.max || 0)}</dd></div>
    </dl>
    <div class="example-box">🔒 ${escapeHtml(preview.excluded)}</div>
    <div class="warning-box">Approving sends only the bounded context described above. BrowserCrew will not silently switch your active AI, enable tools, or send page/file contents as part of this C5 transfer.</div>
    <div class="button-row"><button class="button tactile" type="button" data-c5-action="cancel">Cancel</button><button class="button button-primary tactile" type="button" data-c5-action="approve">Approve and run</button></div>`;
}

function renderResults(run) {
  const box = document.querySelector("#c5Results");
  if (!box) return;
  const results = Array.isArray(run.results) ? run.results : [];
  if (!results.length && !run.error) { box.hidden = true; return; }
  box.hidden = false;
  const cards = results.map((result) => `<article class="c5-result-card"><div class="c5-result-head"><strong>${escapeHtml(result.connectionName || result.model)}</strong><span>${escapeHtml(result.model || "AI model")}</span></div><p>${escapeHtml(result.text || "")}</p><small>Destination: ${escapeHtml(result.destination || "approved connection")}</small></article>`).join("");
  const limits = run.policy?.budget || {};
  const receipt = `<div class="c5-receipt"><strong>Run receipt</strong><span>AI calls ${limits.modelCalls?.used || 0}/${limits.modelCalls?.max || 0} · tools ${limits.toolCalls?.used || 0}/${limits.toolCalls?.max || 0} · transfers ${limits.handoffs?.used || 0}/${limits.handoffs?.max || 0}</span></div>`;
  const error = run.error ? `<div class="warning-box">${escapeHtml(run.error.message || "The run stopped safely.")}</div>` : "";
  box.innerHTML = `${cards}${error}${receipt}`;
}

function restoreLatestRun() {
  const run = c5Ui.state?.runs?.[0];
  if (!run) return;
  if (["running", "awaiting_approval"].includes(run.status)) c5Ui.currentRunId = run.id;
  if (run.status === "awaiting_approval") {
    setStatus("A reviewed transfer is waiting for approval. Prepare it again if the review card is not visible.");
  } else if (run.results?.length || run.error) {
    renderResults(run);
  }
}

function updateModeCopy() {
  const mode = document.querySelector("#c5Mode")?.value || "compare";
  const help = document.querySelector("#c5ModeHelp");
  const label = document.querySelector('label[for="c5Instruction"]');
  const textarea = document.querySelector("#c5Instruction");
  if (mode === "specialist") {
    if (help) help.textContent = "Hand off sends bounded saved-chat text and your instruction to one other connected AI. Maximum: 1 AI call, 0 tool calls, 1 handoff.";
    if (label) label.textContent = "What should the specialist AI do?";
    if (textarea) textarea.placeholder = "Example: Review this conversation as a security specialist and identify the three highest-risk assumptions.";
  } else {
    if (help) help.textContent = "Compare sends the same bounded saved-chat text and your instruction to the current AI and one other AI. Maximum: 2 AI calls, 0 tool calls, 1 compare transfer.";
    if (label) label.textContent = "What should the AIs compare?";
    if (textarea) textarea.placeholder = "Example: Compare your recommendations and focus on the trade-offs that matter most.";
  }
}

function clearC5Draft() {
  c5Ui.currentRunId = null;
  hideReview();
  const results = document.querySelector("#c5Results");
  if (results) { results.hidden = true; results.replaceChildren(); }
  setRunning(false);
  setStatus("Ready");
}

function hideReview() {
  const box = document.querySelector("#c5Review");
  if (box) { box.hidden = true; box.replaceChildren(); }
}

function setRunning(running) {
  const stop = document.querySelector("#c5StopButton");
  const review = document.querySelector("#c5ReviewButton");
  if (stop) { stop.hidden = !running; stop.disabled = false; }
  if (review) review.disabled = running;
}

function setReviewBusy(busy) {
  const button = document.querySelector("#c5ReviewButton");
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? "Preparing review…" : "Review what will be sent";
}

function setStatus(text) {
  const node = document.querySelector("#c5Status");
  if (node) node.textContent = text;
}

function rpc(type, payload = {}) {
  if (!c5Ui.port) return Promise.reject(new Error("Compare / handoff connection is restarting. Try again."));
  const requestId = `c5-ui-${Date.now()}-${++c5Ui.requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c5Ui.pending.delete(requestId); reject(new Error("BrowserCrew did not receive a compare / handoff reply in time.")); }, 70000);
    c5Ui.pending.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    c5Ui.port.postMessage({ type, requestId, ...payload });
  });
}

function notifyC5(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notifyC5.timer);
  notifyC5.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function safeHost(value) { try { return new URL(value).host; } catch { return "unknown destination"; } }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value); }
