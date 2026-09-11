const STORAGE_KEY = "browsercrew.tasks.v1";
const SESSION_KEY = "browsercrew.providerSecret.v1";
const FORM_PORT = "browsercrew-form-write";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== FORM_PORT) return;
  port.onMessage.addListener((message) => {
    handleFormMessage(message).then((response) => {
      try { port.postMessage(response); } catch {}
    }).catch((error) => {
      try { port.postMessage({ ok: false, error: serializeError(error) }); } catch {}
    });
  });
});

reconcilePendingWrites().catch(() => {});

async function handleFormMessage(message) {
  switch (message?.type) {
    case "PREVIEW_FORM_TASK": return previewFormTask(message.payload);
    case "COMMIT_FORM_TASK": return commitFormTask(message.taskId, message.approvedChangeHash);
    case "CANCEL_FORM_TASK": return cancelFormTask(message.taskId);
    default: return { ok: false, error: { code: "UNKNOWN_FORM_MESSAGE", message: "BrowserCrew received an unknown form request." } };
  }
}

async function previewFormTask(payload) {
  validateFormPayload(payload);
  const settings = normalizeSettings(payload.settings);
  const task = {
    id: crypto.randomUUID(), schemaVersion: 1, kind: "form_fill",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    goal: payload.details.trim(), status: "planning", selectedResource: payload.tab,
    providerRef: { kind: settings.kind, model: settings.model, baseUrl: settings.baseUrl },
    checkpoint: "created", journal: [], formPlan: null, grant: null, result: null, error: null
  };
  await upsertTask(task);

  try {
    await ensureSitePermission(payload.tab.url);
    const observation = await observeFormFields(payload.tab.id, payload.tab.url);
    if (!observation.fields.length) throw coded("NO_EDITABLE_FORM", "I could not find a supported text field, message box, or dropdown on this page.");
    await journal(task.id, "form_observation.complete", { url: observation.url, fieldCount: observation.fields.length, formFingerprint: observation.formFingerprint });

    const secret = await resolveSecret(payload.secret);
    await ensureProviderPermission(settings.baseUrl);
    const mapped = await mapFormWithModel(settings, secret, payload.details, observation);
    const changes = validateFormChanges(mapped.data, observation);
    const changeHash = await digestString(JSON.stringify(changes.map(({ ref, value }) => ({ ref, value }))));
    const grant = {
      id: crypto.randomUUID(), origin: new URL(observation.url).origin, resourceScope: observation.url,
      actionClass: "form.fill", changeHash, state: "pending", createdAt: new Date().toISOString()
    };
    await mutateTask(task.id, (current) => {
      current.status = "awaiting_approval";
      current.checkpoint = "form_preview_ready";
      current.formPlan = {
        pageTitle: observation.title, url: observation.url, observedAt: observation.observedAt,
        formFingerprint: observation.formFingerprint, changes, notes: cleanNullable(mapped.data?.notes) || "No extra notes.", changeHash
      };
      current.grant = grant;
    });
    return { ok: true, task: await getTask(task.id) };
  } catch (error) {
    await transition(task.id, "failed", "form_preview_failed", serializeError(error));
    return { ok: false, task: await getTask(task.id), error: serializeError(error) };
  }
}

