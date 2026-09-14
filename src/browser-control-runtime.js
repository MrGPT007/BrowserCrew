export const BROWSER_CONTROL_GRANT_KEY = "browsercrew.browserControlGrant.v1";
export const BROWSER_CONTROL_TOOL_ID = "browser.control";
export const BROWSER_CONTROL_TOOL_NAME = "browsercrew_browser_control";
export const BROWSER_CONTROL_MAX_STEPS = 24;

export const BROWSER_CONTROL_ACTIONS = Object.freeze([
  "observe",
  "list_tabs",
  "open_tab",
  "focus_tab",
  "close_tab",
  "navigate",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "select",
  "scroll",
  "press_key",
  "download_url"
]);

const ACTION_SET = new Set(BROWSER_CONTROL_ACTIONS);
const BROAD_ORIGINS = ["http://*/*", "https://*/*"];
const MAX_OBSERVATION_CHARS = 9000;
const MAX_INTERACTIVE_ELEMENTS = 160;
const MAX_TYPE_CHARS = 12000;
const MAX_WAIT_MS = 6000;

export function browserControlToolDefinition() {
  return {
    type: "function",
    function: {
      name: BROWSER_CONTROL_TOOL_NAME,
      description: [
        "Control the user's browser only while Browser control is explicitly ON.",
        "Use observe before page interaction to get current element refs.",
        "Use one action per tool call so BrowserCrew can verify each step before the next one.",
        "BrowserCrew blocks secret-entry fields and consequential clicks that need separate user confirmation."
      ].join(" "),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: BROWSER_CONTROL_ACTIONS },
          tabId: { type: "integer", minimum: 1 },
          url: { type: "string", maxLength: 4096 },
          ref: { type: "string", maxLength: 120 },
          text: { type: "string", maxLength: MAX_TYPE_CHARS },
          value: { type: "string", maxLength: 4000 },
          clearFirst: { type: "boolean" },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          amount: { type: "integer", minimum: 80, maximum: 4000 },
          key: { type: "string", enum: ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"] }
        }
      }
    }
  };
}

export async function getBrowserControlGrant() {
  const stored = await chrome.storage.session.get(BROWSER_CONTROL_GRANT_KEY);
  const grant = stored[BROWSER_CONTROL_GRANT_KEY];
  if (!grant?.enabled || !grant?.id || grant.scope !== "browser") return null;
  const actions = Array.isArray(grant.allowedActions) ? grant.allowedActions.filter((item) => ACTION_SET.has(item)) : [];
  if (!actions.length) return null;
  const permission = await chrome.permissions.contains({ origins: BROAD_ORIGINS }).catch(() => false);
  if (!permission) return null;
  return {
    ...grant,
    allowedActions: actions,
    maxSteps: Math.min(BROWSER_CONTROL_MAX_STEPS, Math.max(1, Number(grant.maxSteps || BROWSER_CONTROL_MAX_STEPS)))
  };
}

export async function executeBrowserControlAction(rawArgs, grant, { signal } = {}) {
  assertActiveGrant(grant);
  assertNotStopped(signal);
  const args = normalizeArgs(rawArgs);
  if (!grant.allowedActions.includes(args.action)) throw controlError("BROWSER_ACTION_NOT_ALLOWED", "That browser action is outside the active control grant.");

  switch (args.action) {
    case "observe": return observeAction(args, signal);
    case "list_tabs": return listTabsAction();
    case "open_tab": return openTabAction(args, signal);
    case "focus_tab": return focusTabAction(args);
    case "close_tab": return closeTabAction(args);
    case "navigate": return navigateAction(args, signal);
    case "back": return historyAction(args, "back", signal);
    case "forward": return historyAction(args, "forward", signal);
    case "reload": return reloadAction(args, signal);
    case "click": return pageAction(args, "click", signal);
    case "type": return pageAction(args, "type", signal);
    case "select": return pageAction(args, "select", signal);
    case "scroll": return pageAction(args, "scroll", signal);
    case "press_key": return pageAction(args, "press_key", signal);
    case "download_url": return downloadUrlAction(args);
    default: throw controlError("BROWSER_ACTION_UNKNOWN", "BrowserCrew did not recognize that browser action.");
  }
}

