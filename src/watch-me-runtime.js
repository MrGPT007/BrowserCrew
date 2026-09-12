import { createWatchSession, draftSkillFromWatchSession, recordWatchEvent, stopWatchSession } from "./watch-me-contract.js";
import { saveSkillDraft } from "./skills-runtime.js";

const WATCH_STATE_KEY = "browsercrew.watchMe.v1";
const CONTROL_PORT = "browsercrew-watch-control";
const EVENT_PORT = "browsercrew-watch-events";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === CONTROL_PORT) bindControlPort(port);
  if (port.name === EVENT_PORT) bindEventPort(port);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url || !/^https?:/.test(tab.url)) return;
  handleNavigation(tabId, tab.url).catch(() => {});
});

function bindControlPort(port) {
  port.onMessage.addListener((message) => {
    handleControl(message).then((result) => port.postMessage({ requestId: message?.requestId, ...result })).catch((error) => {
      port.postMessage({ requestId: message?.requestId, ok: false, error: serializeError(error) });
    });
  });
}

function bindEventPort(port) {
  const tabId = port.sender?.tab?.id;
  if (!Number.isInteger(tabId)) return;
  port.onMessage.addListener((message) => {
    if (message?.type !== "event") return;
    appendPageEvent(tabId, message.event).catch(() => {});
  });
}

async function handleControl(message) {
  switch (message?.type) {
    case "start": return startWatching(message.tab);
    case "pause": return setWatchStatus("paused");
    case "resume": return resumeWatching();
    case "stop": return finishWatching(message.draft || {});
    case "get": return { ok: true, state: await getWatchState() };
    case "discard": await chrome.storage.local.remove(WATCH_STATE_KEY); return { ok: true, state: null };
    default: throw coded("WATCH_UNKNOWN_COMMAND", "BrowserCrew received an unknown Watch Me command.");
  }
}

export async function startWatching(tab) {
  if (!tab?.id || !tab?.url || !/^https?:/.test(tab.url)) throw coded("WATCH_PAGE_REQUIRED", "Open a normal website and choose the page you want BrowserCrew to watch.");
  const url = new URL(tab.url);
  const hasAccess = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!hasAccess) throw coded("WATCH_SITE_ACCESS_REQUIRED", "Approve access to this site before BrowserCrew starts watching.");

  const existing = await getWatchState();
  if (existing?.session?.status === "watching") throw coded("WATCH_ALREADY_RUNNING", "BrowserCrew is already watching a demonstration. Stop it before starting another one.");

  const session = createWatchSession({
    id: crypto.randomUUID(),
    tabId: tab.id,
    origin: url.origin,
    startedAt: new Date().toISOString()
  });
  const state = { schemaVersion: 1, session, tabTitle: String(tab.title || "Current page").slice(0, 160), updatedAt: new Date().toISOString() };
  await persistWatchState(state);
  await installPageRecorder(tab.id);
  return { ok: true, state };
}