async function commitFormTask(taskId, approvedChangeHash) {
  const task = await getTask(taskId);
  if (!task || task.kind !== "form_fill") throw coded("FORM_TASK_NOT_FOUND", "This form preview could not be found.");
  if (task.status !== "awaiting_approval" || task.checkpoint !== "form_preview_ready") throw coded("FORM_NOT_READY", "This form preview is no longer waiting for approval. Prepare a fresh preview before filling anything.");
  if (!approvedChangeHash || approvedChangeHash !== task.formPlan?.changeHash || approvedChangeHash !== task.grant?.changeHash) {
    throw coded("APPROVAL_MISMATCH", "The form changes no longer match the preview you approved. Prepare a fresh preview.");
  }

  await ensureSitePermission(task.selectedResource.url);
  const before = await observeFormFields(task.selectedResource.id, task.selectedResource.url);
  if (before.formFingerprint !== task.formPlan.formFingerprint) {
    return blockForChangedForm(task.id, "The form changed after the preview. BrowserCrew did not fill anything. Prepare a fresh preview.");
  }
  for (const change of task.formPlan.changes) {
    const field = before.fields.find((item) => item.ref === change.ref);
    if (!field || field.currentValue !== change.before) {
      return blockForChangedForm(task.id, "A form field changed after the preview. BrowserCrew did not overwrite it. Prepare a fresh preview.");
    }
  }

  const actionId = crypto.randomUUID();
  await mutateTask(task.id, (current) => {
    current.status = "committing";
    current.checkpoint = "form_write_intent";
    current.grant.state = "granted";
    current.grant.grantedAt = new Date().toISOString();
    current.journal.push({
      id: actionId, at: new Date().toISOString(), type: "form_write.intent",
      data: { changeHash: approvedChangeHash, fields: current.formPlan.changes.map(({ ref, label }) => ({ ref, label })) }
    });
  });

  try {
    await executeFormFill(task.selectedResource.id, task.selectedResource.url, task.formPlan.changes);
    await mutateTask(task.id, (current) => {
      current.checkpoint = "form_write_dispatched";
      current.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "form_write.dispatched", data: { actionId } });
    });

    const after = await observeFormFields(task.selectedResource.id, task.selectedResource.url);
    const verification = verifyFormChanges(task.formPlan.changes, after);
    if (!verification.every((item) => item.matches)) {
      await transition(task.id, "partially_completed", "form_write_partial", { code: "FORM_VERIFY_FAILED", message: "Some approved fields did not keep the expected value. BrowserCrew stopped without submitting the form." });
      return { ok: false, task: await getTask(task.id), error: { code: "FORM_VERIFY_FAILED", message: "Some approved fields did not keep the expected value. BrowserCrew stopped without submitting the form." } };
    }

    await completeTask(task.id, buildFormResult(task, after, verification, false));
    await mutateTask(task.id, (current) => { if (current.grant) current.grant.state = "consumed"; });
    return { ok: true, task: await getTask(task.id) };
  } catch (error) {
    await reconcileFormTask(task.id);
    const reconciled = await getTask(task.id);
    return { ok: reconciled?.status === "completed", task: reconciled, error: reconciled?.status === "completed" ? undefined : (reconciled?.error || serializeError(error)) };
  }
}

async function blockForChangedForm(taskId, message) {
  const error = { code: "FORM_CHANGED", message };
  await transition(taskId, "awaiting_user", "form_changed", error);
  return { ok: false, task: await getTask(taskId), error };
}

async function cancelFormTask(taskId) {
  const task = await getTask(taskId);
  if (!task || task.kind !== "form_fill") throw coded("FORM_TASK_NOT_FOUND", "This form preview could not be found.");
  if (task.status !== "awaiting_approval") throw coded("FORM_NOT_CANCELLABLE", "This form preview is no longer waiting for approval.");
  await mutateTask(taskId, (current) => {
    current.status = "cancelled";
    current.checkpoint = "form_preview_cancelled";
    if (current.grant) current.grant.state = "revoked";
  });
  return { ok: true, task: await getTask(taskId) };
}

