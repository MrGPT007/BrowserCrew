const STORAGE_KEY = "browsercrew.tasks.v1";
const SESSION_KEY = "browsercrew.providerSecret.v1";
const RECORD_PORT = "browsercrew-record-update";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== RECORD_PORT) return;
  port.onMessage.addListener((message) => {
    handleRecordMessage(message).then((response) => {
      try { port.postMessage(response); } catch {}
    }).catch((error) => {
      try { port.postMessage({ ok: false, error: serializeRecordError(error) }); } catch {}
    });
  });
});

reconcilePendingRecordWrites().catch(() => {});

async function handleRecordMessage(message) {
  switch (message?.type) {
    case "PREVIEW_RECORD_TASK": return previewRecordTask(message.payload);
    case "COMMIT_RECORD_TASK": return commitRecordTask(message.taskId, message.approvedChangeHash);
    case "CANCEL_RECORD_TASK": return cancelRecordTask(message.taskId);
    default: return { ok: false, error: { code: "UNKNOWN_RECORD_MESSAGE", message: "BrowserCrew received an unknown record request." } };
  }
}

async function previewRecordTask(payload) {
  validateRecordPayload(payload);
  const settings = normalizeRecordSettings(payload.settings);
  const task = {
    id: crypto.randomUUID(), schemaVersion: 1, kind: "record_update",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    goal: payload.details.trim(), status: "planning", selectedResource: payload.tab,
    providerRef: { kind: settings.kind, model: settings.model, baseUrl: settings.baseUrl },
    checkpoint: "created", journal: [], recordPlan: null, grant: null, result: null, error: null
  };
  await upsertRecordTask(task);

  try {
    await ensureRecordSitePermission(payload.tab.url);
    const observation = await observeRecord(payload.tab.id, payload.tab.url);
    if (!observation.fields.length) throw recordError("NO_EDITABLE_RECORD", "I could not find editable fields on this record page.");
    if (!observation.save?.available) throw recordError("NO_SAVE_ACTION", "I could not find a supported Save action for this record.");
    await journalRecord(task.id, "record_observation.complete", {
      url: observation.url,
      recordId: observation.recordId,
      fieldCount: observation.fields.length,
      recordFingerprint: observation.recordFingerprint,
      receiptBefore: observation.receipt
    });

    const secret = await resolveRecordSecret(payload.secret);
    await ensureRecordProviderPermission(settings.baseUrl);
    const mapped = await mapRecordWithModel(settings, secret, payload.details, observation);
    const changes = validateRecordChanges(mapped.data, observation, payload.details);
    const changeHash = await digestRecordString(JSON.stringify({
      recordId: observation.recordId,
      url: observation.url,
      recordFingerprint: observation.recordFingerprint,
      changes: changes.map(({ ref, value }) => ({ ref, value }))
    }));
    const grant = {
      id: crypto.randomUUID(),
      origin: new URL(observation.url).origin,
      resourceScope: observation.url,
      recordId: observation.recordId,
      actionClass: "record.update",
      changeHash,
      state: "pending",
      createdAt: new Date().toISOString()
    };

    await mutateRecordTask(task.id, (current) => {
      current.status = "awaiting_approval";
      current.checkpoint = "record_preview_ready";
      current.recordPlan = {
        pageTitle: observation.title,
        url: observation.url,
        recordId: observation.recordId,
        recordFingerprint: observation.recordFingerprint,
        observedAt: observation.observedAt,
        receiptBefore: observation.receipt,
        saveLabel: observation.save.label,
        changes,
        notes: cleanRecordNullable(mapped.data?.notes) || "No extra notes.",
        changeHash
      };
      current.grant = grant;
    });

    return { ok: true, task: await getRecordTask(task.id) };
  } catch (error) {
    await transitionRecordTask(task.id, "failed", "record_preview_failed", serializeRecordError(error));
    return { ok: false, task: await getRecordTask(task.id), error: serializeRecordError(error) };
  }
}

