import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["src/mcp-runtime.js","src/mcp-ui.js","src/styles/mcp.css","scripts/mcp-smoke.mjs"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath,["--check","src/mcp-runtime.js"]),
  execFileAsync(process.execPath,["--check","src/mcp-ui.js"]),
  execFileAsync(process.execPath,["--check","scripts/mcp-smoke.mjs"])
]);

const runtime = await readFile("src/mcp-runtime.js","utf8");
for (const contract of [
  'MCP_PROTOCOL = "2026-07-28"',
  '"MCP-Protocol-Version": MCP_PROTOCOL',
  '"Mcp-Method": method',
  'headers["Mcp-Name"] = name',
  '"server/discover"',
  '"tools/list"',
  '"tools/call"',
  'browsercrew.mcpSecrets.v1',
  'browsercrew.mcpActions.v1',
  'classification: "review"',
  'mcp_write_intent',
  'mcp_write_outcome_unknown',
  'reconcileInterruptedMcpWrites',
  'maxCalls: 1',
  'approval.requested',
  'tool.authorized',
  'tool.completed',
  'canonicalJson(args)',
  'canonicalJson(pending.arguments || {})',
  'Object.keys(value).sort()'
]) if (!runtime.includes(contract)) throw new Error(`MCP runtime contract missing: ${contract}`);
if (runtime.includes("chrome.cookies")) throw new Error("MCP runtime must never read browser cookies.");
if (runtime.includes("Mcp-Session-Id")) throw new Error("C4 targets stateless MCP 2026-07-28 and must not add a legacy session dependency.");

const ui = await readFile("src/mcp-ui.js","utf8");
for (const contract of [
  "Connect a tool server",
  "Needs review — keep disabled",
  "Read only — does not change data",
  "Changes data — always review before run",
  "Make available in Chat",
  "REVIEW EXTERNAL CHANGE",
  "Approve this change",
  "Chrome session storage"
]) if (!ui.includes(contract)) throw new Error(`MCP UI contract missing: ${contract}`);
if (ui.includes("chrome.storage.local.set")) throw new Error("MCP UI must not directly persist bearer secrets or tool arguments to local storage.");

const worker = await readFile("src/service-worker.js","utf8");
const mcp = worker.indexOf('import "./mcp-runtime.js"');
const tools = worker.indexOf('import "./chat-tools-runtime.js"');
const attachments = worker.indexOf('import "./chat-attachments-runtime.js"');
const chat = worker.indexOf('import "./chat-runtime.js"');
if (!(mcp >= 0 && mcp < tools && tools < attachments && attachments < chat)) throw new Error("MCP middleware must load before built-in tools, attachments, and Chat runtime.");
const formUi = await readFile("src/form-ui.js","utf8");
if (!formUi.includes('import "./mcp-ui.js"')) throw new Error("The side panel must load MCP management and Chat controls.");

const pkg = JSON.parse(await readFile("package.json","utf8"));
if (pkg.scripts?.["mcp-smoke"] !== "node scripts/mcp-smoke.mjs") throw new Error("C4 MCP browser smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("mcp-check.mjs")) throw new Error("npm run check must include C4 MCP contracts.");
const workflow = await readFile(".github/workflows/quality.yml","utf8");
if (!workflow.includes("npm run mcp-smoke")) throw new Error("Quality CI must run the C4 MCP installed-extension smoke test.");
console.log("BrowserCrew C4 MCP contract checks passed.");