async function observeFormFields(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || tab.url !== expectedUrl) throw coded("PAGE_CHANGED", "The selected tab changed. BrowserCrew will not read or fill a different page.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const supportedInputTypes = new Set(["text", "email", "tel", "url", "search", "number"]);
      const elements = [...document.querySelectorAll("input, textarea, select")].filter((element) => {
        if (element.disabled || element.readOnly) return false;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
        return supportedInputTypes.has((element.type || "text").toLowerCase());
      });
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
      const fields = elements.slice(0, 40).map((element, index) => {
        const label = clean(element.labels?.[0]?.innerText || element.getAttribute("aria-label") || element.placeholder || element.name || element.id || `Field ${index + 1}`);
        const type = element instanceof HTMLTextAreaElement ? "textarea" : element instanceof HTMLSelectElement ? "select-one" : (element.type || "text").toLowerCase();
        const options = element instanceof HTMLSelectElement ? [...element.options].slice(0, 50).map((option) => ({ value: option.value, label: clean(option.textContent) })) : [];
        return {
          ref: `field-${index}`, label, name: clean(element.name), type, required: Boolean(element.required),
          currentValue: String(element.value || "").slice(0, 5000), options
        };
      });
      return { title: document.title, url: location.href, fields };
    }
  });
  if (!result) throw coded("FORM_OBSERVE_FAILED", "BrowserCrew could not inspect this form.");
  const formFingerprint = await digestString(JSON.stringify(result.fields.map(({ ref, label, name, type, required, options }) => ({ ref, label, name, type, required, options }))));
  return { ...result, formFingerprint, observedAt: new Date().toISOString() };
}

async function mapFormWithModel(settings, secret, details, observation) {
  const fieldSchema = observation.fields.map(({ ref, label, name, type, required, options }) => ({ ref, label, name, type, required, options }));
  const instruction = 'Return only JSON with this shape: {"changes":[{"ref":"field-0","value":"exact value to fill"}],"notes":"short note"}. Use only the supplied field refs. Fill only fields clearly supported by the user details. Do not invent personal information. Do not include a field if the user did not provide a value for it.';
  const response = await callOpenAICompatible(settings, secret, [
    { role: "system", content: `You map user-provided details to safe web-form fields. ${instruction}` },
    { role: "user", content: `User-provided details:\n${details}\n\nForm fields:\n${JSON.stringify(fieldSchema)}` }
  ], { maxTokens: 700 });
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw coded("BAD_MODEL_RESPONSE", "The AI answered in a format BrowserCrew could not read.");
  return { data: parseJsonObject(content), model: response.model || settings.model };
}

function validateFormChanges(data, observation) {
  if (!Array.isArray(data?.changes)) throw coded("BAD_FORM_PLAN", "The AI did not return a usable form preview.");
  const fields = new Map(observation.fields.map((field) => [field.ref, field]));
  const seen = new Set();
  const changes = [];
  for (const raw of data.changes.slice(0, 20)) {
    const ref = String(raw?.ref || "");
    if (!fields.has(ref) || seen.has(ref)) continue;
    const field = fields.get(ref);
    let value = raw?.value === null || raw?.value === undefined ? "" : String(raw.value);
    if (value.length > 5000) throw coded("FORM_VALUE_TOO_LONG", `The proposed value for ${field.label} is too long.`);
    if (field.type === "select-one") {
      const exact = field.options.find((option) => option.value === value) || field.options.find((option) => option.label.toLowerCase() === value.toLowerCase());
      if (!exact) throw coded("BAD_SELECT_VALUE", `The proposed choice for ${field.label} is not one of the available options.`);
      value = exact.value;
    }
    seen.add(ref);
    changes.push({ ref, label: field.label, name: field.name, type: field.type, before: field.currentValue, value });
  }
  if (!changes.length) throw coded("NO_FORM_CHANGES", "BrowserCrew could not map the details you provided to any supported form field.");
  return changes;
}

