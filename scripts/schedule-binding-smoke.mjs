import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-setup-smoke", "binding");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-binding-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.schedule_binding_smoke", startedAt: new Date().toISOString(), checks: [] };

const reviewedAt = "2026-09-13T05:00:00.000Z";
const skill = {
  schemaVersion: 1,
  id: "binding-review-skill",
  version: "1.4.0",
  status: "approved",
  title: "Review supplier dashboard",
  description: "Read the reviewed supplier dashboard and verify the ready state.",
  inputs: {},
  allowedOrigins: ["https://example.test"],
  allowedResources: ["catalog:suppliers"],
  actionClasses: ["read"],
  dataDestinations: [],
  providerRequirements: { capabilities: [] },
  budgets: { maxSteps: 7, maxMinutes: 6 },
  steps: [{ id: "verify-ready", kind: "verify", purpose: "Verify dashboard readiness.", origin: "https://example.test", expect: { visibleText: "Ready" } }],
  completionCriteria: [{ claim: "Dashboard is ready.", verification: "Visible text says Ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt: reviewedAt },
  approval: { approvedAt: reviewedAt, approvedBy: "user" },
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  createdAt: reviewedAt,
  updatedAt: reviewedAt,
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
};
const connection = {
  id: "binding-local-ai",
  schemaVersion: 1,
  name: "Binding review AI",
  kind: "openai-compatible",
  model: "binding-test-model",
  baseUrl: "http://127.0.0.1:1234/v1",
  status: "connected",
  lastTestedAt: reviewedAt,
  createdAt: reviewedAt,
  updatedAt: reviewedAt
};
const schedule = {
  schemaVersion: 1,
  id: "binding-review-daily",
  name: "Supplier binding review",
  enabled: false,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 9, minute: 15 },
  missedRunPolicy: "ask",
  concurrencyPolicy: "skip_if_running",
  providerRef: connection.id,
  grantRefs: [],
  budgets: { maxSteps: 7, maxMinutes: 6 },
  createdAt: reviewedAt,
  updatedAt: reviewedAt,
  nextRunAt: null
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);
  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false, "Prepared binding proof must not add alarms permission.");
  pass("Prepared binding proof keeps production scheduling permission locked");

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1200 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  await worker.evaluate(async ({ skillSeed, connectionSeed, scheduleSeed }) => {
    await chrome.storage.local.set({
      "browsercrew.skillLibrary.v1": [skillSeed],
      "browsercrew.connections.v1": [connectionSeed],
      "browsercrew.activeConnection.v1": connectionSeed.id,
      "browsercrew.schedules.v1": [scheduleSeed],
      "browsercrew.scheduleRuns.v1": []
    });
  }, { skillSeed: skill, connectionSeed: connection, scheduleSeed: schedule });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  const card = panel.locator(`[data-prepared-schedule="${schedule.id}"]`);
  await card.waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => /Starting page:\s*Not ready for future activation/i.test(await card.innerText()), "Legacy prepared schedule should visibly require starting-page review.");
  let text = await card.innerText();
  assert.match(text, /No permission grant exists\. Reviewing this page cannot run the schedule\./);
  assert.match(text, /Do not include query parameters/i);
  pass("Legacy prepared schedule stays readable but visibly non-activation-ready");

  const input = card.locator(`[data-schedule-start-url="${schedule.id}"]`);
  const save = card.locator(`[data-save-schedule-binding="${schedule.id}"]`);
  await input.fill("https://example.test/suppliers?account=private");
  await save.click();
  await waitUntil(async () => /without query parameters/i.test(await panel.locator("#toast").innerText()), "Private query parameters should be rejected.");
  assert.equal((await storedSchedule(worker)).startResource, undefined, "Rejected private URL must not create a binding.");

  await input.fill("https://other.test/suppliers");
  await save.click();
  await waitUntil(async () => /reviewed websites/i.test(await panel.locator("#toast").innerText()), "Out-of-scope origin should be rejected.");
  assert.equal((await storedSchedule(worker)).startResource, undefined, "Rejected out-of-scope URL must not create a binding.");
  pass("Starting-page review rejects private/session URL data and out-of-scope websites");

  await input.fill("https://example.test/suppliers");
  await save.click();
  await waitUntil(async () => /schedule is still off and no permission grant was created/i.test(await panel.locator("#toast").innerText()), "Canonical starting page should save as prepared-only review.");
  let stored = await storedSchedule(worker);
  assert.equal(stored.enabled, false);
  assert.deepEqual(stored.grantRefs, []);
  assert.equal(stored.startResource.kind, "exact_url");
  assert.equal(stored.startResource.url, "https://example.test/suppliers");
  assert.equal(stored.startResource.origin, "https://example.test");
  assert.deepEqual(stored.startResource.expectedResources, ["catalog:suppliers"]);
  assert.equal(Object.prototype.hasOwnProperty.call(stored.startResource, "tabId"), false, "Prepared binding must not persist a transient Chrome tab id.");
  assert.equal(stored.authorityPlan.status, "prepared_only");
  assert.deepEqual(stored.authorityPlan.skillRef, { id: skill.id, version: skill.version });
  assert.deepEqual(stored.authorityPlan.origins, skill.allowedOrigins);
  assert.deepEqual(stored.authorityPlan.resources, skill.allowedResources);
  assert.deepEqual(stored.authorityPlan.actionClasses, skill.actionClasses);
  assert.deepEqual(stored.authorityPlan.providerCapabilities, []);
  assert.deepEqual(stored.authorityPlan.dataDestinations, []);
  assert.equal(stored.authorityPlan.reviewedAt, stored.startResource.reviewedAt);
  for (const forbidden of ["scope", "expiresAt", "revoked", "active", "token", "secret", "grantId", "id"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(stored.authorityPlan, forbidden), false, `Prepared authority plan must not contain executable grant field ${forbidden}.`);
  }
  await waitUntil(async () => /Prepared-only requirements — this is not permission to run\./i.test(await card.innerText()), "Bound prepared schedule should surface inert authority status.");
  text = await card.innerText();
  assert.match(text, /Starting page:\s*https:\/\/example\.test\/suppliers/);
  assert.match(text, /no executable grant/i);
  pass("Canonical starting page persists exact non-secret resource metadata and an inert permission plan only");

  const bindingBeforeEdit = structuredClone({ startResource: stored.startResource, authorityPlan: stored.authorityPlan });
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.locator("#scheduleName").fill("Supplier binding review updated");
  await panel.locator("#scheduleSaveDraft").click();
  await waitUntil(async () => /Prepared schedule saved/i.test(await panel.locator("#toast").innerText()), "Ordinary prepared schedule edit should save.");
  stored = await storedSchedule(worker);
  assert.equal(stored.name, "Supplier binding review updated");
  assert.deepEqual(stored.startResource, bindingBeforeEdit.startResource, "Ordinary Edit must preserve the exact reviewed starting-page binding.");
  assert.deepEqual(stored.authorityPlan, bindingBeforeEdit.authorityPlan, "Ordinary Edit must preserve the inert reviewed permission plan.");
  assert.deepEqual(stored.grantRefs, [], "Ordinary Edit must not manufacture a schedule grant.");
  pass("Ordinary prepared-schedule edits preserve reviewed binding without creating authority");

  const updatedCard = panel.locator(`[data-prepared-schedule="${schedule.id}"]`);
  assert.equal(await panel.locator('#schedulesPreviewCard [data-enable-schedule], #schedulesPreviewCard [data-set-enabled]').count(), 0);
  assert.equal(await updatedCard.getByRole("button", { name: "Run now" }).isDisabled(), true);
  assert.equal(await updatedCard.getByRole("button", { name: "Pause" }).isDisabled(), true);
  pass("Binding review leaves activation, Run now, and Pause locked");

  await panel.screenshot({ path: join(artifactDir, "schedule-binding.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew prepared schedule binding installed-extension smoke checks passed.");
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

async function storedSchedule(worker) {
  return worker.evaluate(async (id) => {
    const stored = await chrome.storage.local.get("browsercrew.schedules.v1");
    return (stored["browsercrew.schedules.v1"] || []).find((item) => item.id === id) || null;
  }, schedule.id);
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