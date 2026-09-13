import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/watch-me-runtime.js",
  "src/watch-me-scope-review-ui.js",
  "src/skills-runner.js",
  "src/sidepanel.js",
  "scripts/watch-me-scope-review-smoke.mjs"
]) await execFileAsync(process.execPath, ["--check", file]);

const runtime = await readFile("src/watch-me-runtime.js", "utf8");
for (const phrase of [
  'case "approveScope": return approveScopeChange()',
  'const MAX_WATCH_ORIGINS = 8',
  'state.session.status !== "scope_review"',
  'chrome.permissions.contains({ origins: [`${url.origin}/*`] })',
  'const approvedOrigins = alreadyApproved ? [...state.session.approvedOrigins] : [...state.session.approvedOrigins, url.origin];',
  'scopeReview: null',
  'WATCH_SCOPE_LIMIT',
  'session.approvedOrigins.includes(expectedOrigin)'
]) assert.ok(runtime.includes(phrase), `Watch Me scope-review runtime contract missing: ${phrase}`);
assert.ok(runtime.includes('["watching", "paused", "scope_review"].includes(existing?.session?.status)'), "A scope-review session must remain an active recording and block a second recording from starting.");
assert.ok(runtime.includes('session = recordWatchEvent(session, {'), "Explicit scope approval must journal semantic navigation through the normal sanitized recorder contract.");

const ui = await readFile("src/watch-me-scope-review-ui.js", "utf8");
for (const phrase of [
  'New website needs your approval',
  'Nothing on this website is recorded until you approve it',
  'does not grant permission to replay',
  'chrome.permissions.contains',
  'chrome.permissions.request',
  'type: "approveScope"',
  'confirm(`Add ${origin} to this Watch Me recording?'
]) assert.ok(ui.includes(phrase), `Watch Me scope-review UI contract missing: ${phrase}`);
assert.equal(ui.includes('type: "resume"'), false, "Scope-review UI must never bypass explicit approval by sending a normal resume command.");

const sidepanel = await readFile("src/sidepanel.js", "utf8");
assert.ok(sidepanel.includes('import "./watch-me-scope-review-ui.js";'), "Side panel must load explicit Watch Me scope review UI.");

const runner = await readFile("src/skills-runner.js", "utf8");
assert.ok(runner.includes('assertTabInScope(tab, skill.allowedOrigins, step.kind === "navigate" ? null : step.origin);'), "Only explicit navigate steps may move between reviewed origins.");
assert.ok(runner.includes('if (!allowedOrigins.includes(url.origin)) throw coded("SKILL_NAVIGATION_OUT_OF_SCOPE"'), "Navigate destination must still be inside the exact reviewed origin set.");

const smoke = await readFile("scripts/watch-me-scope-review-smoke.mjs", "utf8");
for (const phrase of [
  'channel: "chromium",',
  'const fixtureA = await startFixtureServer("start")',
  'const fixtureB = await startFixtureServer("work")',
  'beforeApproval.session.events.length, initialEventCount',
  'approvedOrigins, [fixtureA.origin, fixtureB.origin]',
  'kind === "navigate" && event.origin === fixtureB.origin',
  'runSkill(panel',
  'Cross-site replay produces a durable exact-version completed run receipt'
]) assert.ok(smoke.includes(phrase), `Watch Me scope-review browser proof missing: ${phrase}`);
assert.equal(smoke.includes("localhost"), false, "Scope-review browser proof must use two deterministic loopback servers rather than localhost DNS resolution.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(pkg.scripts?.["watch-me-scope-review-check"], "node scripts/watch-me-scope-review-check.mjs");
assert.equal(pkg.scripts?.["watch-me-scope-review-smoke"], "node scripts/watch-me-scope-review-smoke.mjs");
assert.ok(String(pkg.scripts?.check || "").includes("node scripts/watch-me-scope-review-check.mjs"), "npm run check must include Watch Me scope-review contracts.");
const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
assert.ok(previousStable.includes('"watch-me-scope-review-smoke.mjs"'), "Chrome 152 matrix must include explicit Watch Me scope-review proof.");
const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of ["npm run watch-me-scope-review-smoke", "watch-me-scope-review-evidence", "artifacts/watch-me-scope-review-smoke"]) {
  assert.ok(workflow.includes(phrase), `Current-Chrome Watch Me scope-review evidence wiring missing: ${phrase}`);
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("alarms"), false, "Watch Me scope review must not change the v0.2 alarms boundary.");
const serviceWorker = await readFile("src/service-worker.js", "utf8");
assert.equal(serviceWorker.includes("bootSchedulesRuntime"), false, "Watch Me scope review must not activate production scheduling.");

console.log("BrowserCrew explicit Watch Me cross-site scope-review contracts passed.");