async function executeFormFill(tabId, expectedUrl, changes) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expected, targets) => {
      if (location.href !== expected) return { ok: false, code: "PAGE_CHANGED" };
      const supportedInputTypes = new Set(["text", "email", "tel", "url", "search", "number"]);
      const elements = [...document.querySelectorAll("input, textarea, select")].filter((element) => {
        if (element.disabled || element.readOnly) return false;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
        return supportedInputTypes.has((element.type || "text").toLowerCase());
      }).slice(0, 40);
      const applied = [];
      for (const target of targets) {
        const index = Number(String(target.ref).replace("field-", ""));
        const element = elements[index];
        if (!element) return { ok: false, code: "FIELD_MISSING", ref: target.ref };
        const type = element instanceof HTMLTextAreaElement ? "textarea" : element instanceof HTMLSelectElement ? "select-one" : (element.type || "text").toLowerCase();
        if (type !== target.type || String(element.name || "").trim() !== String(target.name || "").trim()) return { ok: false, code: "FIELD_CHANGED", ref: target.ref };
        if (element instanceof HTMLSelectElement) {
          element.value = target.value;
        } else {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(element, target.value); else element.value = target.value;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        applied.push({ ref: target.ref, value: String(element.value || "") });
      }
      return { ok: true, applied };
    },
    args: [expectedUrl, changes.map(({ ref, name, type, value }) => ({ ref, name, type, value }))]
  });
  if (!result?.ok) throw coded(result?.code || "FORM_FILL_FAILED", "The form changed while BrowserCrew was filling it. BrowserCrew stopped and did not submit the form.");
  return result;
}

function verifyFormChanges(changes, observation) {
  return changes.map((change) => {
    const field = observation.fields.find((item) => item.ref === change.ref);
    const actual = field?.currentValue;
    return { ref: change.ref, label: change.label, expected: change.value, actual, matches: Boolean(field) && actual === change.value };
  });
}

function buildFormResult(task, observation, verification, recovered) {
  return {
    kind: "form_fill",
    values: { items: task.formPlan.changes.map((change) => ({ label: change.label, value: change.value })), notes: task.formPlan.notes },
    formChanges: task.formPlan.changes.map((change) => ({ label: change.label, before: change.before, after: change.value })),
    evidence: {
      sourceUrl: observation.url, pageTitle: observation.title, observedAt: observation.observedAt,
      verification: verification.map((item) => item.matches ? `${item.label} now contains the approved value.` : `${item.label} could not be verified.`),
      recovered: Boolean(recovered), submitted: false
    },
    model: task.providerRef?.model || null
  };
}

async function reconcilePendingWrites() {
  const tasks = await getTasks();
  for (const task of tasks) {
    if (task.kind === "form_fill" && task.status === "committing" && ["form_write_intent", "form_write_dispatched"].includes(task.checkpoint)) {
      await reconcileFormTask(task.id);
    }
  }
}

async function reconcileFormTask(taskId) {
  const task = await getTask(taskId);
  if (!task?.formPlan) return;
  try {
    const observation = await observeFormFields(task.selectedResource.id, task.selectedResource.url);
    const afterChecks = verifyFormChanges(task.formPlan.changes, observation);
    if (afterChecks.every((item) => item.matches)) {
      await completeTask(task.id, buildFormResult(task, observation, afterChecks, true));
      await mutateTask(task.id, (current) => { if (current.grant) current.grant.state = "consumed"; });
      return;
    }
    const beforeMatches = task.formPlan.changes.every((change) => observation.fields.find((field) => field.ref === change.ref)?.currentValue === change.before);
    if (beforeMatches) {
      await transition(task.id, "paused", "form_write_not_applied", { code: "WRITE_NOT_APPLIED", message: "BrowserCrew restarted around the form write. The approved values are not present, so BrowserCrew paused instead of trying again automatically." });
      return;
    }
    await transition(task.id, "paused", "form_write_outcome_unknown", { code: "OUTCOME_UNKNOWN", message: "BrowserCrew restarted around the form write and the page is now in a mixed state. Review the form before doing anything else." });
  } catch {
    await transition(task.id, "paused", "form_write_outcome_unknown", { code: "OUTCOME_UNKNOWN", message: "BrowserCrew restarted around the form write and could not safely verify the page. Review the form before doing anything else." });
  }
}