async function commitRecordTask(taskId, approvedChangeHash) {
  const task = await getRecordTask(taskId);
  if (!task || task.kind !== "record_update") throw recordError("RECORD_TASK_NOT_FOUND", "This record preview could not be found.");
  if (task.status !== "awaiting_approval" || task.checkpoint !== "record_preview_ready") {
    throw recordError("RECORD_NOT_READY", "This record preview is no longer waiting for approval. Prepare a fresh preview before saving anything.");
  }
  if (!approvedChangeHash || approvedChangeHash !== task.recordPlan?.changeHash || approvedChangeHash !== task.grant?.changeHash) {
    throw recordError("APPROVAL_MISMATCH", "The record changes no longer match the preview you approved. Prepare a fresh preview.");
  }

  await ensureRecordSitePermission(task.selectedResource.url);
  const before = await observeRecord(task.selectedResource.id, task.selectedResource.url);
  if (before.recordId !== task.recordPlan.recordId || before.recordFingerprint !== task.recordPlan.recordFingerprint) {
    return blockChangedRecord(task.id, "The selected record changed after the preview. BrowserCrew did not save anything. Prepare a fresh preview.");
  }
  for (const change of task.recordPlan.changes) {
    const field = before.fields.find((item) => item.ref === change.ref);
    if (!field || field.currentValue !== change.before) {
      return blockChangedRecord(task.id, "A record field changed after the preview. BrowserCrew did not overwrite it. Prepare a fresh preview.");
    }
  }

  const actionId = crypto.randomUUID();
  await mutateRecordTask(task.id, (current) => {
    current.status = "committing";
    current.checkpoint = "record_save_intent";
    current.grant.state = "granted";
    current.grant.grantedAt = new Date().toISOString();
    current.journal.push({
      id: actionId,
      at: new Date().toISOString(),
      type: "record_save.intent",
      data: {
        recordId: current.recordPlan.recordId,
        changeHash: approvedChangeHash,
        receiptBefore: current.recordPlan.receiptBefore,
        fields: current.recordPlan.changes.map(({ ref, label, before: oldValue, value }) => ({ ref, label, before: oldValue, after: value }))
      }
    });
  });

  try {
    await executeRecordSave(task.selectedResource.id, task.selectedResource.url, task.recordPlan.recordId, task.recordPlan.changes);
    await mutateRecordTask(task.id, (current) => {
      current.checkpoint = "record_save_dispatched";
      if (current.grant) current.grant.state = "consumed";
      current.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "record_save.dispatched", data: { actionId } });
    });

    await delayRecord(120);
    const after = await observeRecord(task.selectedResource.id, task.selectedResource.url);
    const verification = verifyRecordChanges(task.recordPlan.changes, after);
    const saveVerified = verifyRecordSaveReceipt(task.recordPlan.receiptBefore, after.receipt);

    if (verification.every((item) => item.matches) && saveVerified.verified) {
      await completeRecordTask(task.id, buildRecordResult(task, after, verification, saveVerified, false));
      return { ok: true, task: await getRecordTask(task.id) };
    }

    const error = {
      code: "RECORD_SAVE_UNVERIFIED",
      message: "BrowserCrew sent the approved Save action, but could not fully verify the saved record. It will not press Save again automatically. Review the record before trying again."
    };
    await mutateRecordTask(task.id, (current) => {
      current.status = "partially_completed";
      current.checkpoint = "record_save_unverified";
      current.error = error;
      current.result = buildRecordResult(task, after, verification, saveVerified, false);
      if (current.grant) current.grant.state = "consumed";
    });
    return { ok: false, task: await getRecordTask(task.id), error };
  } catch (error) {
    await reconcileRecordTask(task.id);
    const reconciled = await getRecordTask(task.id);
    return {
      ok: reconciled?.status === "completed",
      task: reconciled,
      error: reconciled?.status === "completed" ? undefined : (reconciled?.error || serializeRecordError(error))
    };
  }
}

async function cancelRecordTask(taskId) {
  const task = await getRecordTask(taskId);
  if (!task || task.kind !== "record_update") throw recordError("RECORD_TASK_NOT_FOUND", "This record preview could not be found.");
  if (task.status !== "awaiting_approval") throw recordError("RECORD_NOT_CANCELLABLE", "This record preview is no longer waiting for approval.");
  await mutateRecordTask(taskId, (current) => {
    current.status = "cancelled";
    current.checkpoint = "record_preview_cancelled";
    if (current.grant) current.grant.state = "revoked";
  });
  return { ok: true, task: await getRecordTask(taskId) };
}

async function blockChangedRecord(taskId, message) {
  const error = { code: "RECORD_CHANGED", message };
  await transitionRecordTask(taskId, "awaiting_user", "record_changed", error);
  return { ok: false, task: await getRecordTask(taskId), error };
}

