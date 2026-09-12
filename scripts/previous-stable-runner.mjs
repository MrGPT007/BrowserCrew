import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(repoRoot, "scripts");
const artifactDir = join(repoRoot, "artifacts", "previous-stable-chrome");
const executablePath = String(process.env.BROWSERCREW_BROWSER_EXECUTABLE || "").trim();
const expectedVersion = String(process.env.BROWSERCREW_EXPECT_BROWSER_VERSION || "152.0.7977.75").trim();
const expectedMajor = Number(expectedVersion.split(".")[0]);
const targets = [
  "package-smoke.mjs",
  "browser-smoke.mjs",
  "w1-w3-adversarial-smoke.mjs",
  "w2-w4-w5-adversarial-smoke.mjs",
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
  "workspace-stop-smoke.mjs",
  "watch-me-smoke.mjs"
];
const report = {
  kind: "browsercrew.previous_stable_chrome_receipt",
  startedAt: new Date().toISOString(),
  expectedVersion,
  expectedMajor,
  executablePath,
  targets: [],
  ok: false
};

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  assert.ok(executablePath, "BROWSERCREW_BROWSER_EXECUTABLE is required for previous-stable coverage.");
  const versionResult = await execFileAsync(executablePath, ["--version"], { maxBuffer: 1024 * 1024 });
  const browserVersionText = `${versionResult.stdout || ""}${versionResult.stderr || ""}`.trim();
  const versionMatch = browserVersionText.match(/(\d+\.\d+\.\d+\.\d+)/);
  assert.ok(versionMatch, `Could not parse Chrome version from: ${browserVersionText}`);
  const observedVersion = versionMatch[1];
  const observedMajor = Number(observedVersion.split(".")[0]);
  assert.equal(observedVersion, expectedVersion, `Previous-stable executable must be exactly Chrome ${expectedVersion}.`);
  assert.equal(observedMajor, expectedMajor, `Previous-stable executable must be Chrome major ${expectedMajor}.`);
  report.browserVersionText = browserVersionText;
  report.observedVersion = observedVersion;
  report.observedMajor = observedMajor;

  for (const target of targets) {
    const originalPath = join(scriptsDir, target);
    const runtimePath = join(scriptsDir, `.previous-stable-${target}`);
    const source = await readFile(originalPath, "utf8");
    const launchMarker = 'channel: "chromium",';
    assert.ok(source.includes(launchMarker), `${target} no longer contains the controlled Playwright Chromium launch marker.`);
    const transformed = source.replaceAll(
      launchMarker,
      "executablePath: process.env.BROWSERCREW_BROWSER_EXECUTABLE,"
    );
    assert.notEqual(transformed, source, `${target} did not receive the previous-stable executable override.`);
    await writeFile(runtimePath, transformed);
    const startedAt = new Date().toISOString();
    try {
      const result = await execFileAsync(process.execPath, [runtimePath], {
        cwd: repoRoot,
        env: { ...process.env, BROWSERCREW_BROWSER_EXECUTABLE: executablePath },
        maxBuffer: 20 * 1024 * 1024
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      report.targets.push({ target, ok: true, startedAt, completedAt: new Date().toISOString() });
    } catch (error) {
      if (error?.stdout) process.stdout.write(error.stdout);
      if (error?.stderr) process.stderr.write(error.stderr);
      report.targets.push({
        target,
        ok: false,
        startedAt,
        completedAt: new Date().toISOString(),
        exitCode: error?.code ?? null,
        message: error?.message || String(error)
      });
      throw new Error(`Chrome ${expectedVersion} compatibility failed in ${target}: ${error?.message || error}`);
    } finally {
      await rm(runtimePath, { force: true }).catch(() => {});
    }
  }

  report.ok = true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`BrowserCrew previous-stable Chrome ${expectedVersion} matrix passed (${targets.length} suites).`);
} catch (error) {
  report.ok = false;
  report.completedAt = new Date().toISOString();
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  for (const target of targets) await rm(join(scriptsDir, `.previous-stable-${target}`), { force: true }).catch(() => {});
}
