const STORAGE_KEY = "browsercrew.tasks.v1";
const SESSION_KEY = "browsercrew.providerSecret.v1";
const DIRECTORY_PORT = "browsercrew-directory-extract";
const MAX_DIRECTORY_PAGES = 10;
const MAX_DIRECTORY_COLUMNS = 12;
const MAX_ROWS_PER_PAGE = 200;
const MAX_PAGE_CHARS = 30000;
const activeDirectoryRuns = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DIRECTORY_PORT) return;

  port.onMessage.addListener((message) => {
    if (message?.type === "RUN_DIRECTORY_TASK") {
      runDirectoryTask(message.payload, (progress) => safePost(port, progress))
        .then((task) => safePost(port, { type: "DIRECTORY_DONE", ok: task.status === "completed" || task.status === "partially_completed", task }))
        .catch((error) => safePost(port, { type: "DIRECTORY_DONE", ok: false, error: serializeError(error) }));
      return;
    }

    if (message?.type === "CANCEL_DIRECTORY_TASK") {
      const run = activeDirectoryRuns.get(message.taskId);
      if (run) {
        run.cancelled = true;
        run.controller?.abort();
      }
      safePost(port, { type: "DIRECTORY_CANCELLED", taskId: message.taskId });
    }
  });

  port.onDisconnect.addListener(() => {
    for (const run of activeDirectoryRuns.values()) {
      if (run.port === port) {
        run.cancelled = true;
        run.controller?.abort();
      }
    }
  });
});