async function observeRecord(tabId, expectedUrl) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { throw recordError("RECORD_TAB_GONE", "The selected record tab is no longer open."); }
  if (!tab?.url || tab.url !== expectedUrl) throw recordError("PAGE_CHANGED", "The selected tab changed. BrowserCrew will not update a different page.");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const supportedInputTypes = new Set(["text", "email", "tel", "url", "search", "number"]);
      const root = document.querySelector("[data-browsercrew-record-id]") || document.querySelector("form[data-record-id]");
      if (!root) return { ok: false, code: "UNSUPPORTED_RECORD_PAGE" };
      const recordId = clean(root.getAttribute("data-browsercrew-record-id") || root.getAttribute("data-record-id"));
      if (!recordId) return { ok: false, code: "MISSING_RECORD_ID" };

      const elements = [...root.querySelectorAll("input, textarea, select")].filter((element) => {
        if (element.disabled || element.readOnly) return false;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
        return supportedInputTypes.has((element.type || "text").toLowerCase());
      }).slice(0, 40);

      const fields = elements.map((element, index) => {
        const label = clean(element.labels?.[0]?.innerText || element.getAttribute("aria-label") || element.placeholder || element.name || element.id || `Field ${index + 1}`);
        const type = element instanceof HTMLTextAreaElement ? "textarea" : element instanceof HTMLSelectElement ? "select-one" : (element.type || "text").toLowerCase();
        const options = element instanceof HTMLSelectElement
          ? [...element.options].slice(0, 50).map((option) => ({ value: option.value, label: clean(option.textContent) }))
          : [];
        return {
          ref: `field-${index}`,
          label,
          name: clean(element.name),
          type,
          currentValue: String(element.value || "").slice(0, 5000),
          options
        };
      });

      const candidateButtons = [...root.querySelectorAll("button, input[type='submit']")];
      const saveButton = root.querySelector("[data-browsercrew-record-save]") || candidateButtons.find((element) => /^save(?: changes)?$/i.test(clean(element.textContent || element.value)));
      const receipt = document.querySelector("[data-browsercrew-record-receipt]");
      const saveCount = Number.parseInt(receipt?.getAttribute("data-save-count") || "0", 10) || 0;
      return {
        ok: true,
        title: document.title,
        url: location.href,
        recordId,
        fields,
        save: { available: Boolean(saveButton), label: saveButton ? clean(saveButton.textContent || saveButton.value || "Save") : "" },
        receipt: { text: clean(receipt?.textContent || ""), saveCount }
      };
    }
  });

  if (!result?.ok) {
    if (result?.code === "UNSUPPORTED_RECORD_PAGE") throw recordError("UNSUPPORTED_RECORD_PAGE", "This page is not a supported record editor yet. Open a record page BrowserCrew can identify and try again.");
    if (result?.code === "MISSING_RECORD_ID") throw recordError("MISSING_RECORD_ID", "BrowserCrew could not identify which record this page edits.");
    throw recordError("RECORD_OBSERVE_FAILED", "BrowserCrew could not inspect this record page.");
  }

  const recordFingerprint = await digestRecordString(JSON.stringify({
    recordId: result.recordId,
    fields: result.fields.map(({ ref, label, name, type, options }) => ({ ref, label, name, type, options })),
    saveLabel: result.save.label
  }));
  return { ...result, recordFingerprint, observedAt: new Date().toISOString() };
}

async function mapRecordWithModel(settings, secret, details, observation) {
  const fieldSchema = observation.fields.map(({ ref, label, name, type, currentValue, options }) => ({ ref, label, name, type, currentValue, options }));
  const instruction = 'Return only JSON with this shape: {"changes":[{"ref":"field-0","value":"exact requested value"}],"notes":"short note"}. Use only supplied field refs. Change only fields clearly requested by the user. Every proposed value must come from the user-provided details. Do not invent values.';
  const response = await callRecordProvider(settings, secret, [
    { role: "system", content: `You map explicit user-requested changes to one existing web-app record. ${instruction}` },
    { role: "user", content: `Record ID: ${observation.recordId}\n\nUser-requested changes:\n${details}\n\nEditable record fields:\n${JSON.stringify(fieldSchema)}` }
  ]);
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw recordError("BAD_MODEL_RESPONSE", "The AI answered in a format BrowserCrew could not read.");
  return { data: parseRecordJson(content), model: response.model || settings.model };
}

