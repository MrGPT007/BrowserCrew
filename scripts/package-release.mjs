import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
const stageDir = join(distDir, ".package-stage");
const zipName = "browsercrew-v0.2-candidate.zip";
const zipPath = join(distDir, zipName);
const verifyZipPath = join(distDir, ".browsercrew-v0.2-candidate-verify.zip");
const fixedTime = new Date("1980-01-01T00:00:00.000Z");

const browsercrewRuntime = ["manifest.json", "sidepanel.html", "src"];
const pdfRuntime = [
  "node_modules/pdfjs-dist/LICENSE",
  "node_modules/pdfjs-dist/package.json",
  "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
];

await rm(distDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

for (const item of browsercrewRuntime) await copyRuntimeItem(item);
for (const item of pdfRuntime) await copyRuntimeItem(item);

const manifest = JSON.parse(await readFile(join(stageDir, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3, "Release package must remain Manifest V3.");
assert.equal(manifest.background?.service_worker, "src/service-worker.js", "Release package must keep the certified service worker entry point.");
assert.equal(manifest.side_panel?.default_path, "sidepanel.html", "Release package must keep the certified side-panel entry point.");
assert.deepEqual(
  [...(manifest.permissions || [])].sort(),
  ["activeTab", "downloads", "scripting", "sidePanel", "storage", "tabs"].sort(),
  "Release package permissions changed from the certified set."
);
assert.deepEqual(
  [...(manifest.optional_host_permissions || [])].sort(),
  ["http://*/*", "https://*/*"].sort(),
  "Release package optional host permission contract changed."
);
assert.equal(Object.prototype.hasOwnProperty.call(manifest, "host_permissions"), false, "Release package must not ship seeded test host permissions.");
const expectedIcons = {
  "16": "src/assets/icons/browsercrew-16.png",
  "32": "src/assets/icons/browsercrew-32.png",
  "48": "src/assets/icons/browsercrew-48.png",
  "128": "src/assets/icons/browsercrew-128.png"
};
assert.deepEqual(manifest.icons, expectedIcons, "Release package must include the reviewed BrowserCrew icon set.");
assert.deepEqual(manifest.action?.default_icon, expectedIcons, "Toolbar action must use the reviewed BrowserCrew icon set.");

let files = await listFiles(stageDir);
files = files.map(toPosix).sort();
assert.ok(files.length > 10, "Release package unexpectedly contains too few runtime files.");
for (const required of [
  "manifest.json",
  "sidepanel.html",
  "src/service-worker.js",
  "src/chat-attachments-ui.js",
  "src/assets/icons/browsercrew-16.png",
  "src/assets/icons/browsercrew-32.png",
  "src/assets/icons/browsercrew-48.png",
  "src/assets/icons/browsercrew-128.png",
  "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
]) assert.ok(files.includes(required), `Release package is missing required runtime file: ${required}`);

for (const path of files) {
  assert.equal(/(^|\/)(tests?|docs?|scripts?|artifacts?|\.git)(\/|$)/i.test(path), false, `Development-only path leaked into release package: ${path}`);
  assert.equal(path.includes("node_modules/playwright"), false, "Playwright must never ship in the extension release package.");
  assert.equal(path.endsWith(".map"), false, `Source map must not ship in the release package: ${path}`);
}

const sidepanel = await readFile(join(stageDir, "sidepanel.html"), "utf8");
for (const ref of [...sidepanel.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])) {
  if (/^(?:https?:|data:|#)/i.test(ref)) continue;
  const clean = ref.replace(/^\.\//, "");
  assert.ok(files.includes(clean), `sidepanel.html references a file not present in the release package: ${clean}`);
}

const sourceTreeSha256 = await hashTree(stageDir, files);
await normalizeTimes(stageDir);
await buildZip(zipPath, files);
await buildZip(verifyZipPath, files);
const zipSha256 = await hashFile(zipPath);
const verifySha256 = await hashFile(verifyZipPath);
assert.equal(zipSha256, verifySha256, "Release ZIP is not deterministic when built twice from the same source tree.");
await rm(verifyZipPath, { force: true });
await execFileAsync("unzip", ["-tqq", zipPath]);

const receipt = {
  schemaVersion: 1,
  kind: "browsercrew.release_package_receipt",
  candidate: zipName,
  manifestVersion: String(manifest.version || ""),
  sourceTreeSha256,
  zipSha256,
  fileCount: files.length,
  files
};
await writeFile(join(distDir, "package-manifest.json"), `${JSON.stringify(receipt, null, 2)}\n`);
await writeFile(join(distDir, `${zipName}.sha256`), `${zipSha256}  ${zipName}\n`);
await rm(stageDir, { recursive: true, force: true });

console.log(`BrowserCrew release package created: ${zipName}`);
console.log(`Runtime files: ${files.length}`);
console.log(`Source tree SHA-256: ${sourceTreeSha256}`);
console.log(`ZIP SHA-256: ${zipSha256}`);

async function copyRuntimeItem(path) {
  const source = join(repoRoot, path);
  const target = join(stageDir, path);
  const info = await stat(source).catch(() => null);
  assert.ok(info, `Required runtime source is missing: ${path}. Run npm ci before packaging.`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: info.isDirectory(), filter: (candidate) => !candidate.endsWith(".map") });
}

async function listFiles(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative(root, full));
      else throw new Error(`Unsupported filesystem entry in release staging: ${relative(root, full)}`);
    }
  }
  await walk(root);
  return found;
}

async function normalizeTimes(root) {
  const paths = [];
  async function walk(dir) {
    paths.push(dir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) paths.push(full);
    }
  }
  await walk(root);
  for (const path of paths.reverse()) await utimes(path, fixedTime, fixedTime);
}

async function hashTree(root, files) {
  const hash = createHash("sha256");
  for (const path of files) {
    const bytes = await readFile(join(root, fromPosix(path)));
    hash.update(path, "utf8");
    hash.update("\0");
    hash.update(createHash("sha256").update(bytes).digest("hex"), "utf8");
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function buildZip(output, files) {
  await rm(output, { force: true });
  await execFileAsync("zip", ["-X", "-q", output, ...files.map(fromPosix)], { cwd: stageDir, maxBuffer: 2 * 1024 * 1024 });
}

function toPosix(path) { return path.split(sep).join("/"); }
function fromPosix(path) { return path.split("/").join(sep); }
