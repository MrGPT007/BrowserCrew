const STORAGE_KEY = "browsercrew.tasks.v1";
const SETTINGS_KEY = "browsercrew.settings.v1";
const SESSION_KEY = "browsercrew.providerSecret.v1";
const MAX_PAGE_CHARS = 18000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  reconcileInterruptedTasks().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: serializeError(error) });
  });
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_ACTIVE_TAB": return getActiveTab();
    case "REQUEST_SITE_ACCESS": return requestSiteAccess(message.tab);
    case "GET_SETTINGS": return getSettings();
    case "SAVE_SETTINGS": return saveSettings(message.settings, message.secret);
    case "TEST_PROVIDER": return testProvider(message.settings, message.secret);
    case "RUN_TASK": return runTask(message.payload);
    case "PAUSE_TASK": return updateTaskControl(message.taskId, "paused");
    case "STOP_TASK": return updateTaskControl(message.taskId, "cancelled");
    case "GET_TASKS": return { ok: true, tasks: await getTasks() };
    default: return { ok: false, error: { code: "UNKNOWN_MESSAGE", message: "BrowserCrew received an unknown request." } };
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { ok: false, error: { code: "NO_TAB", message: "I could not find the page you are looking at." } };
  if (!/^https?:/.test(tab.url)) return { ok: false, error: { code: "UNSUPPORTED_PAGE", message: "Chrome does not let extensions work on this kind of page. Open a normal http or https website and try again." } };
  return { ok: true, tab: { id: tab.id, title: tab.title || "Untitled page", url: tab.url } };
}

async function requestSiteAccess(tab) {
  if (!tab?.url || !tab?.id) throw new Error("No page was selected.");
  const url = new URL(tab.url);
  const originPattern = `${url.origin}/*`;
  const granted = await chrome.permissions.contains({ origins: [originPattern] });
  return { ok: granted, granted, origin: url.origin, error: granted ? undefined : { code: "SITE_PERMISSION_DENIED", message: "BrowserCrew does not have access to this site. Choose the page again and approve Chrome's permission prompt." } };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const session = await chrome.storage.session.get(SESSION_KEY);
  return { ok: true, settings: stored[SETTINGS_KEY] || defaultSettings(), hasSecret: Boolean(session[SESSION_KEY]) };
}

async function saveSettings(settings, secret) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  if (typeof secret === "string" && secret.length > 0) await chrome.storage.session.set({ [SESSION_KEY]: secret });
  if (secret === "") await chrome.storage.session.remove(SESSION_KEY);
  return { ok: true, settings: normalized };
}

async function testProvider(settings, suppliedSecret) {
  const normalized = normalizeSettings(settings);
  const secret = await resolveSecret(suppliedSecret);
  await ensureProviderPermission(normalized.baseUrl);
  const startedAt = Date.now();
  const response = await callOpenAICompatible(normalized, secret, [
    { role: "system", content: "Reply with exactly: BrowserCrew connection works" },
    { role: "user", content: "Connection test" }
  ], { maxTokens: 30 });
  return { ok: true, latencyMs: Date.now() - startedAt, model: response.model || normalized.model, message: "Connection works. BrowserCrew can reach this AI model." };
}

