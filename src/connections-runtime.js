const CONNECTIONS_KEY = "browsercrew.connections.v1";
const ACTIVE_KEY = "browsercrew.activeConnection.v1";
const SECRETS_KEY = "browsercrew.connectionSecrets.v1";
const LEGACY_SETTINGS_KEY = "browsercrew.settings.v1";
const LEGACY_SECRET_KEY = "browsercrew.providerSecret.v1";
const CONNECTIONS_PORT = "browsercrew-connections";
const MAX_CONNECTIONS = 12;

const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONNECTIONS_PORT) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((message) => {
    handleConnectionMessage(message).then((response) => {
      safePost(port, { ...response, requestId: message?.requestId || null });
    }).catch((error) => {
      safePost(port, { type: "CONNECTION_ERROR", ok: false, requestId: message?.requestId || null, error: serializeError(error) });
    });
  });
});

ensureMigratedConnections().then(broadcastState).catch(() => {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[LEGACY_SETTINGS_KEY]?.newValue) {
    absorbLegacySettings(changes[LEGACY_SETTINGS_KEY].newValue).catch(() => {});
  }
  if (areaName === "session" && changes[LEGACY_SECRET_KEY]) {
    absorbLegacySecret(changes[LEGACY_SECRET_KEY].newValue || "").catch(() => {});
  }
});

async function handleConnectionMessage(message) {
  await ensureMigratedConnections();
  switch (message?.type) {
    case "GET_CONNECTIONS":
      return { type: "CONNECTIONS_STATE", ok: true, ...(await connectionState()) };
    case "SAVE_CONNECTION":
      return saveConnection(message.connection || {}, message.secret);
    case "TEST_CONNECTION":
      return testConnection(message.connectionId);
    case "ACTIVATE_CONNECTION":
      return activateConnection(message.connectionId);
    case "DELETE_CONNECTION":
      return deleteConnection(message.connectionId);
    default:
      return { type: "CONNECTION_ERROR", ok: false, error: { code: "UNKNOWN_CONNECTION_MESSAGE", message: "BrowserCrew received an unknown AI-connection request." } };
  }
}

async function ensureMigratedConnections() {
  const local = await chrome.storage.local.get([CONNECTIONS_KEY, ACTIVE_KEY, LEGACY_SETTINGS_KEY]);
  let connections = Array.isArray(local[CONNECTIONS_KEY]) ? local[CONNECTIONS_KEY] : [];
  let activeId = local[ACTIVE_KEY] || null;
  const session = await chrome.storage.session.get([SECRETS_KEY, LEGACY_SECRET_KEY]);
  let secrets = session[SECRETS_KEY] && typeof session[SECRETS_KEY] === "object" ? session[SECRETS_KEY] : {};

  if (!connections.length) {
    const legacy = normalizeSettings(local[LEGACY_SETTINGS_KEY] || defaultSettings());
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    connections = [{
      id,
      schemaVersion: 1,
      name: defaultConnectionName(legacy.kind),
      kind: legacy.kind,
      model: legacy.model,
      baseUrl: legacy.baseUrl,
      status: "not_tested",
      lastTestedAt: null,
      createdAt: now,
      updatedAt: now
    }];
    activeId = id;
    if (session[LEGACY_SECRET_KEY]) secrets[id] = session[LEGACY_SECRET_KEY];
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: connections, [ACTIVE_KEY]: activeId });
    await chrome.storage.session.set({ [SECRETS_KEY]: secrets });
  }

  if (!connections.some((item) => item.id === activeId)) {
    activeId = connections[0].id;
    await chrome.storage.local.set({ [ACTIVE_KEY]: activeId });
  }

  return { connections, activeId, secrets };
}

async function connectionState() {
  const { connections, activeId, secrets } = await ensureMigratedConnections();
  return {
    activeId,
    connections: connections.map((item) => ({ ...item, hasSecret: Boolean(secrets[item.id]) }))
  };
}

