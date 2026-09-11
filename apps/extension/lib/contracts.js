export const VERSION = 1;
export const DEFAULT_PROVIDER = { kind: 'cloud', baseUrl: 'https://api.openai.com/v1', model: '' };
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function text(v, max = 4000) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('A required text value is missing or too long.');
  return v.trim();
}
export function proposal(v) {
  if (!record(v)) throw new Error('The AI returned an unreadable action.');
  if (v.tool === 'read_page' && Number.isInteger(v.tabId)) return { tool: v.tool, tabId: v.tabId };
  if (v.tool === 'fill_fields' && Array.isArray(v.fields) && v.fields.length && v.fields.length <= 20) {
    const fields = v.fields.map(f => {
      if (!record(f)) throw new Error('A proposed field is not valid.');
      return { ref: text(f.ref, 100), value: text(f.value, 2000) };
    });
    if (new Set(fields.map(f => f.ref)).size !== fields.length) throw new Error('The AI repeated a field.');
    return { tool: v.tool, observationId: text(v.observationId, 100), fields };
  }
  if (v.tool === 'finish' && Array.isArray(v.findings) && v.findings.length <= 100 && Array.isArray(v.missing) && v.missing.length <= 30) {
    return { tool: v.tool, summary: text(v.summary), missing: v.missing.map(m => text(m, 500)),
      findings: v.findings.map(f => {
        if (!record(f)) throw new Error('A result is missing source details.');
        return { label: text(f.label, 200), value: text(f.value, 1000), observationId: text(f.observationId, 100), quote: text(f.quote, 2000) };
      }) };
  }
  throw new Error('The AI requested an action this version cannot perform.');
}