async function runDirectoryTask(payload, postProgress) {
  const input = validateDirectoryPayload(payload);
  const settings = normalizeSettings(input.settings);
  const task = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    kind: "directory_extract",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: `Extract a paginated directory into ${input.columns.join(", ")}`,
    status: "running",
    selectedResource: input.tab,
    inputs: {
      columns: input.columns,
      dedupeKey: input.dedupeKey,
      pageLimit: input.pageLimit
    },
    providerRef: { kind: settings.kind, model: settings.model, baseUrl: settings.baseUrl },
    checkpoint: "directory_started",
    journal: [],
    result: null,
    error: null
  };
  await upsertTask(task);

  const run = { taskId: task.id, cancelled: false, controller: null, port: null };
  activeDirectoryRuns.set(task.id, run);
  postProgress({ type: "DIRECTORY_PROGRESS", taskId: task.id, currentPage: 0, pageLimit: input.pageLimit, message: "Starting directory extraction…" });

  try {
    await ensureSitePermission(input.tab.url);
    await ensureProviderPermission(settings.baseUrl);
    const secret = await resolveSecret(input.secret);
    const origin = new URL(input.tab.url).origin;
    const visited = new Set();
    const rawRows = [];
    const pageEvidence = [];
    const droppedRows = [];
    let currentUrl = input.tab.url;
    let pageLimitReached = false;

    for (let pageNumber = 1; pageNumber <= input.pageLimit; pageNumber += 1) {
      assertNotCancelled(run);
      postProgress({
        type: "DIRECTORY_PROGRESS",
        taskId: task.id,
        currentPage: pageNumber,
        pageLimit: input.pageLimit,
        message: `Reading page ${pageNumber} of up to ${input.pageLimit}…`
      });

      if (visited.has(currentUrl)) {
        throw coded("PAGINATION_LOOP", "The directory sent BrowserCrew back to a page it already read, so the job stopped instead of looping.");
      }
      visited.add(currentUrl);

      const observation = await observeDirectoryPage(input.tab.id, currentUrl);
      if (new URL(observation.url).origin !== origin) {
        throw coded("DIRECTORY_LEFT_SITE", "The directory's next page moved to another site. BrowserCrew stopped before reading it.");
      }

      await journal(task.id, "directory_page_observed", {
        pageNumber,
        url: observation.url,
        title: observation.title,
        hasNextPage: Boolean(observation.nextUrl)
      });

      assertNotCancelled(run);
      postProgress({
        type: "DIRECTORY_PROGRESS",
        taskId: task.id,
        currentPage: pageNumber,
        pageLimit: input.pageLimit,
        message: `Extracting rows from page ${pageNumber}…`
      });

      const modelRows = await extractRowsWithModel(settings, secret, input.columns, observation, run);
      const verified = verifyDirectoryRows(modelRows, input.columns, input.dedupeKey, observation, pageNumber);

      rawRows.push(...verified.rows);
      droppedRows.push(...verified.droppedRows);
      pageEvidence.push({
        pageNumber,
        sourceUrl: observation.url,
        pageTitle: observation.title,
        extractedRows: modelRows.length,
        acceptedRows: verified.rows.length,
        droppedRows: verified.droppedRows.length
      });

      await mutateTask(task.id, (current) => {
        current.checkpoint = "directory_page_verified";
        current.journal.push({
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          type: "directory_page_verified",
          data: pageEvidence.at(-1)
        });
      });

      assertNotCancelled(run);
      if (!observation.nextUrl) break;

      if (pageNumber === input.pageLimit) {
        pageLimitReached = true;
        break;
      }

      const next = new URL(observation.nextUrl, observation.url);
      if (next.origin !== origin) {
        throw coded("DIRECTORY_LEFT_SITE", "The directory's next page points to another site. BrowserCrew stopped instead of following it.");
      }
      if (visited.has(next.href)) {
        throw coded("PAGINATION_LOOP", "The directory's Next link points to a page BrowserCrew already read, so the job stopped instead of looping.");
      }

      postProgress({
        type: "DIRECTORY_PROGRESS",
        taskId: task.id,
        currentPage: pageNumber,
        pageLimit: input.pageLimit,
        message: `Moving to page ${pageNumber + 1}…`
      });
      await navigateSelectedTab(input.tab.id, next.href, origin, run);
      currentUrl = next.href;
    }

    assertNotCancelled(run);
    const deduped = explainAndDedupeRows(rawRows, input.columns, input.dedupeKey);
    if (!deduped.rows.length) {
      throw coded("NO_DIRECTORY_ROWS", "BrowserCrew could not verify any directory rows with the columns you requested.");
    }

    const status = droppedRows.length ? "partially_completed" : "completed";
    const result = {
      kind: "directory_extract",
      schema: input.columns,
      dedupeKey: input.dedupeKey,
      rows: deduped.rows,
      duplicates: deduped.duplicates,
      droppedRows,
      pageCount: pageEvidence.length,
      pageLimit: input.pageLimit,
      pageLimitReached,
      sourceUrls: pageEvidence.map((item) => item.sourceUrl),
      evidence: {
        pages: pageEvidence,
        verificationMethod: "Each non-empty field must appear literally in the captured page text before it is exported.",
        duplicateRule: `Rows are compared by ${input.dedupeKey}. Exact duplicates are removed. Conflicting duplicates are kept and flagged.`,
        pageLimitReached
      },
      model: settings.model
    };

    await mutateTask(task.id, (current) => {
      current.status = status;
      current.checkpoint = status === "completed" ? "completed" : "directory_partial";
      current.result = result;
      current.error = droppedRows.length ? {
        code: "ROWS_DROPPED",
        message: `${droppedRows.length} row${droppedRows.length === 1 ? " was" : "s were"} omitted because the duplicate key was missing or unverified.`
      } : null;
    });

    return await getTask(task.id);
  } catch (error) {
    if (run.cancelled || error?.code === "DIRECTORY_CANCELLED") {
      await transition(task.id, "cancelled", "directory_cancelled", {
        code: "DIRECTORY_CANCELLED",
        message: "Directory extraction stopped. BrowserCrew did not read another page after the stop was recorded."
      });
      return await getTask(task.id);
    }
    await transition(task.id, "failed", "directory_failed", serializeError(error));
    return await getTask(task.id);
  } finally {
    activeDirectoryRuns.delete(task.id);
  }
}

function validateDirectoryPayload(payload) {
  if (!payload?.tab?.id || !payload?.tab?.url) {
    throw coded("MISSING_TAB", "Choose the first directory page before starting.");
  }

  let url;
  try { url = new URL(payload.tab.url); } catch { throw coded("BAD_TAB_URL", "The selected page address is not valid."); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw coded("UNSUPPORTED_PAGE", "BrowserCrew can extract directories only from normal website pages.");
  }

  const columns = [...new Set((Array.isArray(payload.columns) ? payload.columns : [])
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))];

  if (!columns.length) throw coded("MISSING_SCHEMA", "Add at least one column so BrowserCrew knows what each exported row should contain.");
  if (columns.length > MAX_DIRECTORY_COLUMNS) throw coded("TOO_MANY_COLUMNS", `Use no more than ${MAX_DIRECTORY_COLUMNS} columns for one directory job.`);

  const dedupeKey = String(payload.dedupeKey || columns[0]).trim();
  if (!columns.includes(dedupeKey)) throw coded("BAD_DEDUPE_KEY", "Choose one of your exported columns for duplicate checking.");

  const pageLimit = Math.max(1, Math.min(MAX_DIRECTORY_PAGES, Number.parseInt(payload.pageLimit, 10) || 1));
  if (!payload?.settings?.model || !payload?.settings?.baseUrl) throw coded("MISSING_PROVIDER", "Choose and test an AI connection first.");

  return { tab: payload.tab, columns, dedupeKey, pageLimit, settings: payload.settings, secret: payload.secret };
}