function validateRecordChanges(data, observation, userDetails) {
  if (!Array.isArray(data?.changes)) throw recordError("BAD_RECORD_PLAN", "The AI did not return a usable record-change preview.");
  const fields = new Map(observation.fields.map((field) => [field.ref, field]));
  const detailText = normalizeRecordText(userDetails);
  const seen = new Set();
  const changes = [];

  for (const raw of data.changes.slice(0, 20)) {
    const ref = String(raw?.ref || "");
    if (!fields.has(ref) || seen.has(ref)) continue;
    const field = fields.get(ref);
    let value = raw?.value === null || raw?.value === undefined ? "" : String(raw.value);
    if (value.length > 5000) throw recordError("RECORD_VALUE_TOO_LONG", `The proposed value for ${field.label} is too long.`);

    let userFacingValue = value;
    if (field.type === "select-one") {
      const exact = field.options.find((option) => option.value === value) || field.options.find((option) => option.label.toLowerCase() === value.toLowerCase());
      if (!exact) throw recordError("BAD_RECORD_SELECT", `The proposed choice for ${field.label} is not one of the available options.`);
      value = exact.value;
      userFacingValue = exact.label || exact.value;
    }

    const normalizedCandidate = normalizeRecordText(userFacingValue || value);
    if (normalizedCandidate && !detailText.includes(normalizedCandidate)) {
      throw recordError("RECORD_VALUE_NOT_SUPPLIED", `The proposed value for ${field.label} was not found in what you typed. Use a clear “Field: value” line and preview again.`);
    }
    if (field.currentValue === value) continue;

    seen.add(ref);
    changes.push({
      ref,
      label: field.label,
      name: field.name,
      type: field.type,
      before: field.currentValue,
      value,
      afterLabel: userFacingValue
    });
  }

  if (!changes.length) throw recordError("NO_RECORD_CHANGES", "BrowserCrew could not find a requested change that differs from the current record. Use clear “Field: value” lines.");
  return changes;
}

async function executeRecordSave(tabId, expectedUrl, recordId, changes) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expected, expectedRecordId, targets) => {
      if (location.href !== expected) return { ok: false, code: "PAGE_CHANGED" };
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const supportedInputTypes = new Set(["text", "email", "tel", "url", "search", "number"]);
      const root = document.querySelector("[data-browsercrew-record-id]") || document.querySelector("form[data-record-id]");
      if (!root) return { ok: false, code: "RECORD_MISSING" };
      const actualRecordId = clean(root.getAttribute("data-browsercrew-record-id") || root.getAttribute("data-record-id"));
      if (actualRecordId !== expectedRecordId) return { ok: false, code: "RECORD_CHANGED" };

      const elements = [...root.querySelectorAll("input, textarea, select")].filter((element) => {
        if (element.disabled || element.readOnly) return false;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
        return supportedInputTypes.has((element.type || "text").toLowerCase());
      }).slice(0, 40);

      for (const target of targets) {
        const index = Number(String(target.ref).replace("field-", ""));
        const element = elements[index];
        if (!element) return { ok: false, code: "FIELD_MISSING", ref: target.ref };
        const type = element instanceof HTMLTextAreaElement ? "textarea" : element instanceof HTMLSelectElement ? "select-one" : (element.type || "text").toLowerCase();
        if (type !== target.type || clean(element.name) !== clean(target.name) || String(element.value || "") !== target.before) {
          return { ok: false, code: "FIELD_CHANGED", ref: target.ref };
        }
      }

      const candidateButtons = [...root.querySelectorAll("button, input[type='submit']")];
      const saveButton = root.querySelector("[data-browsercrew-record-save]") || candidateButtons.find((element) => /^save(?: changes)?$/i.test(clean(element.textContent || element.value)));
      if (!saveButton) return { ok: false, code: "SAVE_MISSING" };

      for (const target of targets) {
        const index = Number(String(target.ref).replace("field-", ""));
        const element = elements[index];
        if (element instanceof HTMLSelectElement) {
          element.value = target.value;
        } else {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(element, target.value); else element.value = target.value;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }

      saveButton.click();
      return { ok: true, recordId: actualRecordId };
    },
    args: [expectedUrl, recordId, changes.map(({ ref, name, type, before, value }) => ({ ref, name, type, before, value }))]
  });

  if (!result?.ok) {
    const messages = {
      PAGE_CHANGED: "The selected page changed before BrowserCrew could save.",
      RECORD_MISSING: "The record editor disappeared before BrowserCrew could save.",
      RECORD_CHANGED: "The record identity changed before BrowserCrew could save.",
      FIELD_MISSING: "A record field disappeared before BrowserCrew could save.",
      FIELD_CHANGED: "A record field changed after approval. BrowserCrew stopped instead of overwriting it.",
      SAVE_MISSING: "The Save action disappeared before BrowserCrew could use it."
    };
    throw recordError(result?.code || "RECORD_SAVE_FAILED", messages[result?.code] || "BrowserCrew could not safely save this record.");
  }
  return result;
}

