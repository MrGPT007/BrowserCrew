import { csvCell } from './lib/policy.js';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const installed = !!globalThis.chrome?.runtime?.id;
let state = { tasks: [], provider: { kind: 'cloud', baseUrl: 'https://api.openai.com/v1', model: '' }, hasKey: false };
let selected = new Set(), openTabs = [], currentView = 'task', activeId, providerKind = 'cloud', lastActive = '';
const labels = { running: 'Working', awaiting_approval: 'Your review needed', paused: 'Paused', recovering: 'Check the page', completed: 'Results ready', partially_completed: 'Some work is unfinished', failed: 'Needs attention', cancelled: 'Stopped' };
const examples = {
  compare: ['research', 'Compare the product names and prices on my selected pages. Include an exact source quote for each fact. Explain any missing prices.', 'Product names and prices, with a source quote from every selected page.'],
  facts: ['research', 'Extract the main facts from my selected pages. Give each fact a clear label and an exact source quote. List any missing information.', 'Labeled facts and exact source quotes from every selected page.'],
  form: ['form', 'Prepare the inquiry form with these example details: name Alex Morgan, email alex@example.com, company Example Studio, message Please share your product catalog. Show me the changes before filling. Do not submit.', 'Fill only the provided contact details after I approve. Leave the form unsubmitted.']
};
async function send(type, rest = {}) {
  if (!installed) throw new Error('This is an interface preview. Load the extension in Chrome to connect your AI and work with tabs.');
  const response = await chrome.runtime.sendMessage({ type, ...rest });
  if (!response?.ok) throw new Error(response?.error || 'The browser did not respond. Reload BrowserCrew.');
  return response.value;
}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function view(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== 'view-' + name);
  document.querySelectorAll('.nav-item').forEach(el => { el.classList.toggle('selected', el.dataset.view === name); if (el.dataset.view === name) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = 'Workspace / ' + ({ task: 'New task', connect: 'Your AI', history: 'Saved tasks', active: 'Current task', about: 'What’s included' }[name]);
  notice('');
  if (name === 'history') renderHistory();
  if (name === 'active') renderActive();
  $('#main').focus({ preventScroll: true });
}
function theme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').setAttribute('aria-pressed', String(dark));
  $('#theme span').textContent = dark ? 'Use light colors' : 'Use dark colors';
  $('#theme').setAttribute('aria-label', dark ? 'Use light colors. Recommended for bright rooms.' : 'Use dark colors. Recommended for dim rooms.');
}
theme(localStorage.getItem('browsercrew-theme') === 'dark' || (!localStorage.getItem('browsercrew-theme') && matchMedia('(prefers-color-scheme: dark)').matches));
$('#theme').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; theme(dark); localStorage.setItem('browsercrew-theme', dark ? 'dark' : 'light'); };
function setProvider(kind) {
  providerKind = kind;
  document.querySelectorAll('[data-provider]').forEach(b => { b.classList.toggle('selected', b.dataset.provider === kind); b.setAttribute('aria-pressed', String(b.dataset.provider === kind)); });
  $('#server').value = kind === 'local' ? 'http://127.0.0.1:1234/v1' : 'https://api.openai.com/v1';
  $('#key-optional').textContent = kind === 'local' ? '(only if your model app requires one)' : '';
  $('#key').required = kind === 'cloud';
  $('#key').value = '';
}
function loadExample(which) {
  const [workflow, goal, criteria] = examples[which];
  $('#workflow').value = workflow; $('#goal').value = goal; $('#criteria').value = criteria; $('#goal').focus();
}
$('#example').onclick = () => loadExample($('#workflow').value === 'form' ? 'form' : 'compare');
$('#clear-goal').onclick = () => { $('#goal').value = ''; $('#goal').focus(); };
$('#workflow').onchange = () => { $('#criteria').value = examples[$('#workflow').value === 'form' ? 'form' : 'compare'][2]; };
function renderTabs() {
  $('#tab-list').innerHTML = openTabs.length ? openTabs.map(t => '<label class="tab-option"><input type="checkbox" value="' + t.tabId + '" ' + (selected.has(t.tabId) ? 'checked' : '') + '><span><strong>' + esc(t.title) + '</strong><small>' + esc(t.origin) + '</small></span></label>').join('') : '<p class="empty-inline">No web pages found. Open a page in this window, then select Refresh.</p>';
  $('#selected-count').textContent = selected.size + ' pages selected · up to 5';
}
async function refreshTabs() {
  try { openTabs = await send('tabs'); selected = new Set([...selected].filter(id => openTabs.some(t => t.tabId === id))); renderTabs(); } catch (e) { notice(e.message); }
}
$('#refresh-tabs').onclick = refreshTabs;
$('#tab-list').onchange = e => {
  if (e.target.type !== 'checkbox') return;
  const id = Number(e.target.value);
  if (e.target.checked && selected.size >= 5) { e.target.checked = false; notice('Choose up to five pages per task.'); return; }
  e.target.checked ? selected.add(id) : selected.delete(id);
  $('#selected-count').textContent = selected.size + ' pages selected · up to 5';
};
async function refreshState() {
  if (!installed) return;
  state = await send('state');
  const connected = !!state.provider.testedAt && (state.provider.kind === 'local' || state.hasKey);
  $('#history-count').textContent = state.tasks.length;
  $('#connection-status').textContent = connected ? '● AI connected' : '○ Connect your AI';
  $('#helper-name').textContent = connected ? state.provider.model : 'Bring your own AI.';
  $('#helper-description').textContent = connected ? (state.provider.kind === 'local' ? 'Your model runs on this computer.' : 'Your selected pages go to your AI service.') : 'Connect an AI service or a model running on your computer.';
  $('#helper-connect').textContent = connected ? 'Change your AI ↗' : 'Choose your AI ↗';
  $('#sharing-note').textContent = connected ? 'Selected page text and your request will be sent to ' + new URL(state.provider.baseUrl).origin + '. ' + (state.provider.kind === 'local' ? 'No cloud fallback is used.' : 'Only continue if these pages may be shared with this service.') : 'Connect an AI to see where your selected page text will be sent.';
  if (currentView === 'active') {
    const task = state.tasks.find(t => t.id === activeId);
    const signature = JSON.stringify(task);
    if (lastActive !== signature) { lastActive = signature; renderActive(); }
  }
  if (currentView === 'history') renderHistory();
}
$('#connect-form').onsubmit = async e => {
  e.preventDefault(); notice('');
  const provider = { kind: providerKind, baseUrl: $('#server').value.trim(), model: $('#model').value.trim() };
  const button = $('#connect'); button.disabled = true; button.textContent = 'Testing your connection…';
  try {
    if (!installed) throw new Error('Load the extension in Chrome to connect an AI.');
    const origin = new URL(provider.baseUrl).origin + '/*';
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('Server access was not allowed. Your connection has not been saved.');
    const result = await send('connect', { provider, key: $('#key').value });
    $('#key').value = ''; $('#connect-result').textContent = 'Connected. The model passed a tool-use test. Vision and streaming have not been tested.';
    await refreshState(); notice('Your AI is ready. Choose New task to begin.');
  } catch (error) { $('#connect-result').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Test and save connection'; }
};
$('#disconnect').onclick = async () => { try { await send('disconnect'); $('#key').value = ''; $('#connect-result').textContent = 'Connection forgotten. New tasks need a connection.'; await refreshState(); } catch (e) { notice(e.message); } };
$('#task-form').onsubmit = async e => {
  e.preventDefault(); notice('');
  const button = $('#start');
  try {
    if (!selected.size) throw new Error('Choose at least one page for this task.');
    if ($('#workflow').value === 'form' && selected.size !== 1) throw new Error('Choose one page for a form task.');
    if (!installed) throw new Error('Load the extension in Chrome to work with your tabs.');
    button.disabled = true; button.textContent = 'Starting…';
    const origins = [...new Set(openTabs.filter(t => selected.has(t.tabId)).map(t => t.origin + '/*'))];
    if (!await chrome.permissions.request({ origins })) throw new Error('Page access was not allowed. No task was started.');
    activeId = await send('start', { goal: $('#goal').value, completionCriteria: $('#criteria').value, workflow: $('#workflow').value, maxSteps: Number($('#steps').value), tabIds: [...selected] });
    await refreshState(); view('active');
  } catch (error) { notice(error.message); }
  finally { button.disabled = false; button.innerHTML = 'Start task <span aria-hidden="true">↗</span>'; }
};
function statusTag(task) { return '<span class="status-tag" data-status="' + esc(task.status) + '">' + esc(labels[task.status] || task.status) + '</span>'; }
function taskButton(action, label, cls = '') { return '<button class="nbs-button ' + cls + '" data-action="' + action + '">' + label + '</button>'; }
function renderActive() {
  const task = state.tasks.find(t => t.id === activeId);
  if (!task) { $('#active-content').innerHTML = '<div class="card"><h2>No task selected</h2><p>Start a task or open one from Saved tasks.</p></div>'; return; }
  const inProgress = ['running', 'awaiting_approval'].includes(task.status);
  let html = '<article class="card">' + statusTag(task) + '<h2 class="task-goal">' + esc(task.goal) + '</h2><p class="task-reason" role="status">' + esc(task.reason) + '</p><div class="task-meta"><span>' + task.steps + ' / ' + task.maxSteps + ' AI steps</span><span>' + (task.usageKnown ? task.tokens + ' reported tokens' : 'AI usage not reported') + '</span><span>' + esc(task.provider.kind === 'local' ? 'Local AI' : 'AI service') + '</span></div><div class="button-row">';
  if (inProgress) html += taskButton('pause', 'Pause') + taskButton('takeover', 'I’ll take over') + taskButton('stop', 'Stop task', 'nbs-button--danger');
  if (['paused', 'failed'].includes(task.status)) html += taskButton('resume', 'Resume task', 'nbs-button--primary') + taskButton('stop', 'Stop task');
  if (task.status === 'recovering') html += taskButton('stop', 'Close this task');
  html += '</div>';
  if (inProgress) html += '<p class="help">Pause stops new steps. Take over also discards the old page view. Stop ends the task. None of these undo changes already accepted by a website.</p>';
  if (task.pending?.tool === 'fill_fields') {
    const observation = task.observations.find(o => o.id === task.pending.observationId);
    html += '<section class="review"><h2>Review these form changes</h2><p>Page: ' + esc(observation?.url) + '</p><div class="change-list">';
    for (const f of task.pending.fields) {
      const original = observation.fields.find(field => field.ref === f.ref);
      html += '<div class="change"><strong>' + esc(original.label) + '</strong><div>Current: ' + esc(original.value || '(empty)') + '</div><div>Change to: ' + esc(f.value) + '</div></div>';
    }
    html += '</div><p><strong>Before you approve:</strong> these fields will change on this page. The website may save as you type. BrowserCrew will not press Submit. Return to the form tab, then approve only if every value is correct.</p>' + taskButton('approve', 'Fill these ' + task.pending.fields.length + ' fields', 'nbs-button--primary') + '</section>';
  }
  if (task.summary) html += '<h2>What we found</h2><p>' + esc(task.summary) + '</p>';
  if (task.findings.length) html += '<div class="result-grid">' + task.findings.map(f => {
    const o = task.observations.find(o => o.id === f.observationId);
    return '<section class="finding"><h3>' + esc(f.label) + '</h3><p class="value">' + esc(f.value) + '</p><blockquote>' + esc(f.quote) + '</blockquote><a href="' + esc(o.url) + '" target="_blank" rel="noreferrer">' + esc(o.title) + ' ↗</a><p class="help">Observed ' + esc(new Date(o.observedAt).toLocaleString()) + '</p></section>';
  }).join('') + '</div>';
  for (const action of task.actions.filter(a => a.result)) html += '<div class="result-grid">' + action.result.fields.map(f => '<section class="finding"><h3>' + esc(f.label) + '</h3><p>Before: ' + esc(f.before || '(empty)') + '</p><p>Checked value: ' + esc(f.after) + '</p></section>').join('') + '</div>';
  if (task.missing.length) html += '<h3>Still unfinished</h3><ul>' + task.missing.map(m => '<li>' + esc(m) + '</li>').join('') + '</ul>';
  if (task.summary || task.actions.some(a => a.result)) html += '<div class="button-row">' + taskButton('export-json', 'Save task receipt') + taskButton('export-csv', 'Save facts as spreadsheet file') + '</div><p class="help">The receipt is a JSON file with results and source references. The spreadsheet file is CSV. Raw page snapshots and AI keys are left out.</p>';
  html += '<details><summary>See task activity (' + task.events.length + ' events)</summary><ol class="activity">' + task.events.map(e => '<li><time>' + esc(new Date(e.at).toLocaleString()) + '</time>' + esc(e.text) + '</li>').join('') + '</ol></details></article>';
  $('#active-content').innerHTML = html;
}
function renderHistory() {
  $('#history-list').innerHTML = state.tasks.length ? state.tasks.map(t => '<article class="card history-card"><div>' + statusTag(t) + '<h2>' + esc(t.goal) + '</h2><small>' + esc(new Date(t.createdAt).toLocaleString()) + '</small></div><div class="button-row"><button class="nbs-button" data-open="' + esc(t.id) + '">Open task</button><button class="text-button" data-delete="' + esc(t.id) + '">Delete</button></div></article>').join('') : '<div class="card"><h2>A fresh start.</h2><p>Your first task will appear here, with its results and progress.</p><button class="nbs-button nbs-button--primary" data-view="task">Start a task ↗</button></div>';
}
function download(task, format) {
  const receipt = { schemaVersion: 1, id: task.id, goal: task.goal, completionCriteria: task.completionCriteria, status: task.status, reason: task.reason, summary: task.summary, missing: task.missing, findings: task.findings.map(f => ({ ...f, source: task.observations.find(o => o.id === f.observationId)?.url })), actions: task.actions, createdAt: task.createdAt, updatedAt: task.updatedAt, provider: task.provider, verification: 'Exact source text matching and immediate form field checks only; no server-save verification.' };
  const content = format === 'json' ? JSON.stringify(receipt, null, 2) : [['Fact', 'Value', 'Source quote', 'Source URL'], ...receipt.findings.map(f => [f.label, f.value, f.quote, f.source])].map(row => row.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
  a.download = 'browsercrew-' + task.id.slice(0, 8) + '.' + format; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
document.addEventListener('click', async e => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.view) { view(button.dataset.view); return; }
  if (button.dataset.provider) { setProvider(button.dataset.provider); return; }
  if (button.dataset.example) { loadExample(button.dataset.example); return; }
  if (button.dataset.open) { activeId = button.dataset.open; view('active'); return; }
  if (button.dataset.delete) {
    if (!confirm('Delete this task, its results, and saved page text from this computer? This cannot remove text already sent to your AI service.')) return;
    try { await send('delete', { id: button.dataset.delete }); await refreshState(); } catch (error) { notice(error.message); }
  }
  if (button.dataset.action) {
    const task = state.tasks.find(t => t.id === activeId), action = button.dataset.action;
    if (action.startsWith('export-')) { download(task, action.slice(7)); return; }
    button.disabled = true;
    try { await send(action, { id: activeId }); await refreshState(); } catch (error) { notice(error.message); button.disabled = false; }
  }
});
(async () => {
  try {
    await refreshState();
    setProvider(state.provider.kind); $('#server').value = state.provider.baseUrl; $('#model').value = state.provider.model;
    if (installed) await refreshTabs();
    else notice('Interface preview — load the extension in Chrome to connect your AI and use real tabs.');
  } catch (e) { notice(e.message); }
})();
let polling = false;
setInterval(async () => {
  if (!installed || polling || document.hidden) return;
  polling = true;
  try { await refreshState(); } catch (error) { notice(error.message); }
  finally { polling = false; }
}, 1500);
