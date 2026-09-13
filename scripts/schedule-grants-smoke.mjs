import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createPreparedScheduleMetadata } from "../src/schedule-prepared-metadata.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "schedule-setup-smoke", "grants");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-schedule-grant-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.schedule_grant_smoke", startedAt: new Date().toISOString(), checks: [] };
const createdAt = "2026-09-13T06:00:00.000Z";

const skill = {
  schemaVersion: 1,
  id: "schedule-grant-skill",
  version: "2.1.0",
  status: "approved",
  title: "Review supplier orders",
  description: "Review the exact supplier order page with bounded read access.",
  inputs: {},
  allowedOrigins: ["https://example.test"],
  allowedResources: ["resource:orders"],
  actionClasses: ["read"],
  dataDestinations: [],
  providerRequirements: { capabilities: [] },
  budgets: { maxSteps: 6, maxMinutes: 5 },
  steps: [{ id: "verify-orders", kind: "verify", purpose: "Verify supplier orders.", origin: "https://example.test", expect: { visibleText: "Orders ready" } }],
  completionCriteria: [{ claim: "Orders are ready.", verification: "Visible text says Orders ready." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "test", createdAt },
  approval: { approvedAt: createdAt, approvedBy: "user" },
  writePolicy: { approvalRequired: true, noBlindRetry: true },
  verificationRules: { reobserveTargetsBeforeDispatch: true, requireFinalVerification: true },
  createdAt,
  updatedAt: createdAt,
  compatibility: { metadataVersion: 1, minBrowserCrewVersion: "0.2.0" }
};
const connectionA = connection("grant-provider-a", "Local Grant AI A", "grant-model-a");
const connectionB = connection("grant-provider-b", "Local Grant AI B", "grant-model-b");
const prepared = createPreparedScheduleMetadata({ skill, pageUrl: "https://example.test/orders", reviewedAt: createdAt });
const schedule = {
  schemaVersion: 1,
  id: "schedule-grant-daily",
  name: "Supplier grant review",
  enabled: false,
  skillRef: { id: skill.id, version: skill.version },
  timezone: "UTC",
  recurrence: { kind: "daily", hour: 9, minute: 30 },
  missedRunPolicy: "ask",
  concurrencyPolicy: "skip_if_running",
  providerRef: connectionA.id,
  grantRefs: [],
  budgets: { maxSteps: 6, maxMinutes: 5 },
  ...prepared,
  createdAt,
  updatedAt: createdAt,
  nextRunAt: null
};

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);
  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  assert.equal((manifest.permissions || []).includes("alarms"), false);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1400 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  await worker.evaluate(async ({ skillSeed, connections, scheduleSeed }) => {
    await chrome.storage.local.set({
      "browsercrew.skillLibrary.v1": [skillSeed],
      "browsercrew.connections.v1": connections,
      "browsercrew.activeConnection.v1": connections[0].id,
      "browsercrew.schedules.v1": [scheduleSeed],
      "browsercrew.scheduleGrants.v1": [],
      "browsercrew.scheduleRuns.v1": []
    });
  }, { skillSeed: skill, connections: [connectionA, connectionB], scheduleSeed: schedule });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  let card = panel.locator(`[data-prepared-schedule="${schedule.id}"]`);
  await card.waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => /Future permission:\s*Not approved/i.test(await card.innerText()) && /Local Grant AI A/i.test(await card.innerText()), "Bound prepared schedule should offer explicit future permission review.");
  assert.match(await card.innerText(), /still does not turn the schedule on/i);
  pass("Bound prepared schedule starts with no durable authority and clearly names the selected provider");

  const expiry = card.locator(`[data-schedule-grant-days="${schedule.id}"]`);
  await expiry.selectOption("30");
  await card.locator(`[data-approve-schedule-grant="${schedule.id}"]`).click();
  await waitUntil(async () => /Future permission approved/i.test(await panel.locator("#toast").innerText()), "Explicit future permission approval should succeed.");

  let state = await storedState(worker);
  assert.equal(state.schedules.length, 1);
  assert.equal(state.schedules[0].enabled, false);
  assert.equal(state.schedules[0].grantRefs.length, 1);
  assert.equal(state.grants.length, 1);
  const firstGrant = state.grants[0];
  assert.equal(firstGrant.status, "active");
  assert.equal(firstGrant.revoked, false);
  assert.equal(firstGrant.scheduleId, schedule.id);
  assert.equal(firstGrant.providerRef, connectionA.id);
  assert.deepEqual(firstGrant.skillRef, schedule.skillRef);
  assert.deepEqual(firstGrant.origins, skill.allowedOrigins);
  assert.deepEqual(firstGrant.resources, skill.allowedResources);
  assert.deepEqual(firstGrant.actionClasses, skill.actionClasses);
  assert.deepEqual(firstGrant.dataDestinations, skill.dataDestinations);
  assert.ok(Date.parse(firstGrant.expiresAt) > Date.now());
  for (const forbidden of ["token", "secret", "apiKey", "password", "cookie", "authorization", "headers", "providerSecret", "inputValues", "runtimeInputs", "tabId"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(firstGrant, forbidden), false, `Durable schedule grant must not persist ${forbidden}.`);
  }
  assert.equal(state.runs.length, 0, "Approving future permission must not create a schedule run receipt.");
  await waitUntil(async () => /Future permission:\s*Approved until/i.test(await card.innerText()), "Grant card should surface active expiry.");
  pass("Explicit approval creates one expiring exact-schedule/provider/Skill grant without running anything");

  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.locator("#scheduleConnection").selectOption(connectionB.id);
  await panel.locator("#scheduleSaveDraft").click();
  await waitUntil(async () => /Revoke.*permission/i.test(await panel.locator("#toast").innerText()), "Changing provider with active durable permission must be blocked.");
  state = await storedState(worker);
  assert.equal(state.schedules[0].providerRef, connectionA.id);
  assert.deepEqual(state.schedules[0].grantRefs, [firstGrant.id]);
  pass("Active durable permission blocks provider changes instead of silently carrying authority to another AI connection");

  await panel.locator("#scheduleCancelDraft").click();
  card = panel.locator(`[data-prepared-schedule="${schedule.id}"]`);
  await card.locator(`[data-revoke-schedule-grant="${schedule.id}"]`).click();
  await waitUntil(async () => /Future permission revoked/i.test(await panel.locator("#toast").innerText()), "User should be able to revoke future permission while schedule remains off.");
  state = await storedState(worker);
  assert.deepEqual(state.schedules[0].grantRefs, []);
  assert.equal(state.grants[0].status, "revoked");
  assert.equal(state.grants[0].revoked, true);
  assert.equal(state.grants[0].revokedReason, "user_revoked");
  pass("Revocation clears executable refs while retaining an immutable revoked receipt for audit");

  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.locator("#scheduleConnection").selectOption(connectionB.id);
  await panel.locator("#scheduleSaveDraft").click();
  await waitUntil(async () => /Prepared schedule saved/i.test(await panel.locator("#toast").innerText()), "Provider change should succeed after revocation.");
  state = await storedState(worker);
  assert.equal(state.schedules[0].providerRef, connectionB.id);
  assert.deepEqual(state.schedules[0].grantRefs, []);
  assert.equal(state.schedules[0].startResource.url, "https://example.test/orders", "Provider-only edit must preserve the trusted starting-page binding.");
  card = panel.locator(`[data-prepared-schedule="${schedule.id}"]`);
  await waitUntil(async () => /Local Grant AI B/i.test(await card.innerText()) && /Future permission:\s*Not approved/i.test(await card.innerText()), "After revocation/edit, UI should require fresh permission for provider B.");

  await card.locator(`[data-schedule-grant-days="${schedule.id}"]`).selectOption("7");
  await card.locator(`[data-approve-schedule-grant="${schedule.id}"]`).click();
  await waitUntil(async () => /Future permission approved/i.test(await panel.locator("#toast").innerText()), "Replacement provider permission should require a fresh explicit approval.");
  state = await storedState(worker);
  const activeGrant = state.grants.find((grant) => grant.status === "active");
  assert.ok(activeGrant);
  assert.equal(activeGrant.providerRef, connectionB.id);
  assert.notEqual(activeGrant.id, firstGrant.id);
  assert.deepEqual(state.schedules[0].grantRefs, [activeGrant.id]);
  assert.equal(state.grants.find((grant) => grant.id === firstGrant.id)?.status, "revoked");
  pass("Provider replacement requires a new permission grant while the prior revoked receipt remains durable");

  panel.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await waitUntil(async () => (await storedState(worker)).schedules.length === 0, "Prepared schedule deletion should complete.");
  state = await storedState(worker);
  const deletedGrant = state.grants.find((grant) => grant.id === activeGrant.id);
  assert.equal(deletedGrant.status, "revoked", "Deleting a schedule must revoke its active durable authority before removing the schedule.");
  assert.equal(deletedGrant.revokedReason, "schedule_deleted");
  assert.equal(state.runs.length, 0, "Grant lifecycle proof must never create a schedule run receipt.");
  pass("Deleting a prepared schedule revokes active durable authority instead of leaving an orphan grant");

  await panel.screenshot({ path: join(artifactDir, "schedule-grants.png"), fullPage: true });
  report.ok = true;
  report.completedAt = new Date().toISOString();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew durable prepared schedule grant installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.ok = false;
  report.completedAt = new Date().toISOString();
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function connection(id, name, model) {
  return { id, schemaVersion: 1, name, kind: "openai-compatible", model, baseUrl: "http://127.0.0.1:1234/v1", status: "connected", lastTestedAt: createdAt, createdAt, updatedAt: createdAt };
}
async function storedState(worker) {
  return worker.evaluate(async () => {
    const data = await chrome.storage.local.get(["browsercrew.schedules.v1", "browsercrew.scheduleGrants.v1", "browsercrew.scheduleRuns.v1"]);
    return {
      schedules: data["browsercrew.schedules.v1"] || [],
      grants: data["browsercrew.scheduleGrants.v1"] || [],
      runs: data["browsercrew.scheduleRuns.v1"] || []
    };
  });
}
function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }
async function prepareExtension(target) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(relative.split(/[/\\]/)[0]);
  } });
}
async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}