function verifyRecordChanges(changes, observation) {
  return changes.map((change) => {
    const field = observation.fields.find((item) => item.ref === change.ref);
    const actual = field?.currentValue;
    return { ref: change.ref, label: change.label, expected: change.value, actual, matches: Boolean(field) && actual === change.value };
  });
}

function verifyRecordSaveReceipt(beforeReceipt, afterReceipt) {
  const before = beforeReceipt || { text: "", saveCount: 0 };
  const after = afterReceipt || { text: "", saveCount: 0 };
  const countAdvanced = Number(after.saveCount || 0) > Number(before.saveCount || 0);
  const textChanged = Boolean(after.text) && after.text !== before.text;
  return {
    verified: countAdvanced || textChanged,
    before,
    after,
    method: countAdvanced ? "save receipt count advanced" : textChanged ? "save receipt changed" : "no independent save receipt changed"
  };
}

function buildRecordResult(task, observation, verification, saveVerification, recovered) {
  return {
    kind: "record_update",
    recordId: task.recordPlan.recordId,
    recordChanges: task.recordPlan.changes.map((change) => ({
      label: change.label,
      before: change.before,
      after: change.value,
      afterLabel: change.afterLabel
    })),
    evidence: {
      sourceUrl: observation.url,
      pageTitle: observation.title,
      observedAt: observation.observedAt,
      recordId: observation.recordId,
      verification: verification.map((item) => item.matches ? `${item.label} matches the approved saved value.` : `${item.label} could not be verified.`),
      saveReceipt: saveVerification,
      recovered: Boolean(recovered),
      verificationMethod: "Record identity + field values + page save receipt"
    }
  };
}

async function reconcilePendingRecordWrites() {
  const tasks = await getRecordTasks();
  for (const task of tasks) {
    if (task?.kind !== "record_update") continue;
    if (task.status === "committing" || ["record_save_intent", "record_save_dispatched"].includes(task.checkpoint)) {
      await reconcileRecordTask(task.id);
    }
  }
}

async function reconcileRecordTask(taskId) {
  const task = await getRecordTask(taskId);
  if (!task?.recordPlan || !task?.selectedResource) return;

  await mutateRecordTask(taskId, (current) => {
    current.status = "recovering";
    current.checkpoint = "record_reconciling";
    if (current.grant) current.grant.state = "consumed";
  });

  try {
    const observation = await observeRecord(task.selectedResource.id, task.selectedResource.url);
    if (observation.recordId !== task.recordPlan.recordId || observation.recordFingerprint !== task.recordPlan.recordFingerprint) {
      return markRecordOutcomeUnknown(taskId, "BrowserCrew restarted after Save may have been pressed, but the record page changed. It will not press Save again automatically.");
    }
    const verification = verifyRecordChanges(task.recordPlan.changes, observation);
    const saveVerified = verifyRecordSaveReceipt(task.recordPlan.receiptBefore, observation.receipt);
    if (verification.every((item) => item.matches) && saveVerified.verified) {
      await completeRecordTask(taskId, buildRecordResult(task, observation, verification, saveVerified, true));
      return;
    }
    await markRecordOutcomeUnknown(taskId, "BrowserCrew restarted around the Save action and could not prove the final saved state. It will not retry the save automatically. Review the record before starting a new update.");
  } catch {
    await markRecordOutcomeUnknown(taskId, "BrowserCrew restarted around the Save action but can no longer inspect the selected record. It will not retry the save automatically.");
  }
}

async function markRecordOutcomeUnknown(taskId, message) {
  await mutateRecordTask(taskId, (current) => {
    current.status = "awaiting_user";
    current.checkpoint = "record_outcome_unknown";
    current.error = { code: "RECORD_OUTCOME_UNKNOWN", message };
    if (current.grant) current.grant.state = "consumed";
  });
}

