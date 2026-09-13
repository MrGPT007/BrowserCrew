import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const storage = new Map([
  ["browsercrew.schedules.v1", []],
  ["browsercrew.scheduleRuns.v1", []],
  ["browsercrew.skillLibrary.v1", []],
  ["browsercrew.skillRuns.v1", []]
]);
const listeners = { connect: [], alarm: [], startup: [], installed: [] };
let failNextGetAll = true;
let heldGetAll = null;
let storageGetCount = 0;

const clone = (value) => structuredClone(value);

function eventBucket(name) {
  const bucket = listeners[name];
  return {
    addListener(listener) { bucket.push(listener); },
    removeListener(listener) {
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
    hasListener(listener) { return bucket.includes(listener); }
  };
}

globalThis.chrome = {
  runtime: {
    onConnect: eventBucket("connect"),
    onStartup: eventBucket("startup"),
    onInstalled: eventBucket("installed")
  },
  storage: {
    local: {
      async get(keys) {
        storageGetCount += 1;
        if (keys == null) return Object.fromEntries([...storage.entries()].map(([key, value]) => [key, clone(value)]));
        const wanted = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        return Object.fromEntries(wanted.filter((key) => storage.has(key)).map((key) => [key, clone(storage.get(key))]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, clone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
      }
    }
  },
  alarms: {
    onAlarm: eventBucket("alarm"),
    async create() {},
    async clear() { return true; },
    async get() { return null; },
    async getAll() {
      if (failNextGetAll) {
        failNextGetAll = false;
        const error = new Error("Synthetic schedule reconciliation failure.");
        error.code = "TEST_RECONCILE_FAILURE";
        throw error;
      }
      if (heldGetAll) {
        const hold = heldGetAll;
        hold.enter();
        await hold.release;
        heldGetAll = null;
      }
      return [];
    }
  }
};

const runtime = await import("../src/schedules-runtime.js");
const normalDispatch = async () => ({ ok: true });

await assert.rejects(
  runtime.bootSchedulesRuntime({ dispatch: normalDispatch }),
  (error) => error?.code === "TEST_RECONCILE_FAILURE",
  "A failed reconciliation must reject scheduler boot."
);
assert.equal(listeners.alarm.length, 0, "Failed boot must remove the alarm listener before allowing retry.");
assert.equal(listeners.startup.length, 0, "Failed boot must remove the startup listener before allowing retry.");
assert.equal(listeners.installed.length, 0, "Failed boot must remove the install listener before allowing retry.");

let enteredResolve;
let releaseResolve;
const entered = new Promise((resolve) => { enteredResolve = resolve; });
const release = new Promise((resolve) => { releaseResolve = resolve; });
heldGetAll = { enter: enteredResolve, release };

const firstRetry = runtime.bootSchedulesRuntime({ dispatch: normalDispatch });
await entered;
assert.equal(listeners.alarm.length, 1, "Retry boot must install exactly one alarm listener.");
assert.equal(listeners.startup.length, 1, "Retry boot must install exactly one startup listener.");
assert.equal(listeners.installed.length, 1, "Retry boot must install exactly one install listener.");

const readsBeforeEarlyAlarm = storageGetCount;
const earlyAlarm = listeners.alarm[0]({ name: "browsercrew.schedule.not-found", scheduledTime: Date.now() });
await Promise.resolve();
assert.equal(storageGetCount, readsBeforeEarlyAlarm, "Alarm delivery during boot must wait for successful reconciliation instead of reading schedule state early.");

const secondRetry = runtime.bootSchedulesRuntime({
  dispatch: async () => { throw new Error("A concurrent boot must not replace the first dispatcher."); }
});
assert.equal(listeners.alarm.length, 1, "Concurrent boot calls must share one alarm listener.");
assert.equal(listeners.startup.length, 1, "Concurrent boot calls must share one startup listener.");
assert.equal(listeners.installed.length, 1, "Concurrent boot calls must share one install listener.");

releaseResolve();
await Promise.all([firstRetry, secondRetry, earlyAlarm]);
assert.equal(listeners.alarm.length, 1, "Successful retry must retain exactly one alarm listener.");
assert.equal(listeners.startup.length, 1, "Successful retry must retain exactly one startup listener.");
assert.equal(listeners.installed.length, 1, "Successful retry must retain exactly one install listener.");
assert.ok(storageGetCount > readsBeforeEarlyAlarm, "The alarm delivered during boot may inspect schedule state only after boot succeeds.");

await runtime.bootSchedulesRuntime({ dispatch: normalDispatch });
assert.equal(listeners.alarm.length, 1, "Repeated boot after success must stay idempotent.");
assert.equal(listeners.startup.length, 1, "Repeated successful boot must not duplicate startup reconciliation.");
assert.equal(listeners.installed.length, 1, "Repeated successful boot must not duplicate install reconciliation.");

const runtimeSource = await readFile(new URL("../src/schedules-runtime.js", import.meta.url), "utf8");
for (const phrase of [
  "let bootPromise = null",
  "if (bootPromise) return bootPromise",
  "removeBootListeners()",
  "dispatchScheduledRun = null",
  "chrome.alarms.onAlarm.removeListener?.(onAlarm)",
  "try { await pendingBoot; }"
]) assert.ok(runtimeSource.includes(phrase), `Scheduler failed-boot safety contract missing: ${phrase}`);

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Failed-boot hardening must not activate scheduling in the frozen v0.2 manifest.");
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
assert.equal(worker.includes("bootSchedulesRuntime"), false, "Failed-boot hardening must not boot scheduling in the production service worker.");

console.log("BrowserCrew scheduler failed-boot cleanup and concurrent retry checks passed.");
