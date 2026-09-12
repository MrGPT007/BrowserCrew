import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["scripts/privacy-smoke.mjs", "scripts/privacy-sinks-smoke.mjs"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "scripts/privacy-smoke.mjs"]),
  execFileAsync(process.execPath, ["--check", "scripts/privacy-sinks-smoke.mjs"])
]);

const smoke = await readFile("scripts/privacy-smoke.mjs", "utf8");
for (const contract of [
  "BC_CANARY_PROVIDER_SECRET_",
  "BC_CANARY_PASSWORD_FIELD_",
  "BC_CANARY_SCRIPT_TEXT_",
  "BC_CANARY_HIDDEN_TEXT_",
  "BC_CANARY_UNSELECTED_TAB_",
  "BC_CANARY_UNRELATED_HISTORY_",
  "BC_CANARY_UNRELATED_SKILL_",
  "requestBodies.includes(canary), false",
  "localText.includes(CANARY.provider), false",
  "sessionText.includes(CANARY.provider), true",
  "createdTaskText.includes(canary), false",
  "artifactText.includes(canary), false"
]) {
  if (!smoke.includes(contract)) throw new Error(`Privacy smoke is missing canary contract: ${contract}`);
}

const sinkSmoke = await readFile("scripts/privacy-sinks-smoke.mjs", "utf8");
for (const contract of [
  "BC_SINK_PROVIDER_SECRET_",
  "BC_SINK_PROVIDER_ERROR_",
  "BC_SINK_W2_PASSWORD_",
  "BC_SINK_W2_HIDDEN_",
  "BC_SINK_W2_SCRIPT_",
  "BC_SINK_W5_PASSWORD_",
  "BC_SINK_W5_HIDDEN_",
  "BC_SINK_W5_SCRIPT_",
  'assertNoCanaries(csv, "W2 CSV export")',
  'assertNoCanaries(jsonText, "W2 JSON export")',
  'assertNoCanaries(JSON.stringify(invoiceTask), "W5 durable invoice task")',
  'assertNoCanaries(manifestText, "W5 manifest export")',
  'assertNoCanaries(JSON.stringify(failedTask), "failed task after provider error")',
  'assertNoCanaries(historyText, "History")',
  'assertNoCanaries(localText, "chrome.storage.local")',
  'assertNoCanaries(artifactText, "privacy sink evidence artifact")',
  "response.writeHead(503",
  "CANARY.providerError",
  "CANARY.providerSecret"
]) {
  if (!sinkSmoke.includes(contract)) throw new Error(`Privacy sink smoke is missing contract: ${contract}`);
}

const background = await readFile("src/background.js", "utf8");
if (!background.includes("document.body?.innerText")) throw new Error("Selected-page observation must use the live rendered-text view before building model context.");
if (background.includes("cloneNode(true)")) throw new Error("Selected-page observation must not use a detached DOM clone that can expose hidden text.");
if (!background.includes("safeProviderErrorMessage")) throw new Error("Provider failures must use a redacted BrowserCrew-owned error message instead of persisting arbitrary provider error text.");
if (!background.includes("BrowserCrew did not copy the provider's error text into history.")) throw new Error("Baseline provider errors must keep BrowserCrew-owned redacted copy.");

const chatRuntime = await readFile("src/chat-runtime.js", "utf8");
if (!chatRuntime.includes("safeProviderErrorMessage")) throw new Error("Chat provider failures must use BrowserCrew-owned redacted error copy.");
if (!chatRuntime.includes("sanitizeMeta")) throw new Error("Chat activity metadata must stay behind the redaction helper.");

const formWrite = await readFile("src/form-write.js", "utf8");
if (!formWrite.includes('new Set(["text", "email", "tel", "url", "search", "number"])')) {
  throw new Error("Form observation must keep an explicit safe input-type allowlist that excludes password fields.");
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["privacy-smoke"] !== "node scripts/privacy-smoke.mjs") throw new Error("Privacy browser smoke must stay wired in package.json.");
if (pkg.scripts?.["privacy-sinks-smoke"] !== "node scripts/privacy-sinks-smoke.mjs") throw new Error("Privacy sink browser smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("privacy-check.mjs")) throw new Error("npm run check must include privacy gate contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run privacy-smoke")) throw new Error("Quality CI must execute seeded privacy browser coverage.");
if (!workflow.includes("npm run privacy-sinks-smoke")) throw new Error("Quality CI must execute v0.2 privacy sink browser coverage.");

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
for (const contract of [
  "| Privacy | **Passed**",
  "`V02-B02` — **Resolved",
  "ae6db27ef3978ef306f5043a7b33c35f66b32bea",
  "34696981584",
  "103562856804",
  "10299102917",
  "sha256:395986617d3c88c15860b110d4ec8f763c8edaeb395713c8b30fcd91792b9592",
  "Status: **NOT READY FOR v0.2 RELEASE**"
]) {
  if (!evidence.includes(contract)) throw new Error(`Release evidence is missing privacy proof contract: ${contract}`);
}
if (evidence.includes("| Privacy | **Partial**")) throw new Error("Privacy must not remain marked partial after exact-head sink proof passed.");

console.log("BrowserCrew v0.2 privacy gate contract checks passed.");