export async function finishWatching(draftInput = {}) {
  const state = await requireWatchState();
  let session = state.session;
  if (!["watching", "paused", "scope_review"].includes(session.status)) throw coded("WATCH_NOT_ACTIVE", "There is no active demonstration to stop.");
  session = stopWatchSession({ ...session, status: "watching" }, new Date().toISOString());
  await uninstallPageRecorder(session.approvedTabs[0]).catch(() => {});

  const draft = draftSkillFromWatchSession(session, {
    skillId: normalizeSkillId(draftInput.skillId || draftInput.title || "watched-workflow"),
    version: draftInput.version || "0.1.0",
    title: String(draftInput.title || "My recorded browser job").slice(0, 120),
    description: String(draftInput.description || "A draft browser job recorded with Watch me do it. Review every step before approving it.").slice(0, 600),
    createdAt: new Date().toISOString()
  });
  await saveSkillDraft(draft);
  const next = { ...state, session, draftRef: { id: draft.id, version: draft.version }, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  return { ok: true, state: next, draft };
}

export async function appendPageEvent(tabId, rawEvent) {
  const state = await requireWatchState();
  if (state.session.status !== "watching") return { ok: false, ignored: true };
  if (!state.session.approvedTabs.includes(tabId)) throw coded("WATCH_WRONG_TAB", "BrowserCrew ignored an event from a tab you did not approve.");

  const event = {
    ...rawEvent,
    id: rawEvent?.id || `step-${String(state.session.events.length + 1).padStart(3, "0")}`,
    tabId,
    occurredAt: rawEvent?.occurredAt || new Date().toISOString()
  };
  const session = recordWatchEvent(state.session, event);
  const next = { ...state, session, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  return { ok: true, state: next };
}

async function handleNavigation(tabId, href) {
  const state = await getWatchState();
  if (!state?.session || !state.session.approvedTabs.includes(tabId) || state.session.status !== "watching") return;
  const url = new URL(href);
  if (!state.session.approvedOrigins.includes(url.origin)) {
    const next = {
      ...state,
      session: {
        ...state.session,
        status: "scope_review",
        warnings: [...state.session.warnings, { code: "ORIGIN_CHANGED", origin: url.origin, at: new Date().toISOString() }]
      },
      updatedAt: new Date().toISOString()
    };
    await persistWatchState(next);
    return;
  }

  const last = state.session.events.at(-1);
  if (last?.kind !== "navigate" || last.pageUrl !== href) {
    await appendPageEvent(tabId, { kind: "navigate", origin: url.origin, pageUrl: href, url: href });
  }
  await installPageRecorder(tabId).catch(() => {});
}

async function setWatchStatus(status) {
  const state = await requireWatchState();
  if (state.session.status !== "watching" && status === "paused") throw coded("WATCH_NOT_RUNNING", "BrowserCrew is not currently watching.");
  const next = { ...state, session: { ...state.session, status }, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  return { ok: true, state: next };
}

async function resumeWatching() {
  const state = await requireWatchState();
  if (state.session.status !== "paused") throw coded("WATCH_REVIEW_REQUIRED", "If the page changed to a new site, review the new scope instead of resuming automatically.");
  const tabId = state.session.approvedTabs[0];
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || new URL(tab.url).origin !== state.session.approvedOrigins[0]) throw coded("WATCH_SCOPE_CHANGED", "The watched tab is on a different site. Start a new recording or approve the new scope first.");
  const next = { ...state, session: { ...state.session, status: "watching" }, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  await installPageRecorder(tabId);
  return { ok: true, state: next };
}

async function installPageRecorder(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const KEY = "__browserCrewWatchRecorderV1";
      if (globalThis[KEY]?.active) return;
      const port = chrome.runtime.connect({ name: "browsercrew-watch-events" });
      const clean = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
      const describe = (element) => {
        if (!(element instanceof Element)) return {};
        const labelElement = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
        const role = clean(element.getAttribute("role") || inferRole(element), 80);
        return {
          role,
          label: clean(element.getAttribute("aria-label") || labelElement?.innerText || element.innerText || element.getAttribute("title") || element.getAttribute("placeholder"), 160),
          ariaLabel: clean(element.getAttribute("aria-label"), 160),
          name: clean(element.getAttribute("name"), 120),
          id: clean(element.id, 120),
          testId: clean(element.getAttribute("data-testid"), 120),
          type: clean(element.getAttribute("type"), 40),
          autocomplete: clean(element.getAttribute("autocomplete"), 80),
          placeholder: clean(element.getAttribute("placeholder"), 160)
        };
      };
      const inferRole = (element) => {
        const tag = element.tagName?.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const type = (element.getAttribute("type") || "text").toLowerCase();
          if (["checkbox", "radio"].includes(type)) return type;
          if (["button", "submit", "reset"].includes(type)) return "button";
          return "textbox";
        }
        return "";
      };
      const send = (event) => {
        try {
          port.postMessage({ type: "event", event: { ...event, origin: location.origin, pageUrl: location.href, occurredAt: new Date().toISOString() } });
        } catch {}
      };
      const editable = (element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element?.isContentEditable;
      const onClick = (event) => {
        const target = event.target?.closest?.("button,a,[role='button'],[role='link'],input,select,textarea,[contenteditable='true']") || event.target;
        if (!(target instanceof Element) || editable(target)) return;
        const description = describe(target);
        if (!description.role && !description.label && !description.id && !description.testId) return;
        send({ kind: "click", target: description });
      };
      const onChange = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const description = describe(target);
        if (target instanceof HTMLSelectElement) {
          // Deliberately do not transmit the selected literal. The skill editor
          // turns demonstrated values into runtime inputs, including selects.
          send({ kind: "select", target: description, variableName: clean(target.name || target.id || "selection", 60) });
          return;
        }
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) {
          // Never send the typed value across the extension boundary.
          send({ kind: "type", target: description, variableName: clean(target.getAttribute("name") || target.id || target.getAttribute("aria-label") || "input", 60) });
        }
      };
      document.addEventListener("click", onClick, true);
      document.addEventListener("change", onChange, true);
      globalThis[KEY] = {
        active: true,
        stop() {
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("change", onChange, true);
          try { port.disconnect(); } catch {}
          this.active = false;
        }
      };
    }
  });
}

async function uninstallPageRecorder(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { try { globalThis.__browserCrewWatchRecorderV1?.stop?.(); } catch {} }
  });
}

async function getWatchState() {
  const data = await chrome.storage.local.get(WATCH_STATE_KEY);
  return data[WATCH_STATE_KEY] || null;
}

async function requireWatchState() {
  const state = await getWatchState();
  if (!state?.session) throw coded("WATCH_NOT_FOUND", "There is no saved Watch Me demonstration.");
  return state;
}

async function persistWatchState(state) {
  await chrome.storage.local.set({ [WATCH_STATE_KEY]: state });
}

function normalizeSkillId(value) {
  const base = String(value || "watched-workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "watched-workflow";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function serializeError(error) { return { code: error?.code || "WATCH_ERROR", message: error?.message || "BrowserCrew could not update this demonstration." }; }
