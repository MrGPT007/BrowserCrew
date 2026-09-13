import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createWatchSession, recordWatchEvent } from "../src/watch-me-contract.js";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/watch-me-contract.js",
  "src/watch-me-page-recorder.js",
  "src/watch-me-runtime.js",
  "src/watch-me-resilience-ui.js",
  "scripts/watch-me-resilience-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const recorder = await readFile("src/watch-me-page-recorder.js", "utf8");
for (const phrase of [
  'chrome.runtime.connect({ name: "browsercrew-watch-events" })',
  'message?.type !== "watch-session"',
  "recorder.pending.length > 20",
  "Math.min(250 * (2 ** Math.min(recorder.reconnectAttempt, 3)), 2000)",
  'event.target?.closest?.("a[download]")',
  "downloadOrigin = new URL(download.href, location.href).origin",
  'kind: "download"',
  '(target.type || "").toLowerCase() === "hidden"'
]) assert.ok(recorder.includes(phrase), `Watch recorder resilience contract missing: ${phrase}`);
assert.equal(recorder.includes("target.value"), false, "Watch recorder must never read typed or selected DOM values.");
assert.equal(recorder.includes("navigator.clipboard"), false, "Watch recorder must never read clipboard contents.");
assert.equal(recorder.includes("document.cookie"), false, "Watch recorder must never read browser cookies.");

const runtime = await readFile("src/watch-me-runtime.js", "utf8");
for (const phrase of [
  'case "markWait"',
  "markWaitForText",
  'kind: "waitFor"',
  'type: "watch-session"',
  "verifyCompletionText",
  "installWatchPageRecorder",
  "stopWatchPageRecorder",
  "const saved = await saveSkillDraft(draft)",
  "draft: savedDraft"
]) assert.ok(runtime.includes(phrase), `Watch runtime resilience contract missing: ${phrase}`);

const ui = await readFile("src/watch-me-resilience-ui.js", "utf8");
for (const phrase of [
  "Did this page take time to become ready?",
  "Use only non-private text you chose yourself.",
  "Add wait for visible text",
  'type: "markWait"'
]) assert.ok(ui.includes(phrase), `Watch wait UI contract missing: ${phrase}`);
const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./watch-me-resilience-ui.js";'), "Side panel must load the additive Watch Me resilience UI.");

const origin = "https://example.test";
let session = createWatchSession({ id: "watch-resilience", tabId: 7, origin, startedAt: "2026-09-13T02:00:00.000Z" });
const hiddenSnapshot = structuredClone(session);
session = recordWatchEvent(session, {
  id: "hidden-change",
  kind: "type",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-13T02:00:01.000Z",
  target: { role: "textbox", type: "hidden", name: "api_token", id: "hiddenSecret" },
  variableName: "apiToken"
});
assert.deepEqual(session, hiddenSnapshot, "Hidden input events must be ignored even if a page synthesizes them.");
session = recordWatchEvent(session, {
  id: "wait-ready",
  kind: "waitFor",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-13T02:00:02.000Z",
  expect: { visibleText: "Results loaded" }
});
session = recordWatchEvent(session, {
  id: "download-report",
  kind: "download",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-13T02:00:03.000Z",
  target: { role: "link", label: "Download report" },
  downloadOrigin: origin
});
assert.equal(session.events[0].kind, "waitFor");
assert.deepEqual(session.events[0].expect, { visibleText: "Results loaded" });
assert.equal(session.events[1].kind, "download");
assert.deepEqual(session.events[1].download, { userInitiated: true, expectedUrlOrigin: origin });
assert.equal(Object.prototype.hasOwnProperty.call(session.events[1].download, "contents"), false);
assert.throws(() => recordWatchEvent(session, {
  id: "download-outside",
  kind: "download",
  tabId: 7,
  origin,
  pageUrl: `${origin}/form`,
  occurredAt: "2026-09-13T02:00:04.000Z",
  target: { role: "link", label: "Other site file" },
  downloadOrigin: "https://other.test"
}), /approved site scope/);

const smoke = await readFile("scripts/watch-me-resilience-smoke.mjs", "utf8");
for (const phrase of [
  "terminateServiceWorker(context, panel, extensionId)",
  'session.send("Target.closeTarget"',
  'session.send("Target.getTargets")',
  "Closed BrowserCrew service-worker CDP target should disappear before recovery is tested.",
  "waitForLiveWorker(context, extensionId, 45_000)",
  "browserContext.serviceWorkers()",
  "await candidate.evaluate(() => true)",
  "Restart recovery must not duplicate earlier events.",
  "Restart recovery must not duplicate the resumed event."
]) assert.ok(smoke.includes(phrase), `Watch suspension/recovery proof missing: ${phrase}`);
assert.equal(smoke.includes("async function waitForNextWorker"), false, "Watch resilience proof must not depend on Playwright emitting a brand-new serviceworker event after MV3 restart.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "npm run watch-me-resilience-smoke",
  "watch-me-resilience-evidence",
  "artifacts/watch-me-resilience-smoke"
]) assert.ok(workflow.includes(phrase), `Current-stable Watch resilience gate missing: ${phrase}`);
const previousRunner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousRunner.includes('"watch-me-resilience-smoke.mjs"'), "Chrome 152 matrix must include Watch Me resilience coverage.");
assert.ok(previousRunner.includes('"watch-me-event-trust-smoke.mjs"'), "Chrome 152 matrix must include hostile page-event trust coverage.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Watch Me resilience must not widen the active v0.2 manifest.");
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Watch Me resilience must not boot production scheduling.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["watch-me-resilience-check"], "node scripts/watch-me-resilience-check.mjs");
const watchResilienceSmoke = String(pkg.scripts?.["watch-me-resilience-smoke"] || "");
assert.ok(watchResilienceSmoke.includes("node scripts/watch-me-resilience-smoke.mjs"), "Current Chrome Watch resilience gate must keep the service-worker restart smoke.");
assert.ok(watchResilienceSmoke.includes("node scripts/watch-me-event-trust-smoke.mjs"), "Current Chrome Watch resilience gate must also prove hostile synthetic page events are rejected.");
assert.equal(pkg.scripts?.["watch-me-event-trust-smoke"], "node scripts/watch-me-event-trust-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("watch-me-resilience-check.mjs"));

console.log("BrowserCrew Watch Me recorder resilience contracts passed.");
