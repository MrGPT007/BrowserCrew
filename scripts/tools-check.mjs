import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/chat-tools-runtime.js",
  "src/chat-tools-ui.js",
  "src/styles/chat-tools.css",
  "scripts/tools-smoke.mjs",
  "tests/fixtures/chat-tool-page.html"
]) await access(file);

await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/chat-tools-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-tools-ui.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/tools-smoke.mjs"])
]);

const runtime = await readFile("src/chat-tools-runtime.js", "utf8");
for (const contract of [
  "browsercrew.chatPendingToolGrant.v1",
  "browsercrew_page_read",
  "additionalProperties: false",
  "tool.requested",
  "tool.authorized",
  "tool.started",
  "tool.completed",
  "verification",
  "exactUrlMatched: true",
  "MAX_PAGE_CHARS = 12000",
  "pageReadUsed = false",
  "requested.name === TOOL_NAME && canUsePage",
  "pageReadUsed = true",
  "input[type='password']"
]) {
  if (!runtime.includes(contract)) throw new Error(`C3 tool runtime contract is missing: ${contract}`);
}
if (/requested\.arguments[^\n]*url/i.test(runtime)) throw new Error("page.read must not trust a model-supplied URL.");
if (runtime.includes("chrome.cookies")) throw new Error("Chat tool runtime must not read browser cookies.");

const ui = await readFile("src/chat-tools-ui.js", "utf8");
for (const contract of [
  "Allow one page read",
  "Read only",
  "one message",
  "exact tab",
  "chrome.permissions.request",
  "chrome.storage.session",
  "Page read result"
]) {
  if (!ui.includes(contract)) throw new Error(`C3 tool UI contract is missing: ${contract}`);
}
if (ui.includes("chrome.storage.local.set")) throw new Error("Chat tool UI must not write raw page context to durable storage.");

const worker = await readFile("src/service-worker.js", "utf8");
const toolsIndex = worker.indexOf('import "./chat-tools-runtime.js"');
const attachmentsIndex = worker.indexOf('import "./chat-attachments-runtime.js"');
const chatIndex = worker.indexOf('import "./chat-runtime.js"');
if (toolsIndex < 0 || attachmentsIndex < 0 || chatIndex < 0 || !(toolsIndex < attachmentsIndex && attachmentsIndex < chatIndex)) {
  throw new Error("C3 tool middleware must load before attachment middleware and Chat runtime so combined file+tool messages preserve both contexts.");
}

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./chat-tools-ui.js"')) throw new Error("The side panel must load Chat tool controls.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["tools-smoke"] !== "node scripts/tools-smoke.mjs") throw new Error("C3 installed-extension tool smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("tools-check.mjs")) throw new Error("npm run check must include C3 tool contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run tools-smoke")) throw new Error("Quality CI must run the C3 tool installed-extension smoke test.");

console.log("BrowserCrew C3 Chat tool contract checks passed.");
