import { record, text } from './contracts.js';
export function pageUrl(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Choose a normal web page. Browser settings and private browser pages cannot be used.');
  if ([...u.searchParams.keys()].some(key => /^(access_token|refresh_token|id_token|token|password|secret|api_key|apikey|authorization)$/i.test(key))) throw new Error('This address contains sign-in or secret details. Open a page with a clean address before using it.');
  return u;
}
export function providerConfig(value) {
  if (!record(value) || !['local', 'cloud'].includes(value.kind)) throw new Error('Choose where your AI runs.');
  const u = pageUrl(text(value.baseUrl, 2048));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.search || u.hash) throw new Error('Use the server address without a question mark or # section.');
  if (value.kind === 'local' && !loopback) throw new Error('Local AI must use localhost, 127.0.0.1, or [::1] on this computer.');
  if (value.kind === 'cloud' && (u.protocol !== 'https:' || loopback)) throw new Error('Cloud AI needs a secure address starting with https://.');
  return { kind: value.kind, baseUrl: u.href.replace(/\/$/, ''), model: text(value.model, 150) };
}
export function scoped(task, tabId, url) {
  const resource = task.resources.find(r => r.tabId === tabId);
  if (!resource || pageUrl(url).origin !== resource.origin) throw new Error('This tab moved outside the sites you chose. Start a new task to use a different site.');
  return resource;
}
export function allowed(task, action) {
  if (action.tool === 'read_page' && !task.resources.some(r => r.tabId === action.tabId)) throw new Error('The AI asked to read a tab you did not choose.');
  if (action.tool === 'fill_fields') {
    if (task.workflow !== 'form') throw new Error('A research task cannot change a page.');
    const observation = task.observations.find(o => o.id === action.observationId);
    if (!observation) throw new Error('Read the form again before changing it.');
    for (const field of action.fields) {
      if (!observation.fields.some(f => f.ref === field.ref)) throw new Error('A form field changed. Read the page again.');
    }
  }
}
export function verifyFindings(task, action) {
  for (const finding of action.findings) {
    const source = task.observations.find(o => o.id === finding.observationId);
    if (!source || !source.text.includes(finding.quote) || !finding.quote.includes(finding.value)) throw new Error('A result does not match its source. The AI must quote the page exactly.');
  }
  const allRead = task.resources.every(r => task.observations.some(o => o.tabId === r.tabId));
  const allCited = task.resources.every(r => action.findings.some(f => task.observations.find(o => o.id === f.observationId)?.tabId === r.tabId));
  const formVerified = task.actions.some(a => a.tool === 'fill_fields' && a.status === 'verified');
  return action.missing.length === 0 && allRead && (task.workflow === 'research' ? action.findings.length > 0 && allCited : formVerified);
}
export function csvCell(value) {
  const raw = String(value);
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replaceAll('"', '""') + '"';
}
