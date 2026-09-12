import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
const zipPath = join(distDir, "browsercrew-v0.2-candidate.zip");
const receiptPath = join(distDir, "package-manifest.json");
const timeoutMs = 35_000;
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-release-package-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;

try {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.kind, "browsercrew.release_package_receipt");
  assert.equal(receipt.candidate, "browsercrew-v0.2-candidate.zip");
  assert.match(receipt.zipSha256 || "", /^[a-f0-9]{64}$/);
  assert.match(receipt.sourceTreeSha256 || "", /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(receipt.files) && receipt.files.length === receipt.fileCount);

  await execFileAsync("unzip", ["-q", zipPath, "-d", extensionDir]);
  const extracted = (await listFiles(extensionDir)).map(toPosix).sort();
  assert.deepEqual(extracted, [...receipt.files].sort(), "Extracted release package file list differs from the signed package receipt.");
  assert.equal(extracted.some((path) => path.startsWith("tests/") || path.startsWith("docs/") || path.startsWith("scripts/") || path.startsWith("artifacts/") || path.startsWith(".git/")), false);
  assert.equal(extracted.some((path) => path.startsWith("node_modules/playwright")), false, "Development Playwright files leaked into the candidate ZIP.");
  assert.equal(extracted.some((path) => path.endsWith(".map")), false, "Source maps leaked into the candidate ZIP.");

  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "host_permissions"), false, "Release artifact contains test-only host permissions.");

  context = await chromium.launchPersistentContext(userDataDir, {
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
  await panel.getByRole("tab", { name: "Workspace" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("tab", { name: "Connect AI" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("tab", { name: "Tools" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("tab", { name: "Skills" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("tab", { name: "Memory" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("tab", { name: "History" }).waitFor({ state: "visible", timeout: timeoutMs });
  await panel.getByRole("tab", { name: "Settings" }).waitFor({ state: "visible", timeout: timeoutMs });

  const pdfMarker = "PACKAGE_PDF_RUNTIME_OK_91c2";
  const pdfBase64 = buildSimplePdf(`BrowserCrew packaged PDF ${pdfMarker}`).toString("base64");
  const parsedPdf = await panel.evaluate(async ({ pdfBase64, pdfMarker }) => {
    const pdfjs = await import(chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
    const binary = atob(pdfBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent({ disableNormalization: false });
    const text = (content.items || []).map((item) => typeof item?.str === "string" ? item.str : "").join(" ");
    const pages = pdf.numPages;
    await loadingTask.destroy().catch(() => {});
    return { pages, text, matched: text.includes(pdfMarker) };
  }, { pdfBase64, pdfMarker });
  assert.equal(parsedPdf.pages, 1);
  assert.equal(parsedPdf.matched, true, "Packaged PDF.js runtime could not parse text from a supported PDF attachment.");

  console.log("BrowserCrew release package installed-extension smoke checks passed.");
  console.log("✓ Candidate ZIP extracted to exactly the packaged file receipt");
  console.log("✓ Candidate ZIP excluded tests, docs, scripts, artifacts, Playwright, source maps, and test-only host permissions");
  console.log("✓ Extracted candidate loaded as an installed Manifest V3 extension");
  console.log("✓ Packaged PDF.js runtime parsed a supported PDF attachment inside the extension origin");
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function listFiles(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative(root, full));
    }
  }
  await walk(root);
  return found;
}

function toPosix(path) { return path.split(sep).join("/"); }

function buildSimplePdf(text) {
  const escaped = String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}