async function runTask(payload) {
  validateRunPayload(payload);
  const task = {
    id: crypto.randomUUID(), schemaVersion: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    goal: payload.goal.trim(), status: "planning", selectedResource: payload.tab,
    providerRef: { kind: payload.settings.kind, model: payload.settings.model, baseUrl: payload.settings.baseUrl },
    checkpoint: "created", journal: [], result: null, error: null
  };
  await upsertTask(task);

  try {
    await assertNotStopped(task.id);
    await transition(task.id, "running", "page_access_check");
    await requestSiteAccess(payload.tab).then((result) => { if (!result.granted) throw coded("SITE_PERMISSION_DENIED", result.error?.message || "Site access was not granted."); });

    await assertNotStopped(task.id);
    await journal(task.id, "observation.intent", { tabId: payload.tab.id, url: payload.tab.url });
    const observation = await observeTab(payload.tab.id, payload.tab.url);
    await journal(task.id, "observation.complete", { url: observation.url, title: observation.title, chars: observation.text.length });
    await transition(task.id, "running", "page_observed");

    await assertNotStopped(task.id);
    const settings = normalizeSettings(payload.settings);
    const secret = await resolveSecret(payload.secret);
    await ensureProviderPermission(settings.baseUrl);
    await journal(task.id, "provider.intent", { kind: settings.kind, model: settings.model, destination: new URL(settings.baseUrl).origin });
    const extracted = await extractWithModel(settings, secret, payload.goal, observation);
    await journal(task.id, "provider.complete", { model: extracted.model, usage: extracted.usage });

    await assertNotStopped(task.id);
    const verified = verifyExtraction(extracted.data, observation);
    const result = {
      values: verified.values,
      evidence: { sourceUrl: observation.url, pageTitle: observation.title, observedAt: observation.observedAt, verification: verified.verification },
      model: extracted.model
    };
    await completeTask(task.id, result);
    return { ok: true, task: await getTask(task.id) };
  } catch (error) {
    if (error?.code === "TASK_CANCELLED") {
      await transition(task.id, "cancelled", "cancelled", serializeError(error));
    } else if (error?.code === "TASK_PAUSED") {
      await transition(task.id, "paused", "paused", serializeError(error));
    } else {
      await transition(task.id, "failed", "failed", serializeError(error));
    }
    return { ok: false, task: await getTask(task.id), error: serializeError(error) };
  }
}

async function observeTab(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || tab.url !== expectedUrl) throw coded("PAGE_CHANGED", "The selected tab changed before I could read it. Choose the page again so I do not read the wrong site.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxChars) => {
      const clone = document.body?.cloneNode(true);
      if (!clone) return { title: document.title, url: location.href, text: "" };
      clone.querySelectorAll("script,style,noscript,template,svg,canvas,iframe,input[type='password']").forEach((node) => node.remove());
      const text = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
      return { title: document.title, url: location.href, text };
    },
    args: [MAX_PAGE_CHARS]
  });
  if (!result?.text) throw coded("EMPTY_PAGE", "I could not find readable text on this page.");
  return { ...result, observedAt: new Date().toISOString() };
}

async function extractWithModel(settings, secret, goal, observation) {
  const schemaInstruction = `Return only one JSON object with this shape: {"productName":"string or null","price":"string or null","notes":"short string"}. Do not invent missing values. Use null when the page does not contain a value.`;
  const response = await callOpenAICompatible(settings, secret, [
    { role: "system", content: `You extract facts from browser-page text. ${schemaInstruction}` },
    { role: "user", content: `User job: ${goal}\n\nPage title: ${observation.title}\nPage address: ${observation.url}\n\nPage text:\n${observation.text}` }
  ], { maxTokens: 350 });
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw coded("BAD_MODEL_RESPONSE", "The AI answered in a format BrowserCrew could not read.");
  return { data: parseJsonObject(content), model: response.model || settings.model, usage: response.usage || null };
}

async function callOpenAICompatible(settings, secret, messages, options = {}) {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: options.maxTokens || 350 })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check that the address is correct and, for local AI, that the server is running.");
  } finally { clearTimeout(timeout); }
  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (!response.ok) {
    const detail = body?.error?.message || `The AI service returned HTTP ${response.status}.`;
    throw coded("PROVIDER_ERROR", detail);
  }
  if (!body) throw coded("BAD_PROVIDER_JSON", "The AI service returned a response BrowserCrew could not read.");
  return body;
}

function verifyExtraction(data, observation) {
  const values = {
    productName: cleanNullable(data.productName),
    price: cleanNullable(data.price),
    notes: cleanNullable(data.notes) || "No extra notes."
  };
  const page = observation.text.toLowerCase();
  const checks = [];
  for (const [key, value] of Object.entries({ productName: values.productName, price: values.price })) {
    if (!value) { checks.push(`${key} was not found and was left empty.`); continue; }
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    const exact = page.includes(normalized);
    checks.push(exact ? `${key} appears in the captured page text.` : `${key} came from the AI answer but could not be matched exactly in the captured text.`);
  }
  if (!values.productName && !values.price) throw coded("NOT_VERIFIED", "The AI did not find either requested value, so BrowserCrew will not mark the job complete.");
  return { values, verification: checks };
}

function parseJsonObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw coded("BAD_MODEL_JSON", "The AI did not return the requested structured answer.");
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { throw coded("BAD_MODEL_JSON", "The AI returned invalid JSON. Try the job again or choose a more capable model."); }
}

async function ensureProviderPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw coded("UNSAFE_PROVIDER_URL", "Cloud AI connections must use HTTPS. Plain HTTP is allowed only for local AI on this computer.");
  }
  const pattern = `${url.origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (!has) throw coded("PROVIDER_PERMISSION_DENIED", "BrowserCrew does not have permission to contact this AI address. Use the connection test first and approve Chrome's permission prompt.");
  return true;
}

function normalizeSettings(settings = {}) {
  const kind = ["openai", "lmstudio", "ollama"].includes(settings.kind) ? settings.kind : "openai";
  const defaults = preset(kind);
  return { kind, model: String(settings.model || defaults.model).trim(), baseUrl: String(settings.baseUrl || defaults.baseUrl).replace(/\/$/, "") };
}
function defaultSettings() { return preset("openai"); }
function preset(kind) {
  if (kind === "lmstudio") return { kind, model: "local-model", baseUrl: "http://127.0.0.1:1234/v1" };
  if (kind === "ollama") return { kind, model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" };
  return { kind: "openai", model: "gpt-5.6", baseUrl: "https://api.openai.com/v1" };
}
async function resolveSecret(supplied) {
  if (typeof supplied === "string" && supplied.length) return supplied;
  const session = await chrome.storage.session.get(SESSION_KEY);
  return session[SESSION_KEY] || "";
}
function validateRunPayload(payload) {
  if (!payload?.goal?.trim()) throw coded("MISSING_GOAL", "Tell BrowserCrew what you want it to find.");
  if (!payload?.tab?.id || !payload?.tab?.url) throw coded("MISSING_TAB", "Choose the page you want BrowserCrew to read.");
  if (!payload?.settings?.model || !payload?.settings?.baseUrl) throw coded("MISSING_PROVIDER", "Choose and test an AI connection first.");
}
function cleanNullable(value) { if (value === null || value === undefined) return null; const text = String(value).trim(); return text || null; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function serializeError(error) { return { code: error?.code || "UNKNOWN_ERROR", message: error?.message || "Something unexpected happened." }; }

async function getTasks() { const data = await chrome.storage.local.get(STORAGE_KEY); return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []; }
async function getTask(id) { return (await getTasks()).find((task) => task.id === id) || null; }
async function upsertTask(task) { const tasks = await getTasks(); const index = tasks.findIndex((item) => item.id === task.id); if (index >= 0) tasks[index] = task; else tasks.unshift(task); await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) }); }
async function mutateTask(id, mutate) { const task = await getTask(id); if (!task) throw coded("TASK_NOT_FOUND", "This saved job could not be found."); mutate(task); task.updatedAt = new Date().toISOString(); await upsertTask(task); return task; }
async function transition(id, status, checkpoint, error = null) { return mutateTask(id, (task) => { task.status = status; task.checkpoint = checkpoint; if (error) task.error = error; }); }
async function journal(id, type, data) { return mutateTask(id, (task) => { task.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, data }); task.checkpoint = type; }); }
async function completeTask(id, result) { return mutateTask(id, (task) => { task.status = "completed"; task.checkpoint = "completed"; task.result = result; }); }
async function updateTaskControl(id, state) { const task = await transition(id, state, state); return { ok: true, task }; }
async function assertNotStopped(id) { const task = await getTask(id); if (task?.status === "cancelled") throw coded("TASK_CANCELLED", "The job was stopped. BrowserCrew will not dispatch another action."); if (task?.status === "paused") throw coded("TASK_PAUSED", "The job was paused. No new action will start until you run it again."); }
async function reconcileInterruptedTasks() {
  const tasks = await getTasks(); let changed = false;
  for (const task of tasks) {
    if (["planning", "running"].includes(task.status)) {
      task.status = "paused"; task.checkpoint = "worker_restarted"; task.updatedAt = new Date().toISOString();
      task.error = { code: "WORKER_RESTARTED", message: "Chrome restarted BrowserCrew while this job was running. The job was paused instead of repeating an uncertain action." }; changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
}
