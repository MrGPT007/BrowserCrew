import { readFile } from "node:fs/promises";

const chat = await readFile("src/chat-runtime.js", "utf8");
const bridge = await readFile("src/browser-control-approval-resume-ui.js", "utf8");
const formUi = await readFile("src/form-ui.js", "utf8");
const pkg = JSON.parse(await readFile("package.json", "utf8"));

for (const phrase of [
  'case "RESUME_CHAT_AFTER_BROWSER_APPROVAL"',
  'BROWSER_CONTROL_GRANT_KEY = "browsercrew.browserControlGrant.v1"',
  "APPROVAL_RESUME_SETTLE_MS = 10000",
  "browser_approval_resume",
  "do not repeat",
  "approved action",
  "waitForConversationSettled",
  "controlGrant.id !== grantId"
]) {
  if (!chat.includes(phrase)) throw new Error(`Chat approval-resume contract missing: ${phrase}`);
}

for (const phrase of [
  'BROWSER_CONTROL_PENDING_APPROVAL_KEY = "browsercrew.browserControlPendingApproval.v1"',
  'document.querySelector("#chatConversationSelect")?.value',
  'chrome.runtime.sendMessage({ type: "APPROVE_BROWSER_CONTROL_ACTION", approvalId })',
  'type: "RESUME_CHAT_AFTER_BROWSER_APPROVAL"',
  "conversationId,",
  "grantId: pending.grantId",
  "approvedLabel: pending.label",
  "approvedUrl: pending.url",
  "if (!result?.ok)",
  "CHAT_RESUME_ACCEPTED"
]) {
  if (!bridge.includes(phrase)) throw new Error(`Approval resume UI bridge contract missing: ${phrase}`);
}

if (/appendOptimisticUserMessage\([^)]*approved/i.test(bridge + chat)) {
  throw new Error("Approval continuation must not fabricate a visible user message.");
}
if (/text:\s*["'`]Continue after approved/i.test(bridge + chat)) {
  throw new Error("Approval continuation must not persist a fake user continuation message.");
}

const resumeStart = chat.indexOf("async function resumeChatAfterBrowserApproval");
const resumeEnd = chat.indexOf("async function finishModelTurn", resumeStart);
if (resumeStart < 0 || resumeEnd <= resumeStart) throw new Error("Chat approval resume function boundary could not be inspected.");
const resumeBody = chat.slice(resumeStart, resumeEnd);
for (const phrase of [
  'conversation.status === "running"',
  "activeRuns.set",
  "buildModelHistory",
  "browser_approval_resume",
  "CHAT_STARTED",
  "finishModelTurn",
  "finishRunError"
]) {
  if (!resumeBody.includes(phrase)) throw new Error(`Approval resume path missing run-safety behavior: ${phrase}`);
}
if (resumeBody.includes("current.messages.push(userMessage)")) {
  throw new Error("Approval resume must not append a synthetic user message to durable conversation history.");
}

const historyStart = chat.indexOf("function buildModelHistory");
const historyEnd = chat.indexOf("async function observeApprovedPage", historyStart);
const historyBody = chat.slice(historyStart, historyEnd);
for (const phrase of [
  "approvalResume",
  "already executed exactly once",
  "do not repeat it",
  "Re-observe the browser",
  "untrusted page metadata"
]) {
  if (!historyBody.includes(phrase)) throw new Error(`Approval resume model instruction missing: ${phrase}`);
}

if (!formUi.includes('import "./browser-control-approval-resume-ui.js";')) {
  throw new Error("The side panel must load the approval resume bridge after browser-control UI.");
}
if (!String(pkg.scripts?.check || "").includes("browser-control-approval-resume-check.mjs")) {
  throw new Error("npm run check must enforce approval resume contracts.");
}
if (pkg.scripts?.["browser-control-approval-resume-check"] !== "node scripts/browser-control-approval-resume-check.mjs") {
  throw new Error("The approval resume contract check must stay directly runnable.");
}

console.log("BrowserCrew browser-control approval resume contracts passed.");