async function observeDirectoryPage(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || tab.url !== expectedUrl) {
    throw coded("PAGE_CHANGED", "The selected tab changed while BrowserCrew was extracting the directory. The job stopped instead of reading a different page.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxChars) => {
      const text = String(document.body?.innerText || "").replace(/\u0000/g, "").slice(0, maxChars);
      const anchors = [...document.querySelectorAll("a[href]")];
      const direct = document.querySelector('a[rel~="next"], a[aria-label*="next" i], .pagination a.next, .pager a.next, a.next');
      const byText = anchors.find((anchor) => /^(next|next page|older|more|›|»|→)\s*$/i.test(String(anchor.innerText || anchor.textContent || "").trim()));
      const candidate = direct || byText || null;
      return {
        title: document.title,
        url: location.href,
        text,
        nextUrl: candidate?.href || null
      };
    },
    args: [MAX_PAGE_CHARS]
  });

  if (!result) throw coded("DIRECTORY_OBSERVE_FAILED", "BrowserCrew could not read this directory page.");
  return { ...result, observedAt: new Date().toISOString() };
}

async function navigateSelectedTab(tabId, nextUrl, expectedOrigin, run) {
  assertNotCancelled(run);
  if (new URL(nextUrl).origin !== expectedOrigin) {
    throw coded("DIRECTORY_LEFT_SITE", "BrowserCrew will not follow a directory Next link to another site.");
  }

  await chrome.tabs.update(tabId, { url: nextUrl });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assertNotCancelled(run);
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && new URL(tab.url).origin !== expectedOrigin) {
      throw coded("DIRECTORY_LEFT_SITE", "The selected tab left the approved site while moving to the next directory page.");
    }
    if (tab?.url === nextUrl && tab.status === "complete") return;
    await delay(120);
  }
  throw coded("PAGE_LOAD_TIMEOUT", "The next directory page did not finish loading within 20 seconds.");
}

async function extractRowsWithModel(settings, secret, columns, observation, run) {
  const schema = columns.map((label, index) => ({ ref: `column-${index}`, label }));
  const instruction = 'Return only JSON with this shape: {"rows":[{"values":{"column-0":"literal value or null"}}]}. Include every declared column ref in every row. Copy values exactly as visible on the page. Use null when a value is missing. Do not combine separate people or companies into one row.';
  const response = await callOpenAICompatible(settings, secret, [
    { role: "system", content: `You extract structured directory rows from one browser page. ${instruction}` },
    { role: "user", content: `Declared columns:\n${JSON.stringify(schema)}\n\nPage title: ${observation.title}\nPage address: ${observation.url}\n\nPage text:\n${observation.text}` }
  ], run);

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw coded("BAD_MODEL_RESPONSE", "The AI answered in a format BrowserCrew could not read.");
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed?.rows)) throw coded("BAD_DIRECTORY_ROWS", "The AI did not return directory rows in the requested structure.");
  return parsed.rows.slice(0, MAX_ROWS_PER_PAGE);
}

function verifyDirectoryRows(modelRows, columns, dedupeKey, observation, pageNumber) {
  const schema = columns.map((label, index) => ({ ref: `column-${index}`, label }));
  const haystack = normalizeLiteral(observation.text);
  const rows = [];
  const droppedRows = [];

  for (let index = 0; index < modelRows.length; index += 1) {
    const rawValues = modelRows[index]?.values && typeof modelRows[index].values === "object" ? modelRows[index].values : {};
    const values = {};
    const unverifiedFields = [];

    for (const column of schema) {
      const raw = rawValues[column.ref];
      const value = raw === null || raw === undefined ? null : String(raw).replace(/\s+/g, " ").trim().slice(0, 4000);
      if (!value) {
        values[column.label] = null;
        continue;
      }
      if (!haystack.includes(normalizeLiteral(value))) {
        values[column.label] = null;
        unverifiedFields.push(column.label);
        continue;
      }
      values[column.label] = value;
    }

    if (!values[dedupeKey]) {
      droppedRows.push({
        pageNumber,
        sourceUrl: observation.url,
        rowNumber: index + 1,
        reason: `Row omitted because ${dedupeKey} was missing or could not be verified against the page text.`,
        unverifiedFields
      });
      continue;
    }

    rows.push({
      values,
      sourceUrl: observation.url,
      sourcePage: pageNumber,
      verification: unverifiedFields.length ? "partial" : "verified",
      unverifiedFields,
      duplicateStatus: null
    });
  }

  return { rows, droppedRows };
}

