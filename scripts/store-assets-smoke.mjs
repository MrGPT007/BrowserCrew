import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "store-media");
const reportPath = join(artifactDir, "report.json");
const promoPath = join(artifactDir, "browsercrew-small-promo-440x280.png");

const icons = [
  { id: "icon_16_png", source: "src/assets/icons/browsercrew-16.png", width: 16, height: 16, sha256: "4091914f5ca6693ae6522e46872e5187642513d4cb8e6afa520143d797e75d2f" },
  { id: "icon_32_png", source: "src/assets/icons/browsercrew-32.png", width: 32, height: 32, sha256: "5352f3c4ab52f982a5f71e8effaa229f90ec7605262cdd7bd668b31a5fba623f" },
  { id: "icon_48_png", source: "src/assets/icons/browsercrew-48.png", width: 48, height: 48, sha256: "e94df3809d38db20bec7e5cd9c54c247b1fab359ba01bf419f10a2556112a07a" },
  { id: "icon_128_png", source: "src/assets/icons/browsercrew-128.png", width: 128, height: 128, sha256: "7d707768a259207a1a5963c8cf351f297ccef482153f50d14fd05abf0682ce09" }
];

const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.kind, "browsercrew.store_media_evidence", "Store asset proof must extend the exact-candidate store-media receipt.");
assert.equal(report.ok, true, "Store asset proof requires the installed-extension screenshot proof to pass first.");
assert.match(String(report.candidateSha || ""), /^[a-f0-9]{40}$/i, "Store asset evidence must retain an exact candidate SHA.");

for (const icon of icons) {
  const sourcePath = join(repoRoot, icon.source);
  const dimensions = await pngDimensions(sourcePath);
  assert.deepEqual(dimensions, { width: icon.width, height: icon.height }, `${icon.id} has the wrong PNG dimensions.`);
  const digest = await sha256(sourcePath);
  assert.equal(digest, icon.sha256, `${icon.id} bytes changed without store-media review.`);
  const fileInfo = await stat(sourcePath);
  assert.ok(fileInfo.size > 100, `${icon.id} is unexpectedly empty.`);
  report.checks.push({
    name: `Verified reviewed BrowserCrew icon ${icon.width}x${icon.height}`,
    details: { source: icon.source, width: icon.width, height: icon.height, bytes: fileInfo.size, sha256: digest },
    at: new Date().toISOString()
  });
}
await copyFile(join(repoRoot, "src/assets/icons/browsercrew-128.png"), join(artifactDir, "browsercrew-icon-128.png"));

