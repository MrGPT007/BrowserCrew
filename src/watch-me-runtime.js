import { createWatchSession, draftSkillFromWatchSession, recordWatchEvent, stopWatchSession } from "./watch-me-contract.js";
import { installWatchPageRecorder, stopWatchPageRecorder } from "./watch-me-page-recorder.js";
import { saveSkillDraft } from "./skills-runtime.js";

const WATCH_STATE_KEY = "browsercrew.watchMe.v1";
const CONTROL_PORT = "browsercrew-watch-control";
const EVENT_PORT = "browsercrew-watch-events";
const MAX_WATCH_ORIGINS = 8;

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
  getWatchState().then((state) => {
    const active = state?.session?.status === "watching" && state.session.approvedTabs?.includes(tabId);
    try { port.postMessage({ type: "watch-session", active, sessionId: active ? state.session.id : null }); } catch {}
  }).catch(() => {
    try { port.postMessage({ type: "watch-session", active: false, sessionId: null }); } catch {}
  });
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
    case "approveScope": return approveScopeChange();
    case "markWait": return markWaitForText(message.visibleText);
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
  if (["watching", "paused", "scope_review"].includes(existing?.session?.status)) throw coded("WATCH_ALREADY_RUNNING", "BrowserCrew is already watching a demonstration. Stop it before starting another one.");

  const session = createWatchSession({ id: crypto.randomUUID(), tabId: tab.id, origin: url.origin, startedAt: new Date().toISOString() });
  const state = { schemaVersion: 1, session, tabTitle: String(tab.title || "Current page").slice(0, 160), updatedAt: new Date().toISOString() };
  await persistWatchState(state);
  await installPageRecorder(tab.id);
  return { ok: true, state };
}

export async function approveScopeChange() {
  const state = await requireWatchState();
  if (state.session.status !== "scope_review") throw coded("WATCH_SCOPE_REVIEW_NOT_PENDING", "There is no new website waiting for Watch Me approval.");
  const tabId = state.session.approvedTabs[0];
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !/^https?:/.test(tab.url)) throw coded("WATCH_PAGE_REQUIRED", "The watched tab is not on a normal website anymore.");
  const url = new URL(tab.url);
  const pendingOrigin = state.session.scopeReview?.origin || latestScopeWarning(state.session)?.origin || null;
  if (!pendingOrigin || pendingOrigin !== url.origin) throw coded("WATCH_SCOPE_CHANGED", "The watched tab changed again. Review the website that is open now before recording continues.");
  const hasAccess = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!hasAccess) throw coded("WATCH_SITE_ACCESS_REQUIRED", "Approve Chrome access to this website before adding it to this recording.");

  const alreadyApproved = state.session.approvedOrigins.includes(url.origin);
  if (!alreadyApproved && state.session.approvedOrigins.length >= MAX_WATCH_ORIGINS) throw coded("WATCH_SCOPE_LIMIT", `Watch Me can include up to ${MAX_WATCH_ORIGINS} explicitly approved websites in one recording.`);
  const approvedOrigins = alreadyApproved ? [...state.session.approvedOrigins] : [...state.session.approvedOrigins, url.origin];
  let session = { ...state.session, status: "watching", approvedOrigins, scopeReview: null };
  const last = session.events.at(-1);
  if (last?.kind !== "navigate" || last.pageUrl !== url.href) {
    session = recordWatchEvent(session, {
      id: `step-${String(session.events.length + 1).padStart(3, "0")}`,
      kind: "navigate",
      tabId,
      origin: url.origin,
      pageUrl: url.href,
      url: url.href,
      occurredAt: new Date().toISOString()
    });
  }
  const next = { ...state, session, tabTitle: String(tab.title || "Current page").slice(0, 160), updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  await installPageRecorder(tabId);
  return { ok: true, state: next, approvedOrigin: url.origin, addedOrigin: !alreadyApproved };
}

export async function finishWatching(draftInput = {}) {
  const state = await requireWatchState();
  let session = state.session;
  if (!["watching", "paused", "scope_review"].includes(session.status)) throw coded("WATCH_NOT_ACTIVE", "There is no active demonstration to stop.");

  const completionText = String(draftInput.completionText || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!completionText) throw coded("WATCH_COMPLETION_REQUIRED", "Add a short piece of text that is visible when this job has worked.");
  const tabId = session.approvedTabs[0];
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !/^https?:/.test(tab.url)) throw coded("WATCH_PAGE_REQUIRED", "The watched tab is not on a normal website anymore.");
  const expectedOrigin = new URL(tab.url).origin;
  if (!session.approvedOrigins.includes(expectedOrigin)) throw coded("WATCH_REVIEW_REQUIRED", "Review the new website before using it as the recorded job's completion page.");
  const completion = await verifyCompletionText(tabId, expectedOrigin, completionText);
  if (!completion.visible) throw coded("WATCH_COMPLETION_NOT_VISIBLE", "That success text is not visible on the watched page right now. Finish the job first, then choose text that proves it worked.");

  session = { ...session, status: "watching", scopeReview: null };
  session = recordWatchEvent(session, {
    id: `step-${String(session.events.length + 1).padStart(3, "0")}`,
    kind: "verify",
    tabId,
    origin: expectedOrigin,
    pageUrl: completion.url,
    occurredAt: new Date().toISOString(),
    expect: { visibleText: completionText }
  });
  session = stopWatchSession(session, new Date().toISOString());
  await uninstallPageRecorder(tabId).catch(() => {});

  const draft = draftSkillFromWatchSession(session, {
    skillId: normalizeSkillId(draftInput.skillId || draftInput.title || "watched-workflow"),
    version: draftInput.version || "0.1.0",
    title: String(draftInput.title || "My recorded browser job").slice(0, 120),
    description: String(draftInput.description || "A draft browser job recorded with Watch me do it. Review every step before approving it.").slice(0, 600),
    createdAt: new Date().toISOString()
  });
  const saved = await saveSkillDraft(draft);
  const savedDraft = saved.skill || draft;
  const next = { ...state, session, draftRef: { id: savedDraft.id, version: savedDraft.version }, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  return { ok: true, state: next, draft: savedDraft };
}

