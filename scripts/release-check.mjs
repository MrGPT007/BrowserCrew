import { access, readFile } from "node:fs/promises";

const requiredDocs = [
  "docs/TEST-PLAN-v0.2.md",
  "docs/THREAT-MODEL.md",
  "docs/PROVIDER-MATRIX.md",
  "docs/SUPPORTED-WORKFLOWS.md",
  "docs/RELEASE-EVIDENCE-v0.2.md",
  "docs/INSTALL.md",
  "docs/ROLLBACK.md",
  "tests/scenarios/v0.2.json"
];
for (const path of requiredDocs) await access(path);

const catalog = JSON.parse(await readFile("tests/scenarios/v0.2.json", "utf8"));
if (catalog.schemaVersion !== 1 || catalog.release !== "v0.2") throw new Error("v0.2 scenario catalog identity changed.");
if (catalog.requiredRunsPerScenario !== 3 || catalog.requiredScenarioCount !== 25) throw new Error("PRD section 16 requires 25 scenarios run three times each.");
if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length !== 25) throw new Error("v0.2 scenario catalog must contain exactly 25 scenarios.");
const ids = new Set();
for (const scenario of catalog.scenarios) {
  if (!/^W[1-5]-0[1-5]$/.test(scenario.id)) throw new Error(`Invalid release scenario id: ${scenario.id}`);
  if (ids.has(scenario.id)) throw new Error(`Duplicate release scenario id: ${scenario.id}`);
  ids.add(scenario.id);
  if (!["representative", "planned"].includes(scenario.coverage)) throw new Error(`Scenario ${scenario.id} has an unsupported coverage state.`);
  if (scenario.coverage === "representative" && !scenario.evidence) throw new Error(`Representative scenario ${scenario.id} must point to regression evidence.`);
  if (scenario.coverage === "planned" && scenario.evidence) throw new Error(`Planned scenario ${scenario.id} must not masquerade as completed evidence.`);
}
for (const workflow of ["W1", "W2", "W3", "W4", "W5"]) {
  const count = catalog.scenarios.filter((scenario) => scenario.workflow === workflow).length;
  if (count !== 5) throw new Error(`${workflow} must have exactly five release scenarios; found ${count}.`);
}

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
if (!evidence.includes("NOT READY FOR v0.2 RELEASE")) throw new Error("Release evidence must stay explicitly NOT READY until every PRD gate is proven.");
for (const gate of ["Workflow completion", "Permission enforcement", "Recovery", "Duplicate writes", "Result integrity", "Privacy", "Provider support", "Accessibility", "Package integrity"]) {
  if (!evidence.includes(gate)) throw new Error(`Release evidence is missing PRD gate: ${gate}`);
}
for (const blocker of ["V02-B01", "V02-B02", "V02-B03", "V02-B04", "V02-B05", "V02-B06", "V02-B07", "V02-B08"]) {
  if (!evidence.includes(blocker)) throw new Error(`Release evidence is missing blocker ${blocker}.`);
}

const providerMatrix = await readFile("docs/PROVIDER-MATRIX.md", "utf8");
for (const provider of ["OpenAI API", "LM Studio", "Ollama", "Anthropic API"]) {
  if (!providerMatrix.includes(provider)) throw new Error(`Provider matrix is missing ${provider}.`);
}
if (!providerMatrix.includes("NOT CERTIFIED")) {
  throw new Error("Provider matrix must keep unverified external-provider paths explicitly NOT CERTIFIED.");
}
const anthropicRow = providerMatrix.split("\n").find((line) => line.startsWith("| Anthropic API |")) || "";
if (!anthropicRow.includes("Implemented through the native Messages API adapter")) {
  throw new Error("Provider matrix must describe the implemented Anthropic path as the native Messages API adapter.");
}
if (!anthropicRow.includes("**NOT CERTIFIED for live v0.2 provider gate**")) {
  throw new Error("Deterministic Anthropic protocol evidence must never be promoted to live-provider certification.");
}
if (!providerMatrix.includes("A deterministic mock/stub result is never a substitute for live-provider evidence.")) {
  throw new Error("Provider matrix must preserve the rule that deterministic fixtures cannot certify a live provider.");
}

const workflowMatrix = await readFile("docs/SUPPORTED-WORKFLOWS.md", "utf8");
for (const workflow of ["W1 · Compare suppliers", "W2 · Extract directory", "W3 · Prepare inquiry form", "W4 · Update one record", "W5 · Collect invoices"]) {
  if (!workflowMatrix.includes(workflow)) throw new Error(`Supported-workflow matrix is missing ${workflow}.`);
}
if (!workflowMatrix.includes("Does **not** submit the form")) throw new Error("W3 support boundary must explicitly say it does not submit the form.");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const permissions = await readFile("docs/PERMISSIONS.md", "utf8");
for (const permission of manifest.permissions || []) {
  if (!permissions.includes(`\`${permission}\``)) throw new Error(`Declared Chrome permission ${permission} is missing from docs/PERMISSIONS.md.`);
}
for (const forbidden of ["cookies", "debugger", "nativeMessaging"]) {
  if (manifest.permissions?.includes(forbidden)) throw new Error(`Unexpected privileged permission at v0.2 readiness baseline: ${forbidden}`);
}

const readme = await readFile("README.md", "utf8");
for (const phrase of ["v0.2 release candidate", "W1", "W2", "W3", "W4", "W5", "docs/RELEASE-EVIDENCE-v0.2.md"]) {
  if (!readme.includes(phrase)) throw new Error(`README is missing release-readiness contract: ${phrase}`);
}
for (const stale of ["first vertical slice is intentionally read-only", "What works in this first build", "This is the **v0.1 feasibility vertical slice**"]) {
  if (readme.includes(stale)) throw new Error(`README still contains stale v0.1 product copy: ${stale}`);
}

console.log("BrowserCrew v0.2 release-readiness inventory checks passed.");