function explainAndDedupeRows(rows, columns, dedupeKey) {
  const firstByKey = new Map();
  const kept = [];
  const duplicates = [];

  for (const row of rows) {
    const identity = normalizeKey(row.values[dedupeKey]);
    const first = firstByKey.get(identity);
    if (!first) {
      firstByKey.set(identity, row);
      kept.push(row);
      continue;
    }

    const differingColumns = columns.filter((column) => normalizeKey(first.values[column]) !== normalizeKey(row.values[column]));
    if (!differingColumns.length) {
      duplicates.push({
        key: row.values[dedupeKey],
        type: "exact",
        keptSourceUrl: first.sourceUrl,
        duplicateSourceUrl: row.sourceUrl,
        message: `Exact duplicate removed. ${dedupeKey} and all exported values matched the first occurrence.`
      });
      continue;
    }

    row.duplicateStatus = `Conflict with earlier ${dedupeKey}: ${differingColumns.join(", ")}`;
    kept.push(row);
    duplicates.push({
      key: row.values[dedupeKey],
      type: "conflict",
      keptSourceUrl: first.sourceUrl,
      duplicateSourceUrl: row.sourceUrl,
      differingColumns,
      message: `Duplicate ${dedupeKey} had different values for ${differingColumns.join(", ")}. Both rows were kept for review.`
    });
  }

  return { rows: kept, duplicates };
}

function normalizeSettings(settings = {}) {
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

async function callOpenAICompatible(settings, secret, messages, run) {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const controller = new AbortController();
  run.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, max_tokens: 1800 })
    });
  } catch (error) {
    if (run.cancelled) throw coded("DIRECTORY_CANCELLED", "Directory extraction was stopped.");
    if (error?.name === "AbortError") throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check the address and make sure a local server is running when you use local AI.");
  } finally {
    clearTimeout(timeout);
    if (run.controller === controller) run.controller = null;
  }

  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (!response.ok) throw coded("PROVIDER_ERROR", body?.error?.message || `The AI service returned HTTP ${response.status}.`);
  if (!body) throw coded("BAD_PROVIDER_JSON", "The AI service returned a response BrowserCrew could not read.");
  return body;
}

async function ensureSitePermission(urlText) {
  const url = new URL(urlText);
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    throw coded("SITE_PERMISSION_DENIED", "BrowserCrew does not have access to this directory site. Choose the first page and approve Chrome's permission prompt.");
  }
}

async function ensureProviderPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw coded("UNSAFE_PROVIDER_URL", "Cloud AI connections must use HTTPS. Plain HTTP is allowed only for local AI on this computer.");
  }
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    throw coded("PROVIDER_PERMISSION_DENIED", "BrowserCrew does not have permission to contact this AI address. Test the AI connection first.");
  }
}

async function resolveSecret(supplied) {
  if (typeof supplied === "string" && supplied.length) return supplied;
  const session = await chrome.storage.session.get(SESSION_KEY);
  return session[SESSION_KEY] || "";
}

function parseJsonObject(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw coded("BAD_MODEL_JSON", "The AI did not return the requested structured directory data.");
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { throw coded("BAD_MODEL_JSON", "The AI returned invalid JSON for the directory rows."); }
}

function normalizeLiteral(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeKey(value) {
  return normalizeLiteral(value);
}

function assertNotCancelled(run) {
  if (run.cancelled) throw coded("DIRECTORY_CANCELLED", "Directory extraction was stopped.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePost(port, message) {
  try { port.postMessage(message); } catch {}
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeError(error) {
  return { code: error?.code || "UNKNOWN_ERROR", message: error?.message || "Something unexpected happened." };
}

async function getTasks() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function getTask(id) {
  return (await getTasks()).find((task) => task.id === id) || null;
}

async function upsertTask(task) {
  const tasks = await getTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks[index] = task;
  else tasks.unshift(task);
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks.slice(0, 100) });
}

async function mutateTask(id, mutate) {
  const task = await getTask(id);
  if (!task) throw coded("TASK_NOT_FOUND", "This saved directory job could not be found.");
  mutate(task);
  task.updatedAt = new Date().toISOString();
  await upsertTask(task);
  return task;
}

async function transition(id, status, checkpoint, error = null) {
  return mutateTask(id, (task) => {
    task.status = status;
    task.checkpoint = checkpoint;
    if (error) task.error = error;
  });
}

async function journal(id, type, data) {
  return mutateTask(id, (task) => {
    task.journal.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, data });
    task.checkpoint = type;
  });
}
