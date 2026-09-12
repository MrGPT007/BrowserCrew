const STORAGE_KEY = "browsercrew.tasks.v1";
const SETTINGS_KEY = "browsercrew.settings.v1";
const SESSION_KEY = "browsercrew.providerSecret.v1";
const SKILLS_KEY = "browsercrew.skills.v1";
const MAX_PAGE_CHARS = 18000;
const MAX_SKILLS = 50;
const activeTaskRuns = new Map();

const TOOL_CATALOG = Object.freeze([
  {
    id: "page.read",
    name: "Read the selected page",
    summary: "Reads a bounded snapshot of visible text from the exact page you approved.",
    access: "Read only",
    status: "available"
  },
  {
    id: "evidence.verify",
    name: "Check extracted values",
    summary: "Compares extracted values with the captured page text before BrowserCrew marks a job complete.",
    access: "Local check",
    status: "available"
  },
  {
    id: "task.pause",
    name: "Pause a job",
    summary: "Stops BrowserCrew from starting another step after the current step is reconciled.",
    access: "Job control",
    status: "available"
  },
  {
    id: "task.stop",
    name: "Stop a job",
    summary: "Cancels future work for the current job and keeps the saved journal for review.",
    access: "Job control",
    status: "available"
  }
]);

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
    case "STOP_TASK": return stopTask(message.taskId);
    case "GET_TASKS": return { ok: true, tasks: await getTasks() };
    case "GET_TOOL_CATALOG": return { ok: true, tools: TOOL_CATALOG };
    case "GET_SKILLS": return { ok: true, skills: await getSkills() };
    case "SAVE_SKILL": return saveSkill(message.skill);
    case "DELETE_SKILL": return deleteSkill(message.skillId);
    case "GET_MEMORY_SUMMARY": return getMemorySummary();
    case "CLEAR_MEMORY": return clearMemory(message.scope);
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
  const runtime = { taskId: task.id, cancelled: false, providerController: null };
  activeTaskRuns.set(task.id, runtime);

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
    const extracted = await extractWithModel(settings, secret, payload.goal, observation, runtime);
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
  } finally {
    activeTaskRuns.delete(task.id);
  }
}

async function observeTab(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || tab.url !== expectedUrl) throw coded("PAGE_CHANGED", "The selected tab changed before I could read it. Choose the page again so I do not read the wrong site.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxChars) => {
      // Use the live rendered-text view. Detached clones can make hidden DOM fall back to textContent.
      // innerText excludes non-rendered script/style/hidden content and does not expose password input values.
      const text = String(document.body?.innerText || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
      return { title: document.title, url: location.href, text };
    },
    args: [MAX_PAGE_CHARS]
  });
  if (!result?.text) throw coded("EMPTY_PAGE", "I could not find readable text on this page.");
  return { ...result, observedAt: new Date().toISOString() };
}

async function extractWithModel(settings, secret, goal, observation, taskRuntime = null) {
  const schemaInstruction = "Return only one JSON object with this shape: {\"items\":[{\"label\":\"short name\",\"value\":\"exact text copied from the page or null\"}],\"notes\":\"short string\"}. Return at most 8 items. Do not invent missing values. Use null when the page does not contain a requested value.";
  const response = await callOpenAICompatible(settings, secret, [
    { role: "system", content: `You extract facts from browser-page text. ${schemaInstruction}` },
    { role: "user", content: `User job: ${goal}\n\nPage title: ${observation.title}\nPage address: ${observation.url}\n\nPage text:\n${observation.text}` }
  ], { maxTokens: 500, taskRuntime });
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw coded("BAD_MODEL_RESPONSE", "The AI answered in a format BrowserCrew could not read.");
  return { data: parseJsonObject(content), model: response.model || settings.model, usage: response.usage || null };
}

async function callOpenAICompatible(settings, secret, messages, options = {}) {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const controller = new AbortController();
  const taskRuntime = options.taskRuntime || null;
  if (taskRuntime?.cancelled) throw coded("TASK_CANCELLED", "The job was stopped. BrowserCrew will not dispatch another AI request.");
  let timedOut = false;
  if (taskRuntime) taskRuntime.providerController = controller;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: options.maxTokens || 500 })
    });
  } catch (error) {
    if (error?.name === "AbortError" && taskRuntime?.cancelled) {
      throw coded("TASK_CANCELLED", "The job was stopped. BrowserCrew aborted its active AI request and will not start another step.");
    }
    if (error?.name === "AbortError" && timedOut) throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check that the address is correct and, for local AI, that the server is running.");
  } finally {
    clearTimeout(timeout);
    if (taskRuntime?.providerController === controller) taskRuntime.providerController = null;
  }
  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (!response.ok) throw coded("PROVIDER_ERROR", safeProviderErrorMessage(response.status));
  if (!body) throw coded("BAD_PROVIDER_JSON", "The AI service returned a response BrowserCrew could not read.");
  return body;
}

function safeProviderErrorMessage(status) {
  if (status === 401 || status === 403) return "The AI service rejected the connection credentials. Check the key and account access, then try the connection test again.";
  if (status === 429) return "The AI service is temporarily limiting requests. Wait a moment, then try again.";
  return `The AI service returned HTTP ${status}. BrowserCrew did not copy the provider's error text into history.`;
}

