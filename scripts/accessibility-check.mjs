import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["src/accessibility-ui.js", "scripts/accessibility-smoke.mjs", "docs/ACCESSIBILITY-AUDIT-v0.2.md"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "src/accessibility-ui.js"]),
  execFileAsync(process.execPath, ["--check", "scripts/accessibility-smoke.mjs"])
]);

const loader = await readFile("src/form-ui.js", "utf8");
if (!loader.includes('import "./accessibility-ui.js";')) throw new Error("Side-panel composition must load the shared accessibility layer after feature UIs.");

const a11y = await readFile("src/accessibility-ui.js", "utf8");
for (const contract of [
  'role", "status"',
  'aria-live", "polite"',
  'aria-atomic", "true"',
  'role", "combobox"',
  'aria-activedescendant',
  '[role="radiogroup"]',
  '[role="radio"]',
  'ArrowRight',
  'ArrowDown',
  'Home',
  'End',
  '[role="dialog"][aria-modal="true"]',
  'trapModalTab(event, dialog)',
  'event.key === "Escape"',
  'app.inert = visible.size > 0',
  'returnTarget.focus()'
]) if (!a11y.includes(contract)) throw new Error(`Accessibility interaction contract missing: ${contract}`);

const html = await readFile("sidepanel.html", "utf8");
for (const semantic of [
  'role="tablist"',
  'role="tabpanel"',
  'role="radiogroup"',
  'aria-live="polite"',
  'aria-label="Ready status"'
]) if (!html.includes(semantic)) throw new Error(`Base side-panel semantics missing: ${semantic}`);

const soft = await readFile("src/styles/neobrutal-soft.css", "utf8");
if (!soft.includes(":focus-visible")) throw new Error("Visible keyboard focus must remain a design-system invariant.");
if (!soft.includes("prefers-reduced-motion: reduce")) throw new Error("Reduced-motion support must remain a design-system invariant.");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["accessibility-check"] !== "node scripts/accessibility-check.mjs") throw new Error("accessibility-check must stay wired in package.json.");
if (pkg.scripts?.["accessibility-smoke"] !== "node scripts/accessibility-smoke.mjs") throw new Error("accessibility-smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("accessibility-check.mjs")) throw new Error("npm run check must include v0.2 accessibility contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run accessibility-smoke")) throw new Error("Quality CI must execute installed-extension accessibility coverage.");
if (!workflow.includes("browser-smoke-evidence")) throw new Error("Accessibility evidence must remain inside the mandatory browser evidence artifact.");

const audit = await readFile("docs/ACCESSIBILITY-AUDIT-v0.2.md", "utf8");
for (const phrase of [
  "Automated engineering audit",
  "Human assistive-technology signoff: **OUTSTANDING**",
  "NVDA",
  "VoiceOver",
  "keyboard",
  "200%",
  "NOT a substitute for manual screen-reader review"
]) if (!audit.includes(phrase)) throw new Error(`Accessibility audit boundary/checklist missing: ${phrase}`);

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
if (!evidence.includes("| Accessibility | **Blocked**")) throw new Error("Accessibility release gate must remain blocked until manual assistive-technology signoff is recorded.");
if (!evidence.includes("V02-B05")) throw new Error("Release evidence must retain V02-B05 blocker identity.");

console.log("BrowserCrew v0.2 accessibility engineering contract checks passed.");