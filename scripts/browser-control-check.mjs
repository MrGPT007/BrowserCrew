import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/browser-control-runtime.js",
  "src/browser-control-ui.js",
  "src/styles/browser-control.css",
  "src/chat-tools-runtime.js",
  "src/form-ui.js",
  "scripts/browser-control-smoke.mjs",
  "manifest.json",
  "package.json",
  ".github/workflows/quality.yml"
]) await access(file);

await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/browser-control-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "src/browser-control-ui.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-tools-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/browser-control-smoke.mjs"])
]);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
for (const permission of ["activeTab", "scripting", "tabs", "downloads"]) {
  if (!manifest.permissions?.includes(permission)) throw new Error(`Browser control requires existing manifest permission: ${permission}`);
}
if (manifest.permissions?.includes("debugger")) throw new Error("Browser control must not widen production authority with the Chrome debugger permission.");
for (const origin of ["https://*/*", "http://*/*"]) {
  if (!manifest.optional_host_permissions?.includes(origin)) throw new Error(`Browser control must keep browser-wide site access optional: ${origin}`);
}

const runtime = await readFile("src/browser-control-runtime.js", "utf8");
for (const phrase of [
  'BROWSER_CONTROL_GRANT_KEY = "browsercrew.browserControlGrant.v1"',
  'BROWSER_CONTROL_TOOL_NAME = "browsercrew_browser_control"',
  'BROWSER_CONTROL_MAX_STEPS = 24',
  '"observe"', '"list_tabs"', '"open_tab"', '"focus_tab"', '"close_tab"', '"navigate"',
  '"back"', '"forward"', '"reload"', '"click"', '"type"', '"select"', '"scroll"', '"press_key"', '"download_url"',
  'chrome.storage.session.get(BROWSER_CONTROL_GRANT_KEY)',
  'chrome.permissions.contains({ origins: BROAD_ORIGINS })',
  'data-browsercrew-agent-ref',
  'SECRET_FIELD_BLOCKED',
  'CONFIRMATION_REQUIRED',
  'BROWSER_REF_STALE',
  'signal?.aborted',
  'normal http or https'
]) if (!runtime.includes(phrase)) throw new Error(`Browser control runtime contract missing: ${phrase}`);
if (/eval\s*\(|new Function\s*\(/.test(runtime)) throw new Error("Browser control must not execute model-supplied JavaScript.");
if (/executeScript\([^)]*func\s*:\s*args\./s.test(runtime)) throw new Error("Browser control must dispatch only built-in injected functions, never model-supplied functions.");

const tools = await readFile("src/chat-tools-runtime.js", "utf8");
for (const phrase of [
  'from "./browser-control-runtime.js"',
  'getBrowserControlGrant()',
  'browserControlToolDefinition()',
  'runBrowserControlTool',
  'browserSteps += 1',
  'requested.name === BROWSER_CONTROL_TOOL_NAME',
  'Browser control was turned off before the next action',
  'tool_choice: availableTools.length ? "auto" : "none"',
  'one verified action at a time'
]) if (!tools.includes(phrase)) throw new Error(`Chat browser-control dispatch contract missing: ${phrase}`);

const ui = await readFile("src/browser-control-ui.js", "utf8");
for (const phrase of [
  'id = "browserControlStatus"',
  'Browser control',
  'chrome.permissions.request({ origins: BROAD_ORIGINS })',
  'chrome.storage.session.set({ [BROWSER_CONTROL_GRANT_KEY]: grant })',
  'chrome.storage.session.remove(BROWSER_CONTROL_GRANT_KEY)',
  '"ON · Working"',
  '"ON · Browser access"',
  'aria-pressed'
]) if (!ui.includes(phrase)) throw new Error(`Browser control UI contract missing: ${phrase}`);

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./browser-control-ui.js";')) throw new Error("The side panel must load the browser-control status UI.");

const css = await readFile("src/styles/browser-control.css", "utf8");
for (const phrase of ["#browserControlStatus", "body.chat-surface-active", "prefers-reduced-motion"]) {
  if (!css.includes(phrase)) throw new Error(`Browser control CSS contract missing: ${phrase}`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["browser-control-check"] !== "node scripts/browser-control-check.mjs") throw new Error("browser-control-check must stay wired in package.json.");
if (pkg.scripts?.["browser-control-smoke"] !== "node scripts/browser-control-smoke.mjs") throw new Error("browser-control-smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("browser-control-check.mjs")) throw new Error("npm run check must enforce browser-control contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "Run post-v0.2 browser control installed-extension smoke test",
  "npm run browser-control-smoke",
  "name: browser-control-evidence",
  "path: artifacts/browser-control-smoke"
]) if (!workflow.includes(phrase)) throw new Error(`Quality workflow browser-control gate missing: ${phrase}`);

const previousStable = await readFile("scripts/previous-stable-runner.mjs", "utf8");
if (!previousStable.includes('"browser-control-smoke.mjs"')) throw new Error("Previous-stable Chrome must run browser-control smoke coverage.");

console.log("BrowserCrew browser-control session contracts passed.");
