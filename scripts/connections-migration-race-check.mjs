import assert from "node:assert/strict";

const CONNECTIONS_KEY = "browsercrew.connections.v1";
const ACTIVE_KEY = "browsercrew.activeConnection.v1";
const connectListeners = [];
const localData = {};
const sessionData = {};
const localSetHistory = [];

function select(store, keys) {
  if (keys === null || keys === undefined) return structuredClone(store);
  const list = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(list.filter((key) => Object.prototype.hasOwnProperty.call(store, key)).map((key) => [key, structuredClone(store[key])]));
}

globalThis.broadcastState = () => {};
globalThis.chrome = {
  runtime: {
    onConnect: { addListener(listener) { connectListeners.push(listener); } }
  },
  storage: {
    local: {
      async get(keys) { return select(localData, keys); },
      async set(values) { localSetHistory.push(structuredClone(values)); Object.assign(localData, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete localData[key]; }
    },
    session: {
      async get(keys) { return select(sessionData, keys); },
      async set(values) { Object.assign(sessionData, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionData[key]; }
    },
    onChanged: { addListener() {} }
  },
  permissions: { async contains() { return false; } }
};

await import(`../src/connections-runtime.js?migration-race=${Date.now()}`);
assert.equal(connectListeners.length, 1, "Connection runtime should install exactly one port listener.");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(localSetHistory.length, 0, "Service-worker import must not bootstrap or overwrite connection storage before an explicit connection request.");

const seeded = {
  id: "seeded-after-worker-start",
  schemaVersion: 1,
  name: "Seeded local AI",
  kind: "lmstudio",
  model: "seeded-model",
  baseUrl: "http://127.0.0.1:1234/v1",
  status: "connected",
  lastTestedAt: "2026-09-13T02:00:00.000Z",
  createdAt: "2026-09-13T02:00:00.000Z",
  updatedAt: "2026-09-13T02:00:00.000Z"
};
localData[CONNECTIONS_KEY] = [structuredClone(seeded)];
localData[ACTIVE_KEY] = seeded.id;
const seededResponse = await send({ type: "GET_CONNECTIONS" });
assert.equal(seededResponse.ok, true);
assert.equal(seededResponse.activeId, seeded.id);
assert.deepEqual(seededResponse.connections.map(({ hasSecret, ...item }) => item), [seeded]);
assert.deepEqual(localData[CONNECTIONS_KEY], [seeded], "First connection hydration must preserve a named connection written after service-worker startup.");
assert.equal(localSetHistory.some((entry) => Array.isArray(entry[CONNECTIONS_KEY]) && entry[CONNECTIONS_KEY][0]?.id !== seeded.id), false, "Migration must not overwrite newer named state with a generated default.");

for (const key of Object.keys(localData)) delete localData[key];
for (const key of Object.keys(sessionData)) delete sessionData[key];
localSetHistory.length = 0;
const [first, second] = await Promise.all([send({ type: "GET_CONNECTIONS" }), send({ type: "GET_CONNECTIONS" })]);
assert.equal(first.ok, true);
assert.equal(second.ok, true);
assert.equal(first.connections.length, 1);
assert.equal(second.connections.length, 1);
assert.equal(first.connections[0].id, second.connections[0].id, "Concurrent first-use hydration must share one generated default connection.");
const bootstrapWrites = localSetHistory.filter((entry) => Array.isArray(entry[CONNECTIONS_KEY]));
assert.equal(bootstrapWrites.length, 1, "Concurrent first-use requests must not race two default-connection writes.");
assert.equal(localData[ACTIVE_KEY], localData[CONNECTIONS_KEY][0].id);

console.log("BrowserCrew connection migration race checks passed.");

function send(message) {
  return new Promise((resolve, reject) => {
    let requestHandler = null;
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error("Connection runtime did not reply.")), 2000);
    const port = {
      name: "browsercrew-connections",
      onDisconnect: { addListener() {} },
      onMessage: { addListener(listener) { requestHandler = listener; } },
      postMessage(response) {
        if (response?.requestId !== requestId) return;
        clearTimeout(timer);
        resolve(response);
      }
    };
    connectListeners[0](port);
    if (!requestHandler) {
      clearTimeout(timer);
      reject(new Error("Connection runtime did not bind the port message handler."));
      return;
    }
    requestHandler({ ...message, requestId });
  });
}
