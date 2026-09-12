import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
await access("scripts/privacy-smoke.mjs");
await execFileAsync(process.execPath, ["--check", "scripts/privacy-smoke.mjs"]);

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

const background = await readFile("src/background.js", "utf8");
if (!background.includes("input[type='password']")) throw new Error("Selected-page observation must exclude password inputs before building model context.");

const formWrite = await readFile("src/form-write.js", "utf8");
if (!formWrite.includes('new Set(["text", "email", "tel", "url", "search", "number"])')) {
  throw new Error("Form observation must keep an explicit safe input-type allowlist that excludes password fields.");
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["privacy-smoke"] !== "node scripts/privacy-smoke.mjs") throw new Error("Privacy browser smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("privacy-check.mjs")) throw new Error("npm run check must include privacy gate contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm run privacy-smoke")) throw new Error("Quality CI must execute seeded privacy browser coverage.");

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
if (!evidence.includes("| Privacy | **Partial**")) throw new Error("Release evidence must record the new privacy proof as partial, not complete.");
if (!evidence.includes("V02-B02")) throw new Error("V02-B02 must remain open until export/error/privacy sink coverage is complete.");
if (!evidence.includes("provider-error echo")) throw new Error("Release evidence must name provider-error echo redaction as remaining privacy work.");

console.log("BrowserCrew v0.2 privacy gate contract checks passed.");