const browser = await chromium.launch({ channel: "chromium", headless: true });
let context;
try {
  context = await browser.newContext();
  const iconPage = await context.newPage();
  const iconBytes = await readFile(join(repoRoot, "src/assets/icons/browsercrew-128.png"));
  const alphaBounds = await iconPage.evaluate(async (src) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const alpha = pixels[(y * image.width + x) * 4 + 3];
        if (alpha === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    return {
      left,
      top,
      rightExclusive: right + 1,
      bottomExclusive: bottom + 1,
      width: right - left + 1,
      height: bottom - top + 1
    };
  }, `data:image/png;base64,${iconBytes.toString("base64")}`);
  assert.deepEqual(
    alphaBounds,
    { left: 16, top: 16, rightExclusive: 112, bottomExclusive: 112, width: 96, height: 96 },
    "Chrome Web Store 128x128 icon must keep 96x96 visible artwork centered with 16px transparent padding on every side."
  );
  report.checks.push({
    name: "Verified Chrome Web Store 128x128 icon transparent padding",
    details: { ...alphaBounds, paddingPx: 16 },
    at: new Date().toISOString()
  });
  await context.close();

  context = await browser.newContext({ viewport: { width: 440, height: 280 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:440px;height:280px;overflow:hidden;background:#f6f2ea;color:#171717;font-family:Arial,Helvetica,sans-serif}.tile{position:relative;width:440px;height:280px;padding:18px}.corner-a{position:absolute;left:0;top:0;width:94px;height:68px;background:#c9b7ff}.corner-b{position:absolute;right:0;bottom:0;width:104px;height:72px;background:#9be3bd}.card{position:relative;width:404px;height:244px;background:#fffdf8;border:3px solid #171717;border-radius:18px;box-shadow:7px 7px 0 #171717;padding:23px 22px}.row{display:flex;align-items:center;gap:22px}.mark{width:88px;height:88px;display:grid;place-items:center;flex:0 0 auto;background:#86b6ff;border:3px solid #171717;border-radius:14px;box-shadow:4px 4px 0 #171717;font-size:56px;line-height:1;font-weight:900}.copy{min-width:0}.copy h1{margin:0;font-size:34px;line-height:.98;letter-spacing:-1.3px}.copy p{margin:9px 0 0;font-size:15px;font-weight:700;color:#5f5b55}.pills{display:flex;gap:7px;flex-wrap:wrap;margin-top:24px}.pill{border:2px solid #171717;border-radius:999px;padding:6px 10px;font-size:11px;line-height:1;font-weight:900;background:#eee9df}.pill.ai{background:#f4dc78}.pill.page{background:#c9b7ff}.pill.safe{background:#9be3bd}.version{position:absolute;right:22px;bottom:18px;font-size:10px;font-weight:900;color:#5f5b55}
</style></head><body><main class="tile" aria-label="BrowserCrew promotional tile"><div class="corner-a"></div><div class="corner-b"></div><section class="card"><div class="row"><div class="mark">B</div><div class="copy"><h1>BrowserCrew</h1><p>Your browser workbench</p></div></div><div class="pills"><span class="pill ai">Choose your AI</span><span class="pill page">Choose the page</span><span class="pill safe">Stay in control</span></div><span class="version">v0.2</span></section></main></body></html>`);
  assert.equal(await page.getByRole("heading", { name: "BrowserCrew" }).innerText(), "BrowserCrew");
  assert.equal(await page.getByText("Your browser workbench").innerText(), "Your browser workbench");
  await page.screenshot({ path: promoPath, type: "png", fullPage: false });
} finally {
  if (context) await context.close().catch(() => {});
  await browser.close();
}
const promoDimensions = await pngDimensions(promoPath);
assert.deepEqual(promoDimensions, { width: 440, height: 280 }, "Chrome Web Store small promotional tile must be exactly 440x280.");
const promoInfo = await stat(promoPath);
assert.ok(promoInfo.size > 5_000, "Promotional tile must contain a non-trivial rendered design.");
const promoSha256 = await sha256(promoPath);
report.checks.push({
  name: "Generated reviewed BrowserCrew 440x280 small promotional tile",
  details: { file: "browsercrew-small-promo-440x280.png", width: 440, height: 280, bytes: promoInfo.size, sha256: promoSha256 },
  at: new Date().toISOString()
});

report.media = [
  ...(Array.isArray(report.media) ? report.media : []),
  {
    id: "icon_128_png",
    file: "browsercrew-icon-128.png",
    mimeType: "image/png",
    width: 128,
    height: 128,
    sha256: icons.find((icon) => icon.id === "icon_128_png").sha256,
    source: "reviewed_browsercrew_manifest_icon"
  },
  {
    id: "small_promo_440x280",
    file: "browsercrew-small-promo-440x280.png",
    mimeType: "image/png",
    width: 440,
    height: 280,
    sha256: promoSha256,
    source: "exact_candidate_browsercrew_brand_render"
  }
];
report.completedAt = new Date().toISOString();
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log("BrowserCrew reviewed Chrome Web Store icon and promotional tile checks passed.");

async function pngDimensions(path) {
  const buffer = await readFile(path);
  assert.ok(buffer.length >= 24, `${path} is too short to be a PNG.`);
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} must be a PNG.`);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR", `${path} must begin with an IHDR chunk.`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
