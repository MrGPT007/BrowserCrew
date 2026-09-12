import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = {
  worker: await readFile("src/service-worker.js", "utf8"),
  runtime: await readFile("src/agent-policy-runtime.js", "utf8"),
  ui: await readFile("src/agent-console-ui.js", "utf8"),
  formUi: await readFile("src/form-ui.js", "utf8"),
  css: await readFile("src/styles/agent-console.css", "utf8"),
  smoke: await readFile("scripts/agent-smoke.mjs", "utf8"),
  workflow: await readFile(".github/workflows/quality.yml", "utf8")
};

assert.match(files.worker, /import "\.\/agent-policy-runtime\.js";/, "Service worker must load the bounded agent policy runtime.");
assert.match(files.formUi, /import "\.\/agent-console-ui\.js";/, "Side-panel composition must load the C5 multi-model UI.");

for (const contract of [
  /MAX_MODEL_CALLS = 2/,
  /MAX_TOOL_CALLS = 0/,
  /MAX_HANDOFFS = 1/,
  /browsercrew\.connections\.v1/,
  /browsercrew\.connectionSecrets\.v1/,
  /browsercrew\.agentPendingGrant\.v1/,
  /PREVIEW_AGENT_RUN/,
  /START_AGENT_RUN/,
  /STOP_AGENT_RUN/,
  /MODEL_BUDGET_EXHAUSTED/,
  /HANDOFF_BUDGET_EXHAUSTED/,
  /allowedConnectionIds/,
  /assertRunCanDispatch/,
  /reconcileInterruptedAgentRuns/,
  /interrupted_no_replay/,
  /canonicalJson/,
  /chrome\.storage\.session/
]) assert.match(files.runtime, contract, `Missing C5 policy contract: ${contract}`);

assert.doesNotMatch(files.runtime, /document\.cookie|chrome\.cookies/, "C5 must not access browser cookies.");
assert.doesNotMatch(files.runtime, /tools\/call|requestSubmit|\.submit\(/, "C5 orchestration must not dispatch tools or form writes.");
assert.match(files.ui, /Review destinations/, "C5 must review destinations before sending.");
assert.match(files.ui, /2 model calls max/, "C5 UI must disclose the model-call budget.");
assert.match(files.ui, /0 tools/, "C5 UI must disclose the zero tool budget.");
assert.match(files.ui, /1 cross-model handoff max/, "C5 UI must disclose the handoff budget.");
assert.match(files.ui, /current-chat history, page text, attachments, MCP results, browser cookies, or secret keys/i, "C5 must disclose excluded private context.");
assert.match(files.ui, /Compare two models/, "Ctrl+K bridge must expose a multi-model command.");
assert.match(files.ui, /private hidden chain-of-thought/, "Activity copy must explicitly avoid hidden chain-of-thought.");
assert.match(files.css, /@media \(max-width: 390px\)/, "C5 UI must remain usable at narrow side-panel widths.");
assert.match(files.css, /prefers-reduced-motion/, "C5 UI must respect reduced motion.");

for (const proof of [
  /budget exhaustion/i,
  /without approval/i,
  /Stop prevented/i,
  /interrupted/i,
  /two connected AI profiles/i
]) assert.match(files.smoke, proof, `C5 installed-browser proof is missing: ${proof}`);

assert.match(files.workflow, /Run C5 bounded multi-model installed-extension smoke test/, "Quality workflow must run C5 installed-extension certification.");

console.log("BrowserCrew AGT-01 / C5 static contracts passed.");
