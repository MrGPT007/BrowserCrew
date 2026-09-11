import { readFile, access } from "node:fs/promises";

const required = [
  "manifest.json", "sidepanel.html", "src/background.js", "src/sidepanel.js",
  "src/service-worker.js", "src/form-write.js", "src/form-ui.js",
  "src/styles/neobrutal-soft.css", "src/styles/app.css", "docs/PRD.md",
  "docs/ARCHITECTURE.md", "docs/PERMISSIONS.md", "docs/FEASIBILITY.md", "AGENTS.md",
  "tests/fixtures/form.html"
];

for (const file of required) await access(file);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest must stay on MV3.");
if (manifest.background?.service_worker !== "src/service-worker.js") throw new Error("Controlled writes require the modular service-worker wrapper.");
for (const forbidden of ["debugger", "cookies", "nativeMessaging", "downloads"]) {
  if (manifest.permissions?.includes(forbidden)) throw new Error(`Unexpected privileged permission: ${forbidden}`);
}

const background = await readFile("src/background.js", "utf8");
for (const forbidden of ["eval(", "new Function(", "chrome.cookies", "document.cookie"]) {
  if (background.includes(forbidden)) throw new Error(`Forbidden privileged pattern found: ${forbidden}`);
}
for (const contract of ["GET_TOOL_CATALOG", "GET_SKILLS", "SAVE_SKILL", "DELETE_SKILL", "GET_MEMORY_SUMMARY", "CLEAR_MEMORY"]) {
  if (!background.includes(contract)) throw new Error(`Missing workbench contract: ${contract}`);
}

const formWrite = await readFile("src/form-write.js", "utf8");
for (const requiredWriteContract of ["form_write_intent", "form_write_dispatched", "approvedChangeHash", "reconcilePendingWrites", "submitted: false"]) {
  if (!formWrite.includes(requiredWriteContract)) throw new Error(`Missing controlled-write invariant: ${requiredWriteContract}`);
}
for (const forbiddenWritePattern of [".submit(", ".click(", "requestSubmit(", "document.cookie", "chrome.cookies"]) {
  if (formWrite.includes(forbiddenWritePattern)) throw new Error(`Controlled form writer must not contain: ${forbiddenWritePattern}`);
}

const worker = await readFile("src/service-worker.js", "utf8");
if (!worker.includes('import "./form-write.js"') || !worker.includes('import "./background.js"')) throw new Error("Service worker must load both controlled-write and baseline engines.");

const html = await readFile("sidepanel.html", "utf8");
for (const forbiddenCopy of ["Configure settings", "Advanced options", "API endpoint", "Initialize component", "Toggle feature flag"]) {
  if (html.includes(forbiddenCopy)) throw new Error(`Grandma-proof copy violation: ${forbiddenCopy}`);
}
for (const view of ["workspace", "ai", "tools", "skills", "memory", "history", "settings"]) {
  if (!html.includes(`data-view="${view}"`) || !html.includes(`data-view-panel="${view}"`)) throw new Error(`Missing focused workbench view: ${view}`);
}
for (const formUiContract of ['data-job-mode="form"', 'id="formPreviewCard"', "Approve and fill these fields", 'src="src/form-ui.js"']) {
  if (!html.includes(formUiContract)) throw new Error(`Missing controlled form UI: ${formUiContract}`);
}
if (html.includes('data-view="agents"')) throw new Error("Do not expose an Agents tab before the bounded agent runtime exists.");

const panel = await readFile("src/sidepanel.js", "utf8");
if (!panel.includes("renderTools") || !panel.includes("renderSkills") || !panel.includes("renderMemory")) throw new Error("Workbench views must be wired to real data.");

const fixture = await readFile("tests/fixtures/form.html", "utf8");
if (!fixture.includes("__browserCrewFixture") || !fixture.includes("submits: 0") || !fixture.includes("Not submitted")) throw new Error("Form fixture must track submission and begin unsubmitted.");

const soft = await readFile("src/styles/neobrutal-soft.css", "utf8");
if (/translate(?:Y)?\(\s*-/i.test(soft)) throw new Error("NeoBrutal Soft violation: interactive surfaces must compress, never float upward.");
if (!soft.includes("prefers-reduced-motion")) throw new Error("Reduced-motion support is required.");
if (!soft.includes(":focus-visible")) throw new Error("Visible keyboard focus is required.");

console.log("BrowserCrew static quality checks passed.");
