import { bootSchedulesRuntime, reviewMissedScheduleRun } from "../src/schedules-runtime.js";
import { runTask } from "../src/background.js";

const runs = new Map();
let payloadsBySchedule = {};

globalThis.__browsercrewScheduleControlBoot = async (payloads = {}) => {
  payloadsBySchedule = structuredClone(payloads || {});
  await bootSchedulesRuntime({
    dispatch: async (input) => {
      if (input.mode === "preflight") return { grantsValid: true, providerAvailable: true, resourceFresh: true };
      const payload = payloadsBySchedule[input.schedule?.id];
      if (!payload) return { ok: false, error: { code: "TEST_PAYLOAD_MISSING" } };
      if (payload.__browsercrewDirectResult === true) {
        return { ok: true, task: { id: `schedule-control-direct:${input.schedule.id}:${crypto.randomUUID()}`, status: "completed" } };
      }
      return runTask(payload);
    }
  });
  return { alarmsPermission: chrome.runtime.getManifest().permissions.includes("alarms"), booted: true };
};

globalThis.__browsercrewScheduleControlStart = (runId) => {
  if (!runId) throw new Error("Scheduled test run id is required.");
  if (runs.has(runId)) throw new Error(`Scheduled test run already started: ${runId}`);
  runs.set(runId, reviewMissedScheduleRun(runId, "run_once"));
  return true;
};

globalThis.__browsercrewScheduleControlFinish = async (runId) => {
  const promise = runs.get(runId);
  if (!promise) throw new Error(`No scheduled test run promise exists for ${runId}.`);
  return promise;
};