async function saveConnection(input, suppliedSecret) {
  const { connections, activeId, secrets } = await ensureMigratedConnections();
  const normalized = validateConnection(input);
  const now = new Date().toISOString();
  const existing = input.id ? connections.find((item) => item.id === input.id) : null;
  if (!existing && connections.length >= MAX_CONNECTIONS) throw coded("CONNECTION_LIMIT", `BrowserCrew can keep up to ${MAX_CONNECTIONS} AI connections in this build.`);

  const profile = {
    id: existing?.id || crypto.randomUUID(),
    schemaVersion: 1,
    name: normalized.name,
    kind: normalized.kind,
    model: normalized.model,
    baseUrl: normalized.baseUrl,
    status: existing && existing.model === normalized.model && existing.baseUrl === normalized.baseUrl && existing.kind === normalized.kind ? existing.status : "not_tested",
    lastTestedAt: existing?.lastTestedAt || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const next = connections.filter((item) => item.id !== profile.id);
  next.unshift(profile);
  if (typeof suppliedSecret === "string" && suppliedSecret.length) secrets[profile.id] = suppliedSecret;
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: next });
  await chrome.storage.session.set({ [SECRETS_KEY]: secrets });

  const shouldActivate = input.activate !== false;
  if (shouldActivate || activeId === profile.id) await setActiveAndSync(profile.id, next, secrets);
  const state = await connectionState();
  broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
  return { type: "CONNECTION_SAVED", ok: true, connection: { ...profile, hasSecret: Boolean(secrets[profile.id]) }, ...state };
}

async function testConnection(connectionId) {
  const { connections, secrets } = await ensureMigratedConnections();
  const profile = connections.find((item) => item.id === connectionId);
  if (!profile) throw coded("CONNECTION_NOT_FOUND", "That saved AI connection could not be found.");
  await ensureProviderPermission(profile.baseUrl);
  const startedAt = Date.now();
  try {
    const response = await callProvider(profile, secrets[profile.id] || "");
    await updateConnectionStatus(profile.id, "connected", new Date().toISOString());
    const state = await connectionState();
    broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
    return { type: "CONNECTION_TESTED", ok: true, connectionId: profile.id, model: response.model || profile.model, latencyMs: Date.now() - startedAt, ...state };
  } catch (error) {
    await updateConnectionStatus(profile.id, error?.code === "PROVIDER_PERMISSION_DENIED" ? "permission_needed" : "failed", new Date().toISOString());
    const state = await connectionState();
    broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
    return { type: "CONNECTION_TESTED", ok: false, connectionId: profile.id, error: serializeError(error), ...state };
  }
}

async function activateConnection(connectionId) {
  const { connections, secrets } = await ensureMigratedConnections();
  const profile = connections.find((item) => item.id === connectionId);
  if (!profile) throw coded("CONNECTION_NOT_FOUND", "That saved AI connection could not be found.");
  await setActiveAndSync(profile.id, connections, secrets);
  const state = await connectionState();
  broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
  return { type: "CONNECTION_ACTIVATED", ok: true, connection: { ...profile, hasSecret: Boolean(secrets[profile.id]) }, ...state };
}

async function deleteConnection(connectionId) {
  const { connections, activeId, secrets } = await ensureMigratedConnections();
  if (connections.length <= 1) throw coded("LAST_CONNECTION", "Keep at least one AI connection so BrowserCrew has somewhere to send model requests.");
  const existing = connections.find((item) => item.id === connectionId);
  if (!existing) throw coded("CONNECTION_NOT_FOUND", "That saved AI connection could not be found.");
  const next = connections.filter((item) => item.id !== connectionId);
  delete secrets[connectionId];
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: next });
  await chrome.storage.session.set({ [SECRETS_KEY]: secrets });
  if (activeId === connectionId) await setActiveAndSync(next[0].id, next, secrets);
  const state = await connectionState();
  broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
  return { type: "CONNECTION_DELETED", ok: true, ...state };
}

async function setActiveAndSync(connectionId, connections, secrets) {
  const profile = connections.find((item) => item.id === connectionId);
  if (!profile) throw coded("CONNECTION_NOT_FOUND", "That saved AI connection could not be found.");
  await chrome.storage.local.set({
    [ACTIVE_KEY]: connectionId,
    [LEGACY_SETTINGS_KEY]: { kind: profile.kind, model: profile.model, baseUrl: profile.baseUrl }
  });
  const secret = secrets[connectionId] || "";
  if (secret) await chrome.storage.session.set({ [LEGACY_SECRET_KEY]: secret });
  else await chrome.storage.session.remove(LEGACY_SECRET_KEY);
}

async function absorbLegacySettings(rawSettings) {
  const { connections, activeId } = await ensureMigratedConnections();
  const profile = connections.find((item) => item.id === activeId);
  if (!profile) return;
  const settings = normalizeSettings(rawSettings);
  if (profile.kind === settings.kind && profile.model === settings.model && profile.baseUrl === settings.baseUrl) return;
  profile.kind = settings.kind;
  profile.model = settings.model;
  profile.baseUrl = settings.baseUrl;
  profile.status = "not_tested";
  profile.lastTestedAt = null;
  profile.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: connections });
  const state = await connectionState();
  broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
}

