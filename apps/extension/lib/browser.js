import { scoped, pageUrl } from './policy.js';
import { uid, now } from './contracts.js';

// Runs only as bundled code in Chrome's isolated world. The model never supplies code.
export function pageOperation(request) {
  const sensitive = /password|passcode|secret|token|credit.?card|card.?number|security.?code|social.?security|one.?time|api.?key/i;
  const redact = value => String(value).replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[a-zA-Z0-9._-]+)\b/g, '[redacted]');
  const visible = el => {
    const style = getComputedStyle(el);
    return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden],[aria-hidden="true"],[inert]');
  };
  const label = el => redact(el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || 'Unnamed field').slice(0, 160);
  const safeField = el => visible(el) && !el.disabled && !el.readOnly &&
    ['text', 'email', 'tel', 'url', 'search', 'textarea'].includes(el.type) &&
    !sensitive.test([label(el), el.name, el.id, el.autocomplete].join(' ')) &&
    !/(^|\s)cc-|password|one-time-code/.test(el.autocomplete || '');
  const fingerprint = el => JSON.stringify([label(el), el.type, el.name, el.id, el.value, el.form?.action, el.form?.method]);
  if (request.kind === 'read') {
    const fields = [];
    const refs = new Map();
    for (const el of document.querySelectorAll('input,textarea')) {
      if (fields.length >= 60) break;
      if (!safeField(el) || sensitive.test(el.value) || redact(el.value) !== el.value) continue;
      const ref = request.id + ':' + fields.length;
      refs.set(ref, { el, fingerprint: fingerprint(el) });
      fields.push({ ref, label: label(el), type: el.type, value: redact(el.value).slice(0, 2000) });
    }
    globalThis.__browserCrewObservation = { id: request.id, url: location.href, refs };
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && length < 14000) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,select,[contenteditable],[data-private],[data-sensitive]') || !visible(parent)) continue;
      const value = redact(walker.currentNode.textContent.replace(/\s+/g, ' ').trim());
      if (value) { parts.push(value); length += value.length + 1; }
    }
    return { url: location.href, title: redact(document.title).slice(0, 300), text: parts.join('\n').slice(0, 14000), fields };
  }
  if (request.kind !== 'fill') throw new Error('Unsupported page operation.');
  const cached = globalThis.__browserCrewObservation;
  if (!cached || cached.id !== request.observationId || cached.url !== location.href) throw new Error('The page changed. Read it again before making changes.');
  const targets = request.fields.map(field => {
    const found = cached.refs.get(field.ref);
    if (!found || !found.el.isConnected || !safeField(found.el) || fingerprint(found.el) !== found.fingerprint) throw new Error('A form field changed after review. No new fields were filled.');
    return { ...found, value: field.value, label: label(found.el), before: found.el.value };
  });
  const outcomes = [];
  for (const target of targets) {
    // Events can change the page synchronously. Revalidate each remaining field.
    if (!target.el.isConnected || location.href !== cached.url || !safeField(target.el) || fingerprint(target.el) !== target.fingerprint) throw new Error('The page changed during filling. Some fields may have changed; inspect the page.');
    const prototype = target.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target.el, target.value);
    target.el.dispatchEvent(new Event('input', { bubbles: true }));
    target.el.dispatchEvent(new Event('change', { bubbles: true }));
    outcomes.push({ label: target.label, before: target.before, after: target.el.value });
  }
  if (targets.some(t => !t.el.isConnected || t.el.value !== t.value)) throw new Error('The website did not keep all requested values. Inspect the form before trying again.');
  globalThis.__browserCrewObservation = undefined;
  return { fields: outcomes, url: location.href, verified: true };
}
export async function tabs() {
  const open = await chrome.tabs.query({ currentWindow: true });
  return open.filter(t => { try { pageUrl(t.url); return true; } catch { return false; } })
    .map(t => ({ tabId: t.id, title: t.title || t.url, url: t.url, origin: new URL(t.url).origin, active: t.active }));
}
async function check(task, tabId) {
  const tab = await chrome.tabs.get(tabId);
  scoped(task, tabId, tab.url);
  if (!await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] })) throw new Error('Access to this site was removed. Choose the page again in a new task.');
  return tab;
}
export async function read(task, tabId) {
  await check(task, tabId);
  const id = uid();
  const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: pageOperation, args: [{ kind: 'read', id }] });
  const first = results[0];
  if (!first?.result || !first.documentId) throw new Error('This page cannot be read. Open a normal web page and try again.');
  scoped(task, tabId, first.result.url);
  return { ...first.result, id, documentId: first.documentId, tabId, observedAt: now() };
}
export async function fill(task, action) {
  const observation = task.observations.find(o => o.id === action.observationId);
  const tab = await check(task, observation.tabId);
  if (!tab.active) throw new Error('Return to the chosen form tab before approving. No new fields were filled.');
  if (tab.url !== observation.url) throw new Error('The form address changed after review. Read the page again.');
  const results = await chrome.scripting.executeScript({ target: { tabId: observation.tabId, documentIds: [observation.documentId] }, world: 'ISOLATED', func: pageOperation, args: [{ kind: 'fill', observationId: observation.id, fields: action.fields }] });
  if (!results[0]?.result?.verified) throw new Error('The form outcome could not be checked. Inspect the page before continuing.');
  return results[0].result;
}
