const SETTINGS_KEY = "browsercrew.settings.v1";

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function safeHost(urlText) {
  try { return new URL(urlText).hostname; } catch { return "unknown destination"; }
}

async function refreshChatProviderStatus() {
  const modelNode = document.querySelector("#chatModelName");
  const statusNode = document.querySelector("#chatConnectionStatus");
  const destinationNode = document.querySelector("#chatDestinationText");
  if (!modelNode || !statusNode || !destinationNode) return;

  const response = await send({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    statusNode.textContent = "Open Connect AI to choose a model";
    return;
  }

  const settings = response.settings || {};
  const model = String(settings.model || "Choose a model");
  const host = safeHost(settings.baseUrl || "");
  const needsKey = settings.kind === "openai";

  modelNode.textContent = model;
  statusNode.textContent = needsKey && !response.hasSecret ? "Needs a secret key" : `Configured · ${host}`;
  destinationNode.textContent = `Where this message goes: ${model} at ${host}. Page context is sent only when you turn it on.`;
}

document.addEventListener("DOMContentLoaded", () => {
  refreshChatProviderStatus().catch(() => {});
  document.querySelector("#tab-chat")?.addEventListener("click", () => refreshChatProviderStatus().catch(() => {}), true);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_KEY]) refreshChatProviderStatus().catch(() => {});
});
