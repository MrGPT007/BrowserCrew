import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertAgentConnectionAllowed,
  consumeAgentBudget,
  createAgentPolicy,
  publicAgentPolicy
} from "../src/agent-policy.js";

const execFileAsync = promisify(execFile);
for (const file of ["src/agent-policy.js", "src/chat-c5-runtime.js", "src/chat-c5-ui.js", "src/styles/chat-c5.css", "scripts/c5-smoke.mjs"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/agent-policy.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-c5-runtime.js"]),
  execFileAsync(process.execPath, ["--check", "src/chat-c5-ui.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/c5-smoke.mjs"])
]);

const policy = createAgentPolicy({ mode: "compare", allowedConnectionIds: ["a", "b"], requestedBudgets: { modelCalls: 99, toolCalls: 99, handoffs: 99 } });
const snapshot = publicAgentPolicy(policy);
if (snapshot.budget.modelCalls.max !== 2 || snapshot.budget.toolCalls.max !== 0 || snapshot.budget.handoffs.max !== 1) throw new Error("AGT-01 budgets must clamp to compare hard limits.");
consumeAgentBudget(policy, "handoffs");
consumeAgentBudget(policy, "modelCalls");
consumeAgentBudget(policy, "modelCalls");
for (const [fn, code] of [
  [() => consumeAgentBudget(policy, "modelCalls"), "AGENT_MODEL_BUDGET_EXHAUSTED"],
  [() => consumeAgentBudget(policy, "toolCalls"), "AGENT_TOOL_BUDGET_EXHAUSTED"],
  [() => consumeAgentBudget(policy, "handoffs"), "AGENT_HANDOFF_BUDGET_EXHAUSTED"],
  [() => assertAgentConnectionAllowed(policy, "c"), "AGENT_CONNECTION_NOT_ALLOWED"]
]) {
  let threw = false;
  try { fn(); } catch (error) { threw = error?.code === code; }
  if (!threw) throw new Error(`AGT-01 policy did not enforce ${code}.`);
}

const runtime = await readFile("src/chat-c5-runtime.js", "utf8");
for (const contract of [
  'const C5_PORT = "browsercrew-chat-c5"',
  'browsercrew.connections.v1',
  'browsercrew.connectionSecrets.v1',
  'browsercrew.c5Pending.v1',
  'status: "awaiting_approval"',
  'checkpoint: "c5_transfer_preview"',
  'assertAgentNotCancelled(runtime)',
  'consumeAgentBudget(runtimePolicy, "handoffs")',
  'consumeAgentBudget(policy, "modelCalls")',
  'c5_interrupted_no_replay',
  'includesAttachmentContents: false',
  'includesToolResults: false'
]) if (!runtime.includes(contract)) throw new Error(`C5 runtime contract missing: ${contract}`);
if (runtime.includes("chrome.cookies") || runtime.includes("document.cookie")) throw new Error("C5 runtime must not read browser cookies.");
if (!runtime.includes("/secret|key|authorization|cookie|token|prompt|content|text|reasoning/i")) throw new Error("C5 activity metadata must redact sensitive prompt/content/reasoning fields.");

const ui = await readFile("src/chat-c5-ui.js", "utf8");
for (const contract of [
  "Ask another AI, with limits",
  "Review what will be sent",
  "Maximum AI calls",
  "Maximum tool calls",
  "Maximum transfers",
  "Approve and run",
  "Stop compare / handoff",
  "BrowserCrew will not silently switch your active AI"
]) if (!ui.includes(contract)) throw new Error(`C5 UI contract missing: ${contract}`);

const worker = await readFile("src/service-worker.js", "utf8");
const c5 = worker.indexOf('import "./chat-c5-runtime.js"');
const mcp = worker.indexOf('import "./mcp-runtime.js"');
const tools = worker.indexOf('import "./chat-tools-runtime.js"');
const chat = worker.indexOf('import "./chat-runtime.js"');
if (!(c5 >= 0 && c5 < mcp && mcp < tools && tools < chat)) throw new Error("C5 policy runtime must load before MCP, built-in tools, and baseline Chat.");

const formUi = await readFile("src/form-ui.js", "utf8");
if (!formUi.includes('import "./chat-c5-ui.js"')) throw new Error("Chat must load the C5 compare / handoff surface.");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["agent-c5-check"] !== "node scripts/agent-c5-check.mjs") throw new Error("AGT-01/C5 static check must stay wired in package.json.");
if (pkg.scripts?.["c5-smoke"] !== "node scripts/c5-smoke.mjs") throw new Error("C5 installed-extension smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("agent-c5-check.mjs")) throw new Error("npm run check must include AGT-01/C5 contracts.");
const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run c5-smoke")) throw new Error("Quality CI must run the C5 installed-extension smoke test.");
console.log("BrowserCrew AGT-01 / C5 contract checks passed.");
