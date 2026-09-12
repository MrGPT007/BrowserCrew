import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
const zipPath = join(distDir, "browsercrew-v0.2-candidate.zip");
const currentReceipt = JSON.parse(await readFile(join(distDir, "package-manifest.json"), "utf8"));
const currentPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-package-rollback-"));
const activeExtensionDir = join(tempRoot, "active-extension");
const previousSourceDir = join(tempRoot, "previous-source");
const userDataDir = join(tempRoot, "profile");
const baselineTar = join(tempRoot, "previous-source.tar");
const stateKey = "browsercrew.rollbackProof.v1";
const stateMarker = `rollback-state-${Date.now()}`;
const timeoutMs = 35_000;
let context;

try {
  const previousSourceCommit = (await execFileAsync("git", ["rev-parse", "HEAD^1"], { cwd: repoRoot })).stdout.trim();
  assert.match(previousSourceCommit, /^[a-f0-9]{40}$/, "Rollback proof could not resolve the previous Git source commit.");

  await execFileAsync("git", [
    "archive", "--format=tar", `--output=${baselineTar}`, previousSourceCommit,
    "manifest.json", "sidepanel.html", "src", "package.json"
  ], { cwd: repoRoot });
  await mkdir(previousSourceDir, { recursive: true });
  await execFileAsync("tar", ["-xf", baselineTar, "-C", previousSourceDir]);

  const previousPackage = JSON.parse(await readFile(join(previousSourceDir, "package.json"), "utf8"));
  assert.equal(
    previousPackage.dependencies?.["pdfjs-dist"],
    currentPackage.dependencies?.["pdfjs-dist"],
    "Previous known-good source expects a different PDF.js runtime; this rollback proof must not silently substitute dependencies."
  );

  await mkdir(activeExtensionDir, { recursive: true });
  await execFileAsync("unzip", ["-q", zipPath, "-d", activeExtensionDir]);
  const first = await launchCandidate(activeExtensionDir, userDataDir);
  context = first.context;
  const currentExtensionId = first.extensionId;
  await first.panel.evaluate(({ stateKey, stateMarker }) => chrome.storage.local.set({ [stateKey]: { marker: stateMarker, createdBy: "package-rollback-smoke" } }), { stateKey, stateMarker });
  const storedBefore = await first.panel.evaluate((stateKey) => chrome.storage.local.get(stateKey), stateKey);
  assert.equal(storedBefore[stateKey]?.marker, stateMarker, "Current candidate could not persist rollback-proof local state.");
  await context.close();
  context = null;

  // A rollback must start from a clean extension directory so files introduced by the bad candidate cannot survive.
  await rm(activeExtensionDir, { recursive: true, force: true });
  await mkdir(activeExtensionDir, { recursive: true });
  await cp(join(previousSourceDir, "manifest.json"), join(activeExtensionDir, "manifest.json"));
  await cp(join(previousSourceDir, "sidepanel.html"), join(activeExtensionDir, "sidepanel.html"));
  await cp(join(previousSourceDir, "src"), join(activeExtensionDir, "src"), { recursive: true });
  await copyPdfRuntime(activeExtensionDir);

  const previousManifest = JSON.parse(await readFile(join(activeExtensionDir, "manifest.json"), "utf8"));
  assert.equal(previousManifest.manifest_version, 3, "Previous known-good rollback source must remain Manifest V3.");
  assert.equal(Object.prototype.hasOwnProperty.call(previousManifest, "host_permissions"), false, "Rollback source unexpectedly contains test-only host permissions.");

  const second = await launchCandidate(activeExtensionDir, userDataDir);
  context = second.context;
  assert.equal(second.extensionId, currentExtensionId, "Clean rollback at the same extension path changed the unpacked extension identity.");
  const storedAfter = await second.panel.evaluate((stateKey) => chrome.storage.local.get(stateKey), stateKey);
  assert.equal(storedAfter[stateKey]?.marker, stateMarker, "Local extension state was lost when rolling back to the previous known-good source at the same extension identity.");
  await second.panel.getByRole("tab", { name: "Workspace" }).waitFor({ state: "visible", timeout: timeoutMs });
  await second.panel.getByRole("tab", { name: "Connect AI" }).waitFor({ state: "visible", timeout: timeoutMs });

  const proof = {
    schemaVersion: 1,
    kind: "browsercrew.release_rollback_proof",
    candidateZipSha256: currentReceipt.zipSha256,
    previousSourceCommit,
    sameExtensionIdentity: true,
    localStatePreserved: true,
    cleanDirectoryReplacement: true,
    previousPdfjsVersion: previousPackage.dependencies?.["pdfjs-dist"] || null
  };
  await writeFile(join(distDir, "rollback-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);

  console.log("BrowserCrew release rollback smoke checks passed.");
  console.log(`✓ Current candidate loaded before rollback: ${currentReceipt.zipSha256}`);
  console.log(`✓ Previous known-good source resolved from merge parent: ${previousSourceCommit}`);
  console.log("✓ Rollback replaced the extension directory cleanly with no candidate overlay");
  console.log("✓ Same extension identity relaunched with local BrowserCrew state preserved");
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function launchCandidate(extensionDir, profileDir) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  assert.equal(await panel.title(), "BrowserCrew");
  return { context, extensionId, panel };
}

async function copyPdfRuntime(targetRoot) {
  for (const relativePath of [
    "node_modules/pdfjs-dist/LICENSE",
    "node_modules/pdfjs-dist/package.json",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
  ]) {
    const source = join(repoRoot, relativePath);
    const target = join(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
}
