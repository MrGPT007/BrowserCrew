import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-review-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-review-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.schedule_review_smoke", startedAt: new Date().toISOString(), checks: [] };

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);
  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false, "Post-v0.2 review proof must not widen the v0.2 manifest with alarms.");
  pass("Feature branch keeps the active v0.2 manifest free of the alarms permission");

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  const receipts = [missedReceipt("run-review"), missedReceipt("skip-review")];
  await worker.evaluate(async (seed) => {
    await chrome.storage.local.set({ "browsercrew.scheduleRuns.v1": seed });
  }, receipts);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.locator("#scheduleReviewList [data-review-missed]").first().waitFor({ state: "visible", timeout: timeoutMs });

  assert.match(await panel.locator("#scheduleCapabilityStatus").innerText(), /Scheduling is not active in this build/i);
  assert.equal(await panel.locator("#scheduleSetupButton").isDisabled(), true);
  assert.equal(await panel.locator("#scheduleReviewCount").innerText(), "2");
  pass("Skills UI exposes pending missed-job choices while schedule creation remains locked");

  panel.once("dialog", (dialog) => dialog.accept());
  await panel.locator('[data-review-missed="run-review"][data-review-decision="run_once"]').click();
  await waitUntil(async () => /not enabled in this BrowserCrew build yet/i.test(await panel.locator("#toast").innerText()), "Run-once should fail closed before scheduler activation.");
  let stored = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.scheduleRuns.v1"))["browsercrew.scheduleRuns.v1"]);
  let runReview = stored.find((item) => item.id === "run-review");
  assert.equal(runReview.status, "needs_review");
  assert.equal(runReview.reason, "SCHEDULE_DISPATCH_REQUIRED");
  assert.equal(runReview.reviewDecision, "run_once");
  assert.ok(runReview.reviewedAt);
  pass("Run this missed job once remains pending and dispatches nothing before scheduler boot");

  await panel.locator('[data-review-missed="skip-review"][data-review-decision="skip"]').click();
  await waitUntil(async () => /Missed job skipped/i.test(await panel.locator("#toast").innerText()), "Skip should settle the missed receipt.");
  stored = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.scheduleRuns.v1"))["browsercrew.scheduleRuns.v1"]);
  const skipped = stored.find((item) => item.id === "skip-review");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "SCHEDULE_MISSED_USER_SKIPPED");
  assert.equal(skipped.reviewDecision, "skip");
  assert.ok(skipped.reviewedAt);
  await waitUntil(async () => (await panel.locator("#scheduleReviewCount").innerText()) === "1", "One pending missed job should remain after Skip.");
  pass("Skip this missed job records a durable terminal no-dispatch decision");

  await panel.locator('[data-review-missed="run-review"][data-review-decision="skip"]').click();
  await waitUntil(async () => (await panel.locator("#scheduleReviewCount").innerText()) === "0", "All missed jobs should be settled after the second Skip.");
  stored = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.scheduleRuns.v1"))["browsercrew.scheduleRuns.v1"]);
  runReview = stored.find((item) => item.id === "run-review");
  assert.equal(runReview.status, "skipped");
  assert.equal(runReview.reason, "SCHEDULE_MISSED_USER_SKIPPED");
  assert.equal(runReview.reviewDecision, "skip");
  pass("A fail-closed run-once choice can still be safely resolved as Skip later");

  await panel.screenshot({ path: join(artifactDir, "schedule-review.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew missed schedule review installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function missedReceipt(id) {
  return {
    id,
    schemaVersion: 1,
    scheduleId: "daily-review",
    skillRef: { id: "scheduled-review-skill", version: "1.0.0" },
    scheduledFor: "2026-09-12T03:00:00.000Z",
    firedAt: "2026-09-12T03:10:00.000Z",
    latenessMs: 600_000,
    missed: true,
    missedAction: "ask",
    status: "needs_review",
    reason: "SCHEDULE_MISSED_REVIEW_REQUIRED",
    reviewRequestedAt: "2026-09-12T03:10:00.000Z",
    taskId: null
  };
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareExtension(target) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
    }
  });
}

async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