async function absorbLegacySecret(secret) {
  const { activeId, secrets } = await ensureMigratedConnections();
  const current = secrets[activeId] || "";
  if (current === secret) return;
  if (secret) secrets[activeId] = secret;
  else delete secrets[activeId];
  await chrome.storage.session.set({ [SECRETS_KEY]: secrets });
  const state = await connectionState();
  broadcast({ type: "CONNECTIONS_STATE", ok: true, ...state });
}

async function updateConnectionStatus(id, status, testedAt) {
  const { connections } = await ensureMigratedConnections();
  const profile = connections.find((item) => item.id === id);
  if (!profile) return;
  profile.status = status;
  profile.lastTestedAt = testedAt;
  profile.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: connections });
}

function validateConnection(input) {
  const name = String(input.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw coded("CONNECTION_NAME_REQUIRED", "Give this AI connection a name you will recognize, such as Local Qwen or Work OpenAI.");
  const settings = normalizeSettings(input);
  const url = new URL(settings.baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw coded("UNSAFE_PROVIDER_URL", "Cloud AI connections must use HTTPS. Plain HTTP is allowed only for local AI on this computer.");
  }
  return { name, ...settings };
}

function normalizeSettings(settings = {}) {
  const kind = ["openai", "lmstudio", "ollama"].includes(settings.kind) ? settings.kind : "openai";
  const defaults = kind === "lmstudio"
    ? { model: "local-model", baseUrl: "http://127.0.0.1:1234/v1" }
    : kind === "ollama"
      ? { model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" }
      : { model: "gpt-5.6", baseUrl: "https://api.openai.com/v1" };
  const model = String(settings.model || defaults.model).trim();
  const baseUrl = String(settings.baseUrl || defaults.baseUrl).trim().replace(/\/$/, "");
  if (!model) throw coded("MODEL_REQUIRED", "Enter the model name this connection should use.");
  return { kind, model, baseUrl };
}

function defaultSettings() {
  return { kind: "openai", model: "gpt-5.6", baseUrl: "https://api.openai.com/v1" };
}

function defaultConnectionName(kind) {
  if (kind === "lmstudio") return "LM Studio";
  if (kind === "ollama") return "Ollama";
  return "OpenAI API";
}

async function ensureProviderPermission(baseUrl) {
  const url = new URL(baseUrl);
  const pattern = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    throw coded("PROVIDER_PERMISSION_DENIED", "Chrome access to this AI address is not approved. Use Save and test from Connect AI so Chrome can ask you first.");
  }
}

async function callProvider(profile, secret) {
  const endpoint = `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
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
      body: JSON.stringify({
        model: profile.model,
        messages: [
          { role: "system", content: "Reply with exactly: BrowserCrew connection works" },
          { role: "user", content: "Connection test" }
        ],
        temperature: 0,
        max_tokens: 30
      })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw coded("PROVIDER_TIMEOUT", "The AI service did not answer within 30 seconds.");
    throw coded("PROVIDER_UNREACHABLE", "BrowserCrew could not reach this AI service. Check the address and make sure a local server is running when you use local AI.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw coded("PROVIDER_ERROR", safeProviderErrorMessage(response.status));
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body) throw coded("BAD_PROVIDER_JSON", "The AI service returned a response BrowserCrew could not read.");
  return body;
}

function safeProviderErrorMessage(status) {
  if (status === 401 || status === 403) return "The AI service rejected the credentials for this connection. Check the key and account access.";
  if (status === 429) return "The AI service is temporarily limiting requests. Wait a moment and test again.";
  return `The AI service returned HTTP ${status}. BrowserCrew did not save the provider's raw error text.`;
}

function broadcast(message) {
  for (const port of ports) safePost(port, message);
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
  const allowed = new Set([
    "CONNECTION_LIMIT", "CONNECTION_NOT_FOUND", "LAST_CONNECTION", "CONNECTION_NAME_REQUIRED", "MODEL_REQUIRED",
    "UNSAFE_PROVIDER_URL", "PROVIDER_PERMISSION_DENIED", "PROVIDER_TIMEOUT", "PROVIDER_UNREACHABLE", "PROVIDER_ERROR", "BAD_PROVIDER_JSON"
  ]);
  if (!allowed.has(error?.code)) return { code: "CONNECTION_FAILED", message: "BrowserCrew could not finish that AI-connection request." };
  return { code: error.code, message: String(error.message || "BrowserCrew could not finish that AI-connection request.") };
}