async function ensureSitePermission(urlText) {
  const url = new URL(urlText);
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw coded("SITE_PERMISSION_DENIED", "BrowserCrew does not have access to this site. Choose the page and approve Chrome's permission prompt first.");
}

async function ensureProviderPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw coded("UNSAFE_PROVIDER_URL", "Cloud AI connections must use HTTPS. Plain HTTP is allowed only for local AI on this computer.");
  }
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw coded("PROVIDER_PERMISSION_DENIED", "BrowserCrew does not have permission to contact this AI address. Test the AI connection first and approve Chrome's permission prompt.");
}

function normalizeSettings(settings = {}) {
  const kind = ["openai", "lmstudio", "ollama"].includes(settings.kind) ? settings.kind : "openai";
  const defaults = kind === "lmstudio" ? { model: "local-model", baseUrl: "http://127.0.0.1:1234/v1" } : kind === "ollama" ? { model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" } : { model: "gpt-5.6", baseUrl: "https://api.openai.com/v1" };
  return { kind, model: String(settings.model || defaults.model).trim(), baseUrl: String(settings.baseUrl || defaults.baseUrl).replace(/\/$/, "") };
}

async function resolveSecret(supplied) {
  if (typeof supplied === "string" && supplied.length) return supplied;
  const session = await chrome.storage.session.get(SESSION_KEY);
  return session[SESSION_KEY] || "";
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
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: options.maxTokens || 700 })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check the address and, for local AI, make sure the server is running.");
  } finally { clearTimeout(timeout); }
  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (!response.ok) throw coded("PROVIDER_ERROR", body?.error?.message || `The AI service returned HTTP ${response.status}.`);
  if (!body) throw coded("BAD_PROVIDER_JSON", "The AI service returned a response BrowserCrew could not read.");
  return body;
}

function parseJsonObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw coded("BAD_MODEL_JSON", "The AI did not return the requested structured form plan.");
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { throw coded("BAD_MODEL_JSON", "The AI returned invalid JSON. Try the preview again or choose a more capable model."); }
}

async function digestString(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateFormPayload(payload) {
  if (!payload?.details?.trim()) throw coded("MISSING_FORM_DETAILS", "Tell BrowserCrew exactly what information you want placed into the form.");
  if (!payload?.tab?.id || !payload?.tab?.url) throw coded("MISSING_TAB", "Choose the page containing the form first.");
  if (!payload?.settings?.model || !payload?.settings?.baseUrl) throw coded("MISSING_PROVIDER", "Choose and test an AI connection first.");
}

function cleanNullable(value) { if (value === null || value === undefined) return null; const text = String(value).trim(); return text || null; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function serializeError(error) { return { code: error?.code || "UNKNOWN_ERROR", message: error?.message || "Something unexpected happened." }; }

async function getTasks() { const data = await chrome.storage.local.get(STORAGE_KEY); return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []; }
async function getTask(id) { return (await getTasks()).find((task) => task.id === id) || null; }
async function upsertTask(task) {
  const tasks = await getTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks[index] = task; else tasks.unshift(task);
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) });
}
async function mutateTask(id, mutate) {
  const task = await getTask(id);
  if (!task) throw coded("TASK_NOT_FOUND", "This saved job could not be found.");
  mutate(task); task.updatedAt = new Date().toISOString(); await upsertTask(task); return task;
}
async function transition(id, status, checkpoint, error = null) { return mutateTask(id, (task) => { task.status = status; task.checkpoint = checkpoint; if (error) task.error = error; }); }
async function journal(id, type, data) { return mutateTask(id, (task) => { task.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, data }); task.checkpoint = type; }); }
async function completeTask(id, result) { return mutateTask(id, (task) => { task.status = "completed"; task.checkpoint = "completed"; task.result = result; task.error = null; }); }