function normalizeArgs(raw) {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw controlError("BROWSER_ACTION_ARGS_INVALID", "The browser action arguments were not valid JSON."); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw controlError("BROWSER_ACTION_ARGS_INVALID", "The browser action arguments were invalid.");
  const action = String(value.action || "").trim();
  if (!ACTION_SET.has(action)) throw controlError("BROWSER_ACTION_UNKNOWN", "BrowserCrew did not recognize that browser action.");
  return {
    action,
    tabId: Number.isInteger(value.tabId) && value.tabId > 0 ? value.tabId : null,
    url: typeof value.url === "string" ? value.url.trim() : "",
    ref: typeof value.ref === "string" ? value.ref.trim().slice(0, 120) : "",
    text: typeof value.text === "string" ? value.text.slice(0, MAX_TYPE_CHARS) : "",
    value: typeof value.value === "string" ? value.value.slice(0, 4000) : "",
    clearFirst: value.clearFirst !== false,
    direction: ["up", "down", "left", "right"].includes(value.direction) ? value.direction : "down",
    amount: Number.isInteger(value.amount) ? Math.min(4000, Math.max(80, value.amount)) : 700,
    key: ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(value.key) ? value.key : ""
  };
}

async function observeAction(args, signal) {
  const tab = await resolveNormalTab(args.tabId);
  assertNotStopped(signal);
  return snapshotTab(tab.id);
}

async function listTabsAction() {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    action: "list_tabs",
    tabs: tabs.filter((tab) => normalWebUrl(tab.url)).slice(0, 100).map(publicTab)
  };
}

async function openTabAction(args, signal) {
  const url = requireNormalUrl(args.url);
  const tab = await chrome.tabs.create({ url, active: true });
  assertNotStopped(signal);
  const settled = await waitForTab(tab.id, signal);
  return { ok: true, action: "open_tab", tab: publicTab(settled || tab) };
}

async function focusTabAction(args) {
  const tab = await resolveNormalTab(requireTabId(args));
  const updated = await chrome.tabs.update(tab.id, { active: true });
  return { ok: true, action: "focus_tab", tab: publicTab(updated || tab) };
}

async function closeTabAction(args) {
  const tab = await resolveNormalTab(requireTabId(args));
  await chrome.tabs.remove(tab.id);
  return { ok: true, action: "close_tab", closedTabId: tab.id, closedTitle: safeText(tab.title, 240) };
}

async function navigateAction(args, signal) {
  const url = requireNormalUrl(args.url);
  const tab = await resolveNormalTab(args.tabId);
  const updated = await chrome.tabs.update(tab.id, { url });
  assertNotStopped(signal);
  const settled = await waitForTab(tab.id, signal);
  return { ok: true, action: "navigate", tab: publicTab(settled || updated || tab) };
}

async function historyAction(args, direction, signal) {
  const tab = await resolveNormalTab(args.tabId);
  if (direction === "back") await chrome.tabs.goBack(tab.id);
  else await chrome.tabs.goForward(tab.id);
  assertNotStopped(signal);
  const settled = await waitForTab(tab.id, signal);
  return { ok: true, action: direction, tab: publicTab(settled || tab) };
}

async function reloadAction(args, signal) {
  const tab = await resolveNormalTab(args.tabId);
  await chrome.tabs.reload(tab.id);
  assertNotStopped(signal);
  const settled = await waitForTab(tab.id, signal);
  return { ok: true, action: "reload", tab: publicTab(settled || tab) };
}

async function pageAction(args, action, signal) {
  const tab = await resolveNormalTab(args.tabId);
  assertNotStopped(signal);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: executeInPage,
    args: [{ action, ref: args.ref, text: args.text, value: args.value, clearFirst: args.clearFirst, direction: args.direction, amount: args.amount, key: args.key }]
  });
  if (!result || result.ok !== true) {
    const code = result?.code || "BROWSER_PAGE_ACTION_FAILED";
    const message = result?.message || "BrowserCrew could not complete that page action.";
    if (code === "CONFIRMATION_REQUIRED") return { ok: false, action, code, message, confirmation: result.confirmation || null, tab: publicTab(tab) };
    throw controlError(code, message);
  }
  return { ...result, tab: publicTab(await chrome.tabs.get(tab.id).catch(() => tab)) };
}

async function downloadUrlAction(args) {
  const url = requireNormalUrl(args.url);
  const downloadId = await chrome.downloads.download({ url, saveAs: false });
  return { ok: true, action: "download_url", downloadId, url };
}