function validateRecordPayload(payload) {
  if (!payload?.tab?.id || !/^https?:/.test(payload?.tab?.url || "")) throw recordError("MISSING_RECORD_PAGE", "Choose the exact record page first.");
  if (!String(payload?.details || "").trim()) throw recordError("MISSING_RECORD_CHANGES", "Tell BrowserCrew exactly what should change on this record.");
  if (!payload?.settings?.model || !payload?.settings?.baseUrl) throw recordError("MISSING_PROVIDER", "Choose and test an AI connection first.");
}

function normalizeRecordSettings(settings = {}) {
  const kind = ["openai", "lmstudio", "ollama"].includes(settings.kind) ? settings.kind : "openai";
  const defaults = kind === "lmstudio"
    ? { model: "local-model", baseUrl: "http://127.0.0.1:1234/v1" }
    : kind === "ollama"
      ? { model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" }
      : { model: "gpt-5.6", baseUrl: "https://api.openai.com/v1" };
  return {
    kind,
    model: String(settings.model || defaults.model).trim(),
    baseUrl: String(settings.baseUrl || defaults.baseUrl).replace(/\/$/, "")
  };
}

async function ensureRecordSitePermission(urlText) {
  const url = new URL(urlText);
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw recordError("SITE_PERMISSION_DENIED", `BrowserCrew does not have permission to update ${url.hostname}.`);
}

async function ensureRecordProviderPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw recordError("UNSAFE_PROVIDER_URL", "Cloud AI connections must use HTTPS. Plain HTTP is allowed only for local AI on this computer.");
  }
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw recordError("PROVIDER_PERMISSION_DENIED", "BrowserCrew does not have permission to contact this AI address. Test the AI connection first.");
}

async function resolveRecordSecret(supplied) {
  if (typeof supplied === "string" && supplied.length) return supplied;
  const session = await chrome.storage.session.get(SESSION_KEY);
  return session[SESSION_KEY] || "";
}

async function callRecordProvider(settings, secret, messages) {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: 700 })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw recordError("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw recordError("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check the address and make sure the server is running.");
  } finally {
    clearTimeout(timeout);
  }
  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (!response.ok) throw recordError("PROVIDER_ERROR", body?.error?.message || `The AI service returned HTTP ${response.status}.`);
  if (!body) throw recordError("BAD_PROVIDER_JSON", "The AI service returned a response BrowserCrew could not read.");
  return body;
}

function parseRecordJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { throw recordError("BAD_MODEL_JSON", "The AI returned invalid JSON for this record preview."); }
}

async function digestRecordString(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRecordText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanRecordNullable(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function recordError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeRecordError(error) {
  return { code: error?.code || "RECORD_ERROR", message: error?.message || "BrowserCrew could not complete this record update." };
}

function delayRecord(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getRecordTasks() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

async function getRecordTask(taskId) {
  return (await getRecordTasks()).find((task) => task.id === taskId) || null;
}

async function upsertRecordTask(task) {
  const tasks = await getRecordTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks[index] = task; else tasks.unshift(task);
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) });
}

async function mutateRecordTask(taskId, mutate) {
  const tasks = await getRecordTasks();
  const index = tasks.findIndex((item) => item.id === taskId);
  if (index < 0) throw recordError("RECORD_TASK_NOT_FOUND", "This record task could not be found.");
  mutate(tasks[index]);
  tasks[index].updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) });
  return tasks[index];
}

async function journalRecord(taskId, type, data) {
  await mutateRecordTask(taskId, (task) => {
    task.journal = Array.isArray(task.journal) ? task.journal : [];
    task.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, data });
  });
}

async function transitionRecordTask(taskId, status, checkpoint, error = null) {
  await mutateRecordTask(taskId, (task) => {
    task.status = status;
    task.checkpoint = checkpoint;
    task.error = error;
  });
}

async function completeRecordTask(taskId, result) {
  await mutateRecordTask(taskId, (task) => {
    task.status = "completed";
    task.checkpoint = "completed";
    task.result = result;
    task.error = null;
    if (task.grant) task.grant.state = "consumed";
    task.journal = Array.isArray(task.journal) ? task.journal : [];
    task.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "record_save.verified", data: { recordId: result.recordId, recovered: Boolean(result.evidence?.recovered) } });
  });
}
