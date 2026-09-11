import * as store from './lib/storage.js';
import * as browser from './lib/browser.js';
import { Engine } from './lib/engine.js';
import { generate, probe } from './lib/providers.js';
import { DEFAULT_PROVIDER, now, record, text } from './lib/contracts.js';
import { providerConfig, pageUrl } from './lib/policy.js';

async function credential(provider) {
  const { credential } = await chrome.storage.session.get('credential');
  if (credential?.baseUrl === provider.baseUrl) return credential.key;
  if (provider.kind === 'cloud') throw new Error('Add your AI key again. Keys are cleared when the browser session ends.');
  return '';
}
async function endpointAllowed(provider) {
  if (!await chrome.permissions.contains({ origins: [new URL(provider.baseUrl).origin + '/*'] })) throw new Error('Access to your AI server was removed. Connect your AI again.');
}
const engine = new Engine({ store, browser, provider: async (task, signal) => {
  await endpointAllowed(task.provider);
  return generate(task.provider, await credential(task.provider), task, signal);
} });
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await engine.init();
})();
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('index.html') || sender.tab?.url?.startsWith('http')) return false;
  route(message).then(value => sendResponse({ ok: true, value })).catch(error => sendResponse({ ok: false, error: error.message || 'This action could not be completed.' }));
  return true;
});
async function route(m) {
  await ready;
  if (!record(m) || typeof m.type !== 'string') throw new Error('The request was not understood.');
  if (m.type === 'state') {
    const { provider = DEFAULT_PROVIDER } = await chrome.storage.local.get('provider');
    const { credential: c } = await chrome.storage.session.get('credential');
    return { tasks: engine.tasks, provider, hasKey: !!c?.key && c.baseUrl === provider.baseUrl };
  }
  if (m.type === 'tabs') return browser.tabs();
  if (m.type === 'connect') {
    if (engine.busy || engine.tasks.some(t => t.status === 'awaiting_approval')) throw new Error('Pause or stop the task before changing your AI connection.');
    const provider = providerConfig(m.provider);
    const key = typeof m.key === 'string' ? m.key.trim() : '';
    if (key.length > 1000 || /[\r\n]/.test(key)) throw new Error('The AI key is not valid.');
    if (provider.kind === 'cloud' && !key) throw new Error('Paste an AI service key to connect.');
    await endpointAllowed(provider);
    const capabilities = await probe(provider, key, new AbortController().signal);
    provider.testedAt = now();
    await chrome.storage.session.set({ credential: { baseUrl: provider.baseUrl, key } });
    await chrome.storage.local.set({ provider });
    return { provider, capabilities };
  }
  if (m.type === 'disconnect') {
    if (engine.busy || engine.tasks.some(t => t.status === 'awaiting_approval')) throw new Error('Pause or stop your task before disconnecting.');
    await chrome.storage.session.remove('credential');
    await chrome.storage.local.remove('provider');
    return true;
  }
  if (m.type === 'start') {
    const { provider } = await chrome.storage.local.get('provider');
    if (!provider?.testedAt) throw new Error('Connect and test your AI first.');
    providerConfig(provider); await endpointAllowed(provider); await credential(provider);
    if (!['research', 'form'].includes(m.workflow)) throw new Error('Choose a supported task type.');
    if (!Array.isArray(m.tabIds) || !m.tabIds.length || m.tabIds.length > 5 || new Set(m.tabIds).size !== m.tabIds.length || m.tabIds.some(id => !Number.isInteger(id))) throw new Error('Choose between one and five different pages.');
    if (m.workflow === 'form' && m.tabIds.length !== 1) throw new Error('Choose just one tab for a form task.');
    const resources = [];
    for (const tabId of m.tabIds) {
      const tab = await chrome.tabs.get(tabId);
      const url = pageUrl(tab.url);
      if (!await chrome.permissions.contains({ origins: [url.origin + '/*'] })) throw new Error('Allow access to each selected page before starting.');
      resources.push({ tabId, title: tab.title || tab.url, url: tab.url, origin: url.origin });
    }
    if (!Number.isInteger(m.maxSteps) || m.maxSteps < 3 || m.maxSteps > 50) throw new Error('Choose a step limit from 3 to 50.');
    return engine.start({ goal: text(m.goal), completionCriteria: text(m.completionCriteria, 2000), workflow: m.workflow, maxSteps: m.maxSteps, resources, provider });
  }
  const id = text(m.id, 100);
  if (['pause', 'stop', 'takeover'].includes(m.type)) return engine.control(id, m.type);
  if (m.type === 'approve') return engine.approve(id);
  if (m.type === 'resume') return engine.resume(id);
  if (m.type === 'delete') return engine.remove(id);
  throw new Error('This action is not available.');
}