async function snapshotTab(tabId) {
  const tab = await resolveNormalTab(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectPageSnapshot,
    args: [MAX_OBSERVATION_CHARS, MAX_INTERACTIVE_ELEMENTS]
  });
  if (!result) throw controlError("BROWSER_OBSERVE_FAILED", "BrowserCrew could not inspect that page.");
  return {
    ok: true,
    action: "observe",
    tab: publicTab(await chrome.tabs.get(tab.id).catch(() => tab)),
    page: {
      title: safeText(result.title, 240),
      url: normalWebUrl(result.url) ? result.url : tab.url,
      text: safeText(result.text, MAX_OBSERVATION_CHARS),
      elements: Array.isArray(result.elements) ? result.elements.slice(0, MAX_INTERACTIVE_ELEMENTS) : []
    }
  };
}

async function resolveNormalTab(tabId = null) {
  let tab = null;
  if (Number.isInteger(tabId) && tabId > 0) tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !normalWebUrl(tab.url)) throw controlError("BROWSER_TAB_UNAVAILABLE", "Choose a normal http or https page before BrowserCrew controls it.");
  return tab;
}

function requireTabId(args) {
  if (!args.tabId) throw controlError("BROWSER_TAB_ID_REQUIRED", "That browser action needs a tab id from list_tabs or observe.");
  return args.tabId;
}

function requireNormalUrl(value) {
  if (!normalWebUrl(value)) throw controlError("BROWSER_URL_BLOCKED", "BrowserCrew can navigate only to normal http or https addresses.");
  return new URL(value).href;
}

function normalWebUrl(value) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

async function waitForTab(tabId, signal) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    assertNotStopped(signal);
    last = await chrome.tabs.get(tabId).catch(() => null);
    if (!last) return null;
    if (last.status === "complete") return last;
    await delay(100);
  }
  return last;
}

function assertActiveGrant(grant) {
  if (!grant?.enabled || grant.scope !== "browser" || !grant.id) throw controlError("BROWSER_CONTROL_OFF", "Browser control is off. Turn it on in Chat before BrowserCrew can operate the browser.");
}

function assertNotStopped(signal) {
  if (signal?.aborted) throw controlError("BROWSER_CONTROL_STOPPED", "BrowserCrew stopped before starting another browser action.");
}

function publicTab(tab) {
  return {
    id: Number(tab?.id || 0),
    title: safeText(tab?.title || "Untitled page", 240),
    url: normalWebUrl(tab?.url) ? String(tab.url) : "",
    active: Boolean(tab?.active),
    status: String(tab?.status || "")
  };
}