export async function markWaitForText(visibleText) {
  const state = await requireWatchState();
  if (state.session.status !== "watching") throw coded("WATCH_NOT_RUNNING", "Resume watching before adding a wait condition.");
  const text = String(visibleText || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!text) throw coded("WATCH_WAIT_TEXT_REQUIRED", "Enter a short visible status or heading to wait for.");
  const tabId = state.session.approvedTabs[0];
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !/^https?:/.test(tab.url)) throw coded("WATCH_PAGE_REQUIRED", "The watched tab is not on a normal website anymore.");
  const expectedOrigin = new URL(tab.url).origin;
  if (!state.session.approvedOrigins.includes(expectedOrigin)) throw coded("WATCH_REVIEW_REQUIRED", "Review the new website before adding a wait condition there.");
  const observation = await verifyCompletionText(tabId, expectedOrigin, text);
  if (!observation.visible) throw coded("WATCH_WAIT_TEXT_NOT_VISIBLE", "That text is not visible on the watched page yet. Wait until it appears, then add the wait condition.");
  return appendPageEvent(tabId, {
    kind: "waitFor",
    origin: expectedOrigin,
    pageUrl: observation.url,
    occurredAt: new Date().toISOString(),
    expect: { visibleText: text }
  });
}

export async function appendPageEvent(tabId, rawEvent) {
  const state = await requireWatchState();
  if (state.session.status !== "watching") return { ok: false, ignored: true };
  if (!state.session.approvedTabs.includes(tabId)) throw coded("WATCH_WRONG_TAB", "BrowserCrew ignored an event from a tab you did not approve.");

  const event = { ...rawEvent, id: rawEvent?.id || `step-${String(state.session.events.length + 1).padStart(3, "0")}`, tabId, occurredAt: rawEvent?.occurredAt || new Date().toISOString() };
  const session = recordWatchEvent(state.session, event);
  const next = { ...state, session, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  return { ok: true, state: next };
}

async function handleNavigation(tabId, href) {
  const state = await getWatchState();
  if (!state?.session || !state.session.approvedTabs.includes(tabId) || !["watching", "scope_review"].includes(state.session.status)) return;
  const url = new URL(href);
  if (state.session.status === "scope_review") {
    const previous = state.session.scopeReview?.origin || null;
    const warning = previous === url.origin ? state.session.warnings : [...state.session.warnings, { code: "ORIGIN_CHANGED", origin: url.origin, at: new Date().toISOString() }];
    await persistWatchState({
      ...state,
      session: { ...state.session, scopeReview: { origin: url.origin, at: new Date().toISOString() }, warnings: warning },
      updatedAt: new Date().toISOString()
    });
    return;
  }
  if (!state.session.approvedOrigins.includes(url.origin)) {
    const now = new Date().toISOString();
    const next = {
      ...state,
      session: {
        ...state.session,
        status: "scope_review",
        scopeReview: { origin: url.origin, at: now },
        warnings: [...state.session.warnings, { code: "ORIGIN_CHANGED", origin: url.origin, at: now }]
      },
      updatedAt: now
    };
    await persistWatchState(next);
    return;
  }

  const last = state.session.events.at(-1);
  if (last?.kind !== "navigate" || last.pageUrl !== href) await appendPageEvent(tabId, { kind: "navigate", origin: url.origin, pageUrl: href, url: href });
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
  if (!tab?.url || !/^https?:/.test(tab.url)) throw coded("WATCH_PAGE_REQUIRED", "The watched tab is not on a normal website anymore.");
  if (!state.session.approvedOrigins.includes(new URL(tab.url).origin)) throw coded("WATCH_SCOPE_CHANGED", "The watched tab is on a different site. Review that site before recording continues.");
  const next = { ...state, session: { ...state.session, status: "watching" }, updatedAt: new Date().toISOString() };
  await persistWatchState(next);
  await installPageRecorder(tabId);
  return { ok: true, state: next };
}

async function verifyCompletionText(tabId, expectedOrigin, visibleText) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || new URL(tab.url).origin !== expectedOrigin) throw coded("WATCH_SCOPE_CHANGED", "The watched tab is no longer on the approved website. Start a new recording or review the new scope first.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expected) => {
      const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return { visible: bodyText.includes(expected), url: location.href };
    },
    args: [visibleText]
  });
  return { visible: result?.visible === true, url: result?.url || tab.url };
}

async function installPageRecorder(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, func: installWatchPageRecorder });
}

async function uninstallPageRecorder(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, func: stopWatchPageRecorder });
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

function latestScopeWarning(session) {
  return [...(session?.warnings || [])].reverse().find((item) => item?.code === "ORIGIN_CHANGED") || null;
}

function normalizeSkillId(value) {
  const base = String(value || "watched-workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "watched-workflow";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function serializeError(error) { return { code: error?.code || "WATCH_ERROR", message: error?.message || "BrowserCrew could not update this demonstration." }; }
