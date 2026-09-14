import { readFile } from "node:fs/promises";

const runtime = await readFile("src/browser-control-runtime.js", "utf8");
const tools = await readFile("src/chat-tools-runtime.js", "utf8");
const chat = await readFile("src/chat-runtime.js", "utf8");
const ui = await readFile("src/browser-control-ui.js", "utf8");

for (const phrase of [
  "conversationId",
  "approvalId",
  "APPROVE_BROWSER_CONTROL_ACTION"
]) {
  if (!runtime.includes(phrase) && !tools.includes(phrase)) {
    throw new Error(`Approval continuation must bind pending approval context to the originating Chat: ${phrase}`);
  }
}

for (const phrase of [
  "RESUME_CHAT_AFTER_BROWSER_APPROVAL",
  "browser_approval_resume",
  "do not repeat",
  "approved action"
]) {
  if (!chat.includes(phrase)) throw new Error(`Chat approval-resume contract missing: ${phrase}`);
}

if (!ui.includes("RESUME_CHAT_AFTER_BROWSER_APPROVAL")) {
  throw new Error("Approve once must request a Chat resume after the exact click succeeds.");
}
if (!ui.includes("result?.conversationId")) {
  throw new Error("Approval UI must resume only the conversation bound to the approved action.");
}
if (/appendOptimisticUserMessage\([^)]*approved/i.test(ui + chat)) {
  throw new Error("Approval continuation must not fabricate a visible user message.");
}
if (/text:\s*["'`]Continue after approved/i.test(ui + chat)) {
  throw new Error("Approval continuation must not persist a fake user continuation message.");
}

const resumeCase = chat.indexOf('case "RESUME_CHAT_AFTER_BROWSER_APPROVAL"');
if (resumeCase < 0) throw new Error("Chat runtime must expose an explicit approval-resume message path.");
const resumeBody = chat.slice(resumeCase, resumeCase + 7000);
for (const phrase of [
  "conversation.status === \"running\"",
  "activeRuns.set",
  "buildModelHistory",
  "browser_approval_resume",
  "CHAT_STARTED",
  "CHAT_DONE"
]) {
  if (!resumeBody.includes(phrase)) throw new Error(`Approval resume path missing run-safety behavior: ${phrase}`);
}
if (resumeBody.includes("current.messages.push(userMessage)")) {
  throw new Error("Approval resume must not append a synthetic user message to durable conversation history.");
}

console.log("BrowserCrew browser-control approval resume contracts passed.");
