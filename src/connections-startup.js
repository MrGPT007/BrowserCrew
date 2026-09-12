// The connection registry broadcasts after explicit GET_CONNECTIONS requests.
// Keep the startup callback defined before connections-runtime.js evaluates so
// an empty initial registry broadcast cannot prevent the rest of the service
// worker from loading.
globalThis.broadcastState ??= () => {};
