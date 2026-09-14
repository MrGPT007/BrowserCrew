import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/chat-runtime.js",
  "src/chat-ui.js",
  "src/chat-shell-ui.js",
  "src/styles/chat.css",
  "src/styles/chat-shell.css",
  "scripts/chat-smoke.mjs"
]) await access(file);

await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/chat-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-ui.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-shell-ui.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/chat-smoke.mjs"])
]);

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./chat-runtime.js";')) throw new Error("Service worker must load the Chat runtime.");

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./chat-ui.js";')) throw new Error("Side-panel composition must load the Chat UI.");
if (!formUi.includes('import "./chat-shell-ui.js";')) throw new Error("Side-panel composition must load the chat-first progressive shell.");

const runtime = await readFile("src/chat-runtime.js", "utf8");
for (const contract of [
  'const CHAT_PORT = "browsercrew-chat"',
  'browsercrew.conversations.v1',
  'new AbortController()',
  'stream: true',
  'document.body?.innerText',
  'model.request.started',
  'checkpoint.saved',
  'Do not reveal hidden chain-of-thought',
  'safeProviderErrorMessage',
  'reconcileInterruptedChats'
]) {
  if (!runtime.includes(contract)) throw new Error(`Chat runtime contract missing: ${contract}`);
}
if (runtime.includes("cloneNode(true)")) throw new Error("Chat page context must not use detached DOM clones.");
if (/body\?\.textContent|document\.body\?\.textContent/.test(runtime)) throw new Error("Chat page context must not fall back to raw body textContent.");

const ui = await readFile("src/chat-ui.js", "utf8");
for (const contract of [
  'id = "tab-chat"',
  'Live activity',
  'chatUseCurrentPage',
  'chatStopButton',
  'commandPalette',
  'event.ctrlKey || event.metaKey',
  'event.key.toLowerCase() === "k"',
  'Switch model / AI connection',
  'Stop current response',
  'textContent = String(message.text || "")'
]) {
  if (!ui.includes(contract)) throw new Error(`Chat UI contract missing: ${contract}`);
}
if (/innerHTML\s*=.*message\.(text|content)/.test(ui)) throw new Error("Chat messages must be rendered as text, not interpolated HTML.");

const shell = await readFile("src/chat-shell-ui.js", "utf8");
for (const contract of [
  'document.querySelector("#tab-chat")?.click()',
  'backdrop.id = "aiSetupBackdrop"',
  'document.body.append(backdrop)',
  'view.setAttribute("aria-modal", "true")',
  'document.querySelector("#aiStatus")',
  'openAiSetupModal',
  'moveAiHelpBehindDisclosure',
  'chat-surface-active',
  'active?.status === "connected"',
  'accessibility-ui.js'
]) {
  if (!shell.includes(contract)) throw new Error(`Chat-first shell contract missing: ${contract}`);
}
if (!shell.includes('summary.textContent = "Connection help"')) throw new Error("AI setup help must remain behind progressive disclosure.");

const css = await readFile("src/styles/chat.css", "utf8");
if (!css.includes("prefers-reduced-motion")) throw new Error("Chat UI must preserve reduced-motion support.");
if (!css.includes("translate(1.5px,1.5px)") || !css.includes("translate(3px,3px)")) throw new Error("Chat controls must preserve NeoBrutal Soft compress interaction.");
if (/translateY\(-|translate\([^\n]*-\d/.test(css)) throw new Error("Chat controls must not float upward on hover/active.");

const shellCss = await readFile("src/styles/chat-shell.css", "utf8");
for (const contract of [
  ".shell-modal-backdrop",
  ".chat-primary-transcript",
  "body.chat-surface-active #pageStatus",
  ".ai-status-trigger",
  ".ai-help-disclosure",
  "prefers-reduced-motion"
]) {
  if (!shellCss.includes(contract)) throw new Error(`Chat-first shell CSS contract missing: ${contract}`);
}

const accessibilityUi = await readFile("src/accessibility-ui.js", "utf8");
if (!accessibilityUi.includes('"summary"')) throw new Error("Modal focus trapping must include progressive disclosure summaries.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["chat-smoke"] !== "node scripts/chat-smoke.mjs") throw new Error("Chat smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("chat-check.mjs")) throw new Error("npm run check must include Chat contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run chat-smoke")) throw new Error("Quality CI must execute installed-extension Chat coverage.");

console.log("BrowserCrew C1 Chat + command bar + chat-first shell contract checks passed.");
