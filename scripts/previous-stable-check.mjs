import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const targets = [
  "package-smoke.mjs",
  "browser-smoke.mjs",
  "directory-smoke.mjs",
  "record-smoke.mjs",
  "invoice-smoke.mjs",
  "chat-smoke.mjs",
  "connections-smoke.mjs",
  "attachments-smoke.mjs",
  "tools-smoke.mjs",
  "anthropic-smoke.mjs",
  "accessibility-smoke.mjs",
  "mcp-smoke.mjs",
  "c5-smoke.mjs",
  "workspace-stop-smoke.mjs"
];

for (const file of ["scripts/previous-stable-runner.mjs", ".github/workflows/quality.yml", "docs/RELEASE-EVIDENCE-v0.2.md"]) await access(file);
await execFileAsync(process.execPath, ["--check", "scripts/previous-stable-runner.mjs"]);

const runner = await readFile("scripts/previous-stable-runner.mjs", "utf8");
for (const phrase of [
  'BROWSERCREW_BROWSER_EXECUTABLE',
  '152.0.7977.75',
  'browsercrew.previous_stable_chrome_receipt',
  'assert.equal(observedVersion, expectedVersion',
  ...targets
]) if (!runner.includes(phrase)) throw new Error(`Previous-stable runner contract missing: ${phrase}`);

for (const target of targets) {
  const source = await readFile(`scripts/${target}`, "utf8");
  if (!source.includes('channel: "chromium",')) {
    throw new Error(`${target} must retain the controlled Playwright Chromium launch marker so V02-B06 can redirect it to Chrome 152.`);
  }
}

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
for (const phrase of [
  "previous-stable-chrome:",
  "152.0.7977.75",
  "chrome-for-testing-public/152.0.7977.75/linux64/chrome-linux64.zip",
  "BROWSERCREW_BROWSER_EXECUTABLE",
  "BROWSERCREW_EXPECT_BROWSER_VERSION",
  "npm run previous-stable-smoke",
  "previous-stable-chrome-evidence"
]) if (!workflow.includes(phrase)) throw new Error(`Quality workflow previous-stable contract missing: ${phrase}`);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["previous-stable-check"] !== "node scripts/previous-stable-check.mjs") throw new Error("previous-stable-check script must stay wired.");
if (pkg.scripts?.["previous-stable-smoke"] !== "node scripts/previous-stable-runner.mjs") throw new Error("previous-stable-smoke script must stay wired.");
if (!String(pkg.scripts?.check || "").includes("previous-stable-check.mjs")) throw new Error("npm run check must include previous-stable contracts.");

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
for (const phrase of [
  "Browser compatibility | **Passed**",
  "PR #39",
  "c2f84ad2fe2ac15199a2bb878c83a1bae76e95ba",
  "34706114178",
  "92ddd0546caedfdf8bc09b14c6d50e87c0ca432c",
  "34706787383",
  "10302206254",
  "sha256:ffbbceca201a968f030511395c94753c17401448e5f438aced458472fce0a879"
]) if (!evidence.includes(phrase)) throw new Error(`Resolved V02-B06 release evidence missing: ${phrase}`);

console.log("BrowserCrew V02-B06 previous-stable Chrome contracts passed.");