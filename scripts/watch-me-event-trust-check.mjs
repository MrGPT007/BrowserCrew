import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
await execFileAsync(process.execPath, ["--check", "src/watch-me-page-recorder.js"]);
await execFileAsync(process.execPath, ["--check", "scripts/watch-me-event-trust-smoke.mjs"]);
await execFileAsync(process.execPath, ["--check", "scripts/watch-me-event-trust-check.mjs"]);

const recorder = await readFile("src/watch-me-page-recorder.js", "utf8");
const trustGuards = recorder.match(/event\.isTrusted !== true/g) || [];
assert.equal(trustGuards.length, 2, "Watch Me must reject untrusted click and change events before semantic recording.");
assert.ok(recorder.includes("const onClick = (event) =>"));
assert.ok(recorder.includes("const onChange = (event) =>"));
assert.equal(recorder.includes("target.value"), false, "Recorder must still avoid reading demonstrated DOM values.");

const smoke = await readFile("scripts/watch-me-event-trust-smoke.mjs", "utf8");
for (const phrase of [
  'dispatchEvent(new MouseEvent("click"',
  'dispatchEvent(new Event("change"',
  "Page-authored synthetic click/change events must not enter the Watch Me session.",
  "Synthetic page-authored values must never enter durable Watch Me state.",
  "Trusted user click and keyboard change should still be recorded.",
  "Saved draft contains only trusted demonstrated actions plus the user-authored final verification",
  'channel: "chromium"'
]) assert.ok(smoke.includes(phrase), `Watch Me event-trust browser proof missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["watch-me-event-trust-check"], "node scripts/watch-me-event-trust-check.mjs");
assert.equal(pkg.scripts?.["watch-me-event-trust-smoke"], "node scripts/watch-me-event-trust-smoke.mjs");
assert.ok(String(pkg.scripts?.["watch-me-resilience-smoke"] || "").includes("node scripts/watch-me-resilience-smoke.mjs"));
assert.ok(String(pkg.scripts?.["watch-me-resilience-smoke"] || "").includes("node scripts/watch-me-event-trust-smoke.mjs"));
assert.ok(String(pkg.scripts?.check || "").includes("watch-me-event-trust-check.mjs"));

const previousRunner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousRunner.includes('"watch-me-event-trust-smoke.mjs"'), "Chrome 152 matrix must prove the Watch Me event trust boundary.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false);
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false);

console.log("BrowserCrew Watch Me trusted-event boundary contracts passed.");
