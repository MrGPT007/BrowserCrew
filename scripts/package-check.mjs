import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
for (const file of ["package-lock.json", "scripts/package-release.mjs", "scripts/package-smoke.mjs", "scripts/package-rollback-smoke.mjs"]) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "scripts/package-release.mjs"]),
  execFileAsync(process.execPath, ["--check", "scripts/package-smoke.mjs"]),
  execFileAsync(process.execPath, ["--check", "scripts/package-rollback-smoke.mjs"])
]);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (lock.lockfileVersion !== 3) throw new Error("package-lock.json must use npm lockfileVersion 3.");
const root = lock.packages?.[""];
if (!root) throw new Error("package-lock.json is missing the root package entry.");
if (root.dependencies?.["pdfjs-dist"] !== pkg.dependencies?.["pdfjs-dist"]) throw new Error("Locked PDF.js version must exactly match package.json.");
if (root.devDependencies?.playwright !== pkg.devDependencies?.playwright) throw new Error("Locked Playwright version must exactly match package.json.");

const expected = {
  "node_modules/pdfjs-dist": {
    version: "6.3.289",
    resolved: "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz",
    integrity: "sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw=="
  },
  "node_modules/playwright": {
    version: "1.63.0",
    resolved: "https://registry.npmjs.org/playwright/-/playwright-1.63.0.tgz",
    integrity: "sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg=="
  },
  "node_modules/playwright-core": {
    version: "1.63.0",
    resolved: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz",
    integrity: "sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg=="
  }
};
for (const [path, contract] of Object.entries(expected)) {
  const entry = lock.packages?.[path];
  if (!entry) throw new Error(`package-lock.json is missing ${path}.`);
  for (const [key, value] of Object.entries(contract)) {
    if (entry[key] !== value) throw new Error(`${path} ${key} is not pinned to the certified value.`);
  }
}
if (lock.packages?.["node_modules/playwright"]?.dependencies?.["playwright-core"] !== "1.63.0") throw new Error("Playwright must lock its exact matching playwright-core version.");

const releaseScript = await readFile("scripts/package-release.mjs", "utf8");
for (const contract of [
  'const zipName = "browsercrew-v0.2-candidate.zip"',
  '"node_modules/pdfjs-dist/legacy/build/pdf.mjs"',
  '"node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"',
  'path.includes("node_modules/playwright")',
  'path.endsWith(".map")',
  'Object.prototype.hasOwnProperty.call(manifest, "host_permissions")',
  'assert.equal(zipSha256, verifySha256',
  'execFileAsync("unzip", ["-tqq", zipPath])',
  'kind: "browsercrew.release_package_receipt"'
]) {
  if (!releaseScript.includes(contract)) throw new Error(`Release packager is missing contract: ${contract}`);
}

const smoke = await readFile("scripts/package-smoke.mjs", "utf8");
for (const contract of [
  'execFileAsync("unzip", ["-q", zipPath, "-d", extensionDir])',
  'chromium.launchPersistentContext',
  'chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.mjs")',
  'chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")',
  'Object.prototype.hasOwnProperty.call(manifest, "host_permissions")'
]) {
  if (!smoke.includes(contract)) throw new Error(`Release package browser smoke is missing contract: ${contract}`);
}

const rollbackSmoke = await readFile("scripts/package-rollback-smoke.mjs", "utf8");
for (const contract of [
  'execFileAsync("git", ["rev-parse", "HEAD^1"]',
  '"archive", "--format=tar"',
  'await rm(activeExtensionDir, { recursive: true, force: true })',
  'assert.equal(second.extensionId, currentExtensionId',
  'localStatePreserved: true',
  'cleanDirectoryReplacement: true',
  'kind: "browsercrew.release_rollback_proof"'
]) {
  if (!rollbackSmoke.includes(contract)) throw new Error(`Release rollback smoke is missing contract: ${contract}`);
}

if (pkg.scripts?.["package-check"] !== "node scripts/package-check.mjs") throw new Error("package-check must stay wired in package.json.");
if (pkg.scripts?.["package-release"] !== "node scripts/package-release.mjs") throw new Error("package-release must stay wired in package.json.");
if (pkg.scripts?.["package-smoke"] !== "node scripts/package-smoke.mjs") throw new Error("package-smoke must stay wired in package.json.");
if (pkg.scripts?.["package-rollback-smoke"] !== "node scripts/package-rollback-smoke.mjs") throw new Error("package-rollback-smoke must stay wired in package.json.");
if (!String(pkg.scripts?.check || "").includes("package-check.mjs")) throw new Error("npm run check must include package-integrity contracts.");

const workflow = await readFile(".github/workflows/quality.yml", "utf8");
if (!workflow.includes("npm ci --ignore-scripts")) throw new Error("Browser CI must install from the committed dependency lock with npm ci.");
if (!workflow.includes("fetch-depth: 2")) throw new Error("Browser CI must fetch the previous known-good parent for executable rollback proof.");
if (!workflow.includes("npm run package-release")) throw new Error("Quality CI must build the release package candidate.");
if (!workflow.includes("npm run package-smoke")) throw new Error("Quality CI must load and exercise the built release package candidate.");
if (!workflow.includes("npm run package-rollback-smoke")) throw new Error("Quality CI must prove clean rollback to the previous known-good source.");
if (!workflow.includes("path: artifacts")) throw new Error("Existing browser evidence upload must remain intact.");
if (!workflow.includes("path: dist")) throw new Error("Quality CI must upload package receipts and the candidate artifact.");

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
if (!evidence.includes("| Package integrity | **Partial**")) throw new Error("Package integrity must remain Partial until exact-head package and rollback evidence is green.");
if (!evidence.includes("V02-B07")) throw new Error("V02-B07 must remain tracked until exact-head package/rollback proof is green and the release ledger is reconciled.");

console.log("BrowserCrew v0.2 package-integrity contract checks passed.");