function verifyExtraction(data, observation) {
  const rawItems = Array.isArray(data?.items) ? data.items : [
    { label: "Product", value: data?.productName ?? null },
    { label: "Price", value: data?.price ?? null }
  ];
  const items = rawItems.slice(0, 8).map((item, index) => ({
    label: cleanNullable(item?.label) || `Result ${index + 1}`,
    value: cleanNullable(item?.value)
  }));
  const notes = cleanNullable(data?.notes) || "No extra notes.";
  const page = observation.text.toLowerCase();
  const verification = [];
  let exactMatches = 0;

  for (const item of items) {
    if (!item.value) {
      verification.push(`${item.label} was not found and was left empty.`);
      continue;
    }
    const normalized = item.value.toLowerCase().replace(/\s+/g, " ").trim();
    const exact = page.includes(normalized);
    if (exact) exactMatches += 1;
    verification.push(exact ? `${item.label} appears in the captured page text.` : `${item.label} came from the AI answer but could not be matched exactly in the captured text.`);
  }

  const presentItems = items.filter((item) => item.value);
  if (!presentItems.length) throw coded("NOT_VERIFIED", "The AI did not find any requested values, so BrowserCrew will not mark the job complete.");
  if (!exactMatches) throw coded("NOT_VERIFIED", "BrowserCrew could not match any extracted value to the captured page text, so the job was not marked complete.");

  const productName = items.find((item) => /product|name|heading/i.test(item.label) && item.value)?.value || null;
  const price = items.find((item) => /price|cost|amount/i.test(item.label) && item.value)?.value || null;
  return { values: { items, productName, price, notes }, verification };
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
  const kind = ["openai", "anthropic", "lmstudio", "ollama"].includes(settings.kind) ? settings.kind : "openai";
  const defaults = preset(kind);
  return { kind, model: String(settings.model || defaults.model).trim(), baseUrl: String(settings.baseUrl || defaults.baseUrl).replace(/\/$/, "") };
}
function defaultSettings() { return preset("openai"); }
function preset(kind) {
  if (kind === "anthropic") return { kind, model: "claude-sonnet-5", baseUrl: "https://api.anthropic.com/v1" };
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
async function stopTask(id) {
  const task = await transition(id, "cancelled", "cancelled");
  const runtime = activeTaskRuns.get(id);
  if (runtime) {
    runtime.cancelled = true;
    runtime.providerController?.abort();
  }
  return { ok: true, task };
}
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

async function getSkills() {
  const data = await chrome.storage.local.get(SKILLS_KEY);
  return Array.isArray(data[SKILLS_KEY]) ? data[SKILLS_KEY] : [];
}

async function saveSkill(input = {}) {
  const name = String(input.name || "").trim();
  const goal = String(input.goal || "").trim();
  if (!name) throw coded("SKILL_NAME_REQUIRED", "Give this reusable job a short name.");
  if (name.length > 80) throw coded("SKILL_NAME_TOO_LONG", "Keep the reusable job name under 80 characters.");
  if (!goal) throw coded("SKILL_GOAL_REQUIRED", "Add the instructions BrowserCrew should reuse.");
  if (goal.length > 1500) throw coded("SKILL_GOAL_TOO_LONG", "Keep reusable job instructions under 1,500 characters.");

  const skills = await getSkills();
  if (skills.length >= MAX_SKILLS) throw coded("SKILL_LIMIT", `BrowserCrew can keep up to ${MAX_SKILLS} reusable jobs in this build.`);
  const now = new Date().toISOString();
  const skill = {
    id: crypto.randomUUID(), schemaVersion: 1, name, goal,
    mode: "read_only", createdAt: now, updatedAt: now
  };
  skills.unshift(skill);
  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
  return { ok: true, skill, skills };
}

async function deleteSkill(skillId) {
  if (!skillId) throw coded("SKILL_ID_REQUIRED", "Choose the reusable job you want to delete.");
  const skills = await getSkills();
  const next = skills.filter((skill) => skill.id !== skillId);
  if (next.length === skills.length) throw coded("SKILL_NOT_FOUND", "That reusable job could not be found.");
  await chrome.storage.local.set({ [SKILLS_KEY]: next });
  return { ok: true, skills: next };
}

async function getMemorySummary() {
  const [tasks, skills, settingsResponse] = await Promise.all([getTasks(), getSkills(), getSettings()]);
  return {
    ok: true,
    summary: {
      taskCount: tasks.length,
      skillCount: skills.length,
      provider: settingsResponse.settings,
      hasSecret: settingsResponse.hasSecret
    }
  };
}

async function clearMemory(scope) {
  if (scope === "tasks") {
    await chrome.storage.local.remove(STORAGE_KEY);
  } else if (scope === "skills") {
    await chrome.storage.local.remove(SKILLS_KEY);
  } else if (scope === "ai") {
    await chrome.storage.local.remove(SETTINGS_KEY);
    await chrome.storage.session.remove(SESSION_KEY);
  } else {
    throw coded("UNKNOWN_MEMORY_SCOPE", "Choose which saved information you want BrowserCrew to forget.");
  }
  return getMemorySummary();
}