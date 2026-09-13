import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["src/connections-runtime.js", "src/connections-ui.js", "src/styles/connections.css", "scripts/connections-smoke.mjs", "scripts/connections-migration-race-check.mjs"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/connections-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "src/connections-ui.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/connections-smoke.mjs"]),
  execFileAsync(process.execPath, ["scripts/connections-migration-race-check.mjs"])
]);

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./connections-runtime.js";')) throw new Error("Service worker must load the named AI-connection registry.");
const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./connections-ui.js";')) throw new Error("Side-panel composition must load the AI-connection registry UI.");

const runtime = await readFile("src/connections-runtime.js", "utf8");
for (const contract of [
  "browsercrew.connections.v1",
  "browsercrew.activeConnection.v1",
  "browsercrew.connectionSecrets.v1",
  "browsercrew.providerSecret.v1",
  "ACTIVATE_CONNECTION",
  "TEST_CONNECTION",
  "safeProviderErrorMessage",
  "MAX_CONNECTIONS = 12",
  "let migrationPromise = null",
  "migrateConnectionsSafely",
  "const latest = await chrome.storage.local.get([CONNECTIONS_KEY, ACTIVE_KEY])",
  "newer state always wins over a generated default"
]) if (!runtime.includes(contract)) throw new Error(`Connection registry contract missing: ${contract}`);
if (runtime.includes("ensureMigratedConnections().then(broadcastState)")) throw new Error("Connection registry must not perform boot-time migration writes that can overwrite newer restored state.");
if (/chrome\.storage\.local\.set\([^\n]*secret/i.test(runtime)) throw new Error("Connection secrets must not be written to chrome.storage.local.");

const ui = await readFile("src/connections-ui.js", "utf8");
for (const contract of [
  "AI connection for the next message",
  "Save and test connection",
  "Keep more than one AI ready",
  "Send this chat to a different AI?",
  "Switch AI for this chat",
  "chatConnectionPicker",
  "connectionTransferReview"
]) if (!ui.includes(contract)) throw new Error(`Connection UI contract missing: ${contract}`);

const css = await readFile("src/styles/connections.css", "utf8");
if (!css.includes("prefers-reduced-motion")) throw new Error("Connection UI must preserve reduced-motion support.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["connections-smoke"] !== "node scripts/connections-smoke.mjs") throw new Error("Connection smoke must stay wired in package.json.");
if (pkg.scripts?.["connections-migration-race-check"] !== "node scripts/connections-migration-race-check.mjs") throw new Error("Connection migration race regression must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("connections-check.mjs")) throw new Error("npm run check must include named-connection contracts.");
const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run connections-smoke")) throw new Error("Quality CI must execute installed-extension named-connection coverage.");

console.log("BrowserCrew C2 named AI-connection contract checks passed.");
