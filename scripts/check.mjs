import { readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const supplierFixtures = ["a", "b", "c", "d", "e"].map((name) => `tests/fixtures/supplier-${name}.html`);
const jsModules = [
  "src/background.js", "src/sidepanel.js", "src/service-worker.js",
  "src/form-write.js", "src/form-ui.js", "src/workspace-ui-core.js", "src/compare-read.js", "src/compare-ui.js",
  "scripts/browser-smoke.mjs"
];
const required = [
  "manifest.json", "sidepanel.html", "package.json", ".github/workflows/quality.yml", ...jsModules,
  "src/styles/neobrutal-soft.css", "src/styles/app.css", "docs/PRD.md",
  "docs/ARCHITECTURE.md", "docs/PERMISSIONS.md", "docs/FEASIBILITY.md", "AGENTS.md",
  "tests/fixtures/form.html", ...supplierFixtures
];

for (const file of required) await access(file);
for (const file of jsModules) await execFileAsync(process.execPath, ["--check", file]);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest must stay on MV3.");
if (manifest.background?.service_worker !== "src/service-worker.js") throw new Error("Controlled writes require the modular service-worker wrapper.");
for (const forbidden of ["debugger", "cookies", "nativeMessaging"]) {
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

const compareRead = await readFile("src/compare-read.js", "utf8");
for (const compareContract of ["MAX_COMPARE_TABS = 5", "page_compare", "verifyCriterionValues", "COMPARE_CANCELLED", "partially_completed", "sourceUrls"]) {
  if (!compareRead.includes(compareContract)) throw new Error(`Missing supplier-compare contract: ${compareContract}`);
}
for (const forbiddenComparePattern of [".submit(", ".click(", "requestSubmit(", "dispatchEvent(", "chrome.cookies", "document.cookie"]) {
  if (compareRead.includes(forbiddenComparePattern)) throw new Error(`Read-only comparison engine must not contain: ${forbiddenComparePattern}`);
}

const worker = await readFile("src/service-worker.js", "utf8");
for (const workerImport of ['import "./form-write.js"', 'import "./compare-read.js"', 'import "./background.js"']) {
  if (!worker.includes(workerImport)) throw new Error(`Service worker is missing module: ${workerImport}`);
}

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

const formUiLoader = await readFile("src/form-ui.js", "utf8");
if (!formUiLoader.includes('import "./directory-ui.js"') || !formUiLoader.includes('import "./workspace-ui-core.js"')) {
  throw new Error("Workspace UI loader must compose the W2 directory UI with the existing workspace controller.");
}

const workspaceUi = await readFile("src/workspace-ui-core.js", "utf8");
if (!workspaceUi.includes('import "./compare-ui.js"') || !workspaceUi.includes('mode === "compare"')) throw new Error("Workspace job-mode controller must include comparison mode.");

const compareUi = await readFile("src/compare-ui.js", "utf8");
for (const compareUiContract of ['data-job-mode="compare"', "Choose the pages to compare", "Compare selected pages", "compare-table", "Stop comparison"]) {
  if (!compareUi.includes(compareUiContract)) throw new Error(`Missing supplier comparison UI: ${compareUiContract}`);
}

const fixture = await readFile("tests/fixtures/form.html", "utf8");
if (!fixture.includes("__browserCrewFixture") || !fixture.includes("submits: 0") || !fixture.includes("Not submitted")) throw new Error("Form fixture must track submission and begin unsubmitted.");

const supplierPages = await Promise.all(supplierFixtures.map((file) => readFile(file, "utf8")));
if (supplierPages.length !== 5) throw new Error("W1 requires five controlled supplier fixtures.");
if (!supplierPages.some((page) => !page.includes("<dt>Shipping</dt>"))) throw new Error("Supplier fixtures must include at least one intentionally missing criterion.");
if (!supplierPages.some((page) => !page.includes("<dt>Lead time</dt>"))) throw new Error("Supplier fixtures must exercise missing-value reporting.");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (packageJson.scripts?.["browser-smoke"] !== "node scripts/browser-smoke.mjs") throw new Error("Browser smoke script must stay wired in package.json.");
if (packageJson.devDependencies?.playwright !== "1.63.0") throw new Error("Playwright must stay exactly pinned for reproducible extension smoke coverage.");

const browserSmoke = await readFile("scripts/browser-smoke.mjs", "utf8");
for (const smokeContract of ["launchPersistentContext", "W1 compared five controlled supplier pages", "W3 previewed and filled approved fields", "Target.closeTarget", "Recovery must inspect the uncertain write instead of replaying it", "submits, 0"]) {
  if (!browserSmoke.includes(smokeContract)) throw new Error(`Missing browser-smoke proof: ${smokeContract}`);
}

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const workflowContract of ["browser-smoke:", "playwright install --with-deps chromium", "npm run browser-smoke", "browser-smoke-evidence"]) {
  if (!workflow.includes(workflowContract)) throw new Error(`Quality workflow is missing browser coverage: ${workflowContract}`);
}

const soft = await readFile("src/styles/neobrutal-soft.css", "utf8");
if (/translate(?:Y)?\(\s*-/i.test(soft)) throw new Error("NeoBrutal Soft violation: interactive surfaces must compress, never float upward.");
if (!soft.includes("prefers-reduced-motion")) throw new Error("Reduced-motion support is required.");
if (!soft.includes(":focus-visible")) throw new Error("Visible keyboard focus is required.");

console.log("BrowserCrew static quality checks passed.");