function safeText(value, max) {
  return String(value || "").replace(/\u0000/g, "").slice(0, max);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function controlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function collectPageSnapshot(maxChars, maxElements) {
  const SECRET_TYPES = new Set(["password"]);
  const candidates = [...document.querySelectorAll([
    "a[href]", "button", "input:not([type='hidden'])", "textarea", "select", "summary",
    "[role='button']", "[role='link']", "[role='textbox']", "[role='checkbox']", "[role='radio']", "[role='combobox']", "[contenteditable='true']"
  ].join(","))];
  let index = 0;
  const elements = [];
  for (const element of candidates) {
    if (elements.length >= maxElements) break;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0 || rect.width < 1 || rect.height < 1) continue;
    index += 1;
    const ref = `bc-${index}`;
    element.setAttribute("data-browsercrew-agent-ref", ref);
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const tag = element.tagName.toLowerCase();
    const role = String(element.getAttribute("role") || "").toLowerCase();
    const label = String(
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.innerText ||
      element.getAttribute("name") ||
      element.getAttribute("value") ||
      tag
    ).replace(/\s+/g, " ").trim().slice(0, 240);
    elements.push({
      ref,
      tag,
      role,
      type: SECRET_TYPES.has(type) ? "secret" : type,
      label,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      checked: typeof element.checked === "boolean" ? element.checked : undefined,
      href: tag === "a" ? String(element.href || "").slice(0, 1000) : undefined
    });
  }
  const clone = document.body?.cloneNode(true);
  if (clone) clone.querySelectorAll("script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden='true']").forEach((node) => node.remove());
  const text = String(clone?.innerText || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
  return { title: document.title, url: location.href, text, elements };
}

function executeInPage(input) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width >= 1 && rect.height >= 1;
  };
  const describe = (element) => String(
    element?.getAttribute?.("aria-label") || element?.getAttribute?.("title") || element?.innerText || element?.getAttribute?.("value") || element?.getAttribute?.("name") || element?.tagName || "control"
  ).replace(/\s+/g, " ").trim().slice(0, 240);
  const dangerous = (element) => {
    const label = describe(element).toLowerCase();
    const words = /\b(buy|purchase|place order|pay|payment|transfer|send money|delete|remove account|close account|publish|post|send email|send message|book|reserve|confirm order|submit order)\b/i;
    if (words.test(label)) return true;
    const type = String(element?.getAttribute?.("type") || "").toLowerCase();
    return type === "submit" && !/\b(search|find|filter|sign in|log in|continue|next)\b/i.test(label);
  };
  const secretField = (element) => {
    const type = String(element?.getAttribute?.("type") || "").toLowerCase();
    const auto = String(element?.getAttribute?.("autocomplete") || "").toLowerCase();
    const identity = `${element?.id || ""} ${element?.getAttribute?.("name") || ""} ${element?.getAttribute?.("aria-label") || ""}`.toLowerCase();
    return type === "password" || /one-time-code|cc-number|cc-csc|cc-cvc|new-password|current-password/.test(auto) || /password|passcode|otp|one.?time|cvv|cvc|card.?number/.test(identity);
  };
  const find = () => input.ref ? document.querySelector(`[data-browsercrew-agent-ref="${CSS.escape(input.ref)}"]`) : null;
  const base = { ok: true, action: input.action, page: { title: document.title, url: location.href } };

  if (input.action === "scroll") {
    const amount = Math.max(80, Math.min(4000, Number(input.amount || 700)));
    const x = input.direction === "left" ? -amount : input.direction === "right" ? amount : 0;
    const y = input.direction === "up" ? -amount : input.direction === "down" ? amount : 0;
    window.scrollBy({ left: x, top: y, behavior: "auto" });
    return { ...base, scrolled: { direction: input.direction, amount } };
  }

  if (input.action === "press_key") {
    const element = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const key = String(input.key || "");
    if (!key) return { ok: false, code: "BROWSER_KEY_REQUIRED", message: "Choose a supported key before pressing it." };
    for (const type of ["keydown", "keyup"]) element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
    return { ...base, key, target: describe(element) };
  }

  const element = find();
  if (!element || !visible(element)) return { ok: false, code: "BROWSER_REF_STALE", message: "That page element changed or is no longer visible. Observe the page again before retrying." };
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, code: "BROWSER_ELEMENT_DISABLED", message: "That page control is disabled." };
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });

  if (input.action === "click") {
    if (dangerous(element)) return { ok: false, code: "CONFIRMATION_REQUIRED", message: `BrowserCrew paused before the consequential action “${describe(element)}”.`, confirmation: { ref: input.ref, label: describe(element) } };
    element.focus?.({ preventScroll: true });
    element.click();
    return { ...base, ref: input.ref, target: describe(element) };
  }

  if (input.action === "type") {
    if (secretField(element)) return { ok: false, code: "SECRET_FIELD_BLOCKED", message: "BrowserCrew will not send passwords, one-time codes, or payment-card secrets through the AI tool path." };
    const text = String(input.text || "");
    element.focus?.({ preventScroll: true });
    if (element.isContentEditable) {
      element.textContent = input.clearFirst === false ? `${element.textContent || ""}${text}` : text;
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const next = input.clearFirst === false ? `${element.value || ""}${text}` : text;
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(element, next); else element.value = next;
    } else {
      return { ok: false, code: "BROWSER_TYPE_UNSUPPORTED", message: "That page element does not accept typed text." };
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ...base, ref: input.ref, target: describe(element), characters: text.length };
  }

  if (input.action === "select") {
    if (!(element instanceof HTMLSelectElement)) return { ok: false, code: "BROWSER_SELECT_UNSUPPORTED", message: "That page element is not a select menu." };
    const desired = String(input.value || "");
    const option = [...element.options].find((item) => item.value === desired || item.text.trim() === desired);
    if (!option) return { ok: false, code: "BROWSER_OPTION_NOT_FOUND", message: "That option is not available in the select menu." };
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ...base, ref: input.ref, target: describe(element), selected: option.text.trim().slice(0, 240) };
  }

  return { ok: false, code: "BROWSER_PAGE_ACTION_FAILED", message: "BrowserCrew could not complete that page action." };
}
