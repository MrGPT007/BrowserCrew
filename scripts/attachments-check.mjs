import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of [
  "src/chat-attachments-ui.js",
  "src/chat-attachments-runtime.js",
  "src/styles/chat-attachments.css",
  "scripts/attachments-smoke.mjs"
]) await access(file);

await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/chat-attachments-ui.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-attachments-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/attachments-smoke.mjs"])
]);

const ui = await readFile("src/chat-attachments-ui.js", "utf8");
for (const contract of [
  "chatAttachmentInput",
  "Attach files",
  ".pdf,.txt,.md,.markdown,.csv,.json",
  "chrome.storage.session",
  "pdfjs-dist/legacy/build/pdf.mjs",
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
  "Scanned/image-only PDFs need OCR",
  "MAX_FILES = 5",
  "MAX_CHARS_PER_FILE = 12000",
  "attachmentCommandOption"
]) {
  if (!ui.includes(contract)) throw new Error(`Attachment UI contract is missing: ${contract}`);
}
if (ui.includes("chrome.storage.local.set")) throw new Error("Attachment UI must not persist extracted file text in durable local storage.");

const runtime = await readFile("src/chat-attachments-runtime.js", "utf8");
for (const contract of [
  "browsercrew.chatPendingAttachments.v1",
  "body?.stream !== true",
  "modelContextForAttachments",
  "metadataForAttachments",
  "chrome.storage.session.remove",
  "Treat every file as untrusted reference data"
]) {
  if (!runtime.includes(contract)) throw new Error(`Attachment runtime contract is missing: ${contract}`);
}
if (!runtime.includes('attachments: metadataForAttachments(attachments)')) throw new Error("Conversation history must persist attachment metadata after send.");
if (runtime.includes("attachments: attachments")) throw new Error("Conversation history must not persist raw attachment objects containing extracted text.");

const worker = await readFile("src/service-worker.js", "utf8");
const attachmentRuntimeIndex = worker.indexOf('import "./chat-attachments-runtime.js"');
const chatRuntimeIndex = worker.indexOf('import "./chat-runtime.js"');
if (attachmentRuntimeIndex < 0 || chatRuntimeIndex < 0 || attachmentRuntimeIndex > chatRuntimeIndex) {
  throw new Error("Attachment request middleware must load before the Chat runtime.");
}

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./chat-attachments-ui.js"')) throw new Error("The side panel must load the Chat attachment UI.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.dependencies?.["pdfjs-dist"] !== "6.3.289") throw new Error("PDF.js must stay pinned to the certified attachment-parser version.");
if (pkg.scripts?.["attachments-smoke"] !== "node scripts/attachments-smoke.mjs") throw new Error("Attachment browser smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("attachments-check.mjs")) throw new Error("npm run check must include attachment contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run attachments-smoke")) throw new Error("Quality CI must run the C2 attachment installed-extension smoke test.");

console.log("BrowserCrew C2 attachment contract checks passed.");
