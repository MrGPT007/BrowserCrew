import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-library-lifecycle-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-library-lifecycle-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_library_lifecycle_smoke", startedAt: new Date().toISOString(), checks: [] };

const origin = "https://example.test";
function skill({ id, version, status, title }) {
  return {
    schemaVersion: 1,
    id,
    version,
    status,
    title,
    description: `${title} safely within the approved example site.`,
    inputs: { query: { name: "query", type: "string", required: true, secret: false, label: "Search query" } },
    allowedOrigins: [origin],
    actionClasses: ["read", "page_write_prepare"],
    dataDestinations: [],
    budgets: { maxSteps: 12, maxMinutes: 9 },
    steps: [
      { id: "step-type", kind: "type", purpose: "Enter the run-time query.", origin, target: { role: "textbox", label: "Search" }, value: "{{input.query}}" },
      { id: "step-verify", kind: "verify", purpose: "Verify the saved result.", origin, expect: { visibleText: "Ready" } }
    ],
    completionCriteria: [{ claim: "The saved result is ready.", verification: "Visible text says Ready." }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "test", createdAt: "2026-09-12T13:00:00.000Z" },
    ...(status === "approved" || status === "archived" ? { approval: { approvedAt: "2026-09-12T13:05:00.000Z", approvedBy: "user" } } : {}),
    ...(status === "archived" ? { archivedAt: "2026-09-12T13:10:00.000Z" } : {})
  };
}
const draft = skill({ id: "draft-supplier", version: "0.1.0", status: "draft", title: "Draft supplier check" });
const approved = skill({ id: "approved-supplier", version: "1.0.0", status: "approved", title: "Approved supplier check" });
const archived = skill({ id: "archived-supplier", version: "0.9.0", status: "archived", title: "Archived supplier check" });

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await prepareExtension(extensionDir);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  await worker.evaluate(async (skills) => chrome.storage.local.set({ "browsercrew.skillLibrary.v1": skills }), [draft, approved, archived]);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.locator("#skillLibraryFilters").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => await panel.locator("[data-skill-record]").count() === 3, "My Skills should render all exact versions.");
  assert.equal(await panel.locator("#versionedSkillsCard h2").innerText(), "My Skills");
  assert.match(await panel.locator("#versionedSkillsCard .helper").innerText(), /What is a Skill\? A saved way to do a browser job\./);
  assert.match(await panel.getByRole("button", { name: /^All versions/ }).innerText(), /\(3\)/);
  assert.match(await panel.getByRole("button", { name: /^Drafts/ }).innerText(), /\(1\)/);
  assert.match(await panel.getByRole("button", { name: /^Approved/ }).innerText(), /\(1\)/);
  assert.match(await panel.getByRole("button", { name: /^Archived/ }).innerText(), /\(1\)/);
  pass("My Skills explains a Skill in plain language and exposes exact-version filters with draft, approved, and archived counts");

  await panel.getByRole("button", { name: /^Drafts/ }).click();
  await waitUntil(async () => await panel.locator("[data-skill-record]").count() === 1, "Draft filter should show only drafts.");
  const draftCard = panel.locator('[data-skill-record="draft-supplier@@0.1.0"]');
  assert.equal(await draftCard.isVisible(), true);
  await draftCard.getByRole("button", { name: "Review & edit draft" }).waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await draftCard.getByRole("button", { name: "Delete draft" }).isVisible(), true);
  pass("Draft view keeps review/approval controls and exposes delete only for unapproved drafts");

  await panel.getByRole("button", { name: /^Approved/ }).click();
  await waitUntil(async () => await panel.locator("[data-skill-record]").count() === 1, "Approved filter should show only approved versions.");
  const approvedCard = panel.locator('[data-skill-record="approved-supplier@@1.0.0"]');
  assert.equal(await approvedCard.getByRole("button", { name: "Archive" }).isVisible(), true);
  assert.equal(await approvedCard.getByRole("button", { name: "Duplicate as draft" }).isVisible(), true);
  assert.equal(await approvedCard.getByRole("button", { name: "Delete draft" }).count(), 0);

  await approvedCard.getByRole("button", { name: "Duplicate as draft" }).click();
  await waitUntil(async () => /Copy created as a new draft/i.test(await panel.locator("#toast").innerText()), "Duplicating an approved version should create a new draft.");
  let skills = await storedSkills(worker);
  assert.equal(skills.length, 4);
  const copy = skills.find((item) => item.provenance?.source === "skill_duplicate");
  assert.ok(copy, "A duplicated draft should be persisted.");
  assert.equal(copy.status, "draft");
  assert.equal(copy.version, "0.1.0");
  assert.equal(copy.approval, undefined);
  assert.equal(copy.archivedAt, undefined);
  assert.deepEqual(copy.provenance.sourceSkillRef, { id: approved.id, version: approved.version });
  assert.deepEqual(copy.allowedOrigins, approved.allowedOrigins);
  assert.deepEqual(copy.actionClasses, approved.actionClasses);
  assert.deepEqual(copy.budgets, approved.budgets);
  assert.deepEqual(copy.steps, approved.steps);
  pass("Duplicating an approved version creates a separate unapproved draft without widening scope");

  await waitUntil(async () => /\(2\)/.test(await panel.getByRole("button", { name: /^Drafts/ }).innerText()), "Draft count should include the new copy.");
  const originalDraftCard = panel.locator('[data-skill-record="draft-supplier@@0.1.0"]');
  panel.once("dialog", (dialog) => dialog.accept());
  await originalDraftCard.getByRole("button", { name: "Delete draft" }).click();
  await waitUntil(async () => !(await storedSkills(worker)).some((item) => item.id === draft.id && item.version === draft.version), "Original unapproved draft should be deleted.");
  skills = await storedSkills(worker);
  assert.ok(skills.some((item) => item.id === approved.id && item.status === "approved"));
  assert.ok(skills.some((item) => item.id === archived.id && item.status === "archived"));
  pass("Deleting a draft removes only that unapproved version and preserves immutable history");

  await panel.getByRole("button", { name: /^Approved/ }).click();
  await waitUntil(async () => await panel.locator('[data-skill-record="approved-supplier@@1.0.0"]').count() === 1, "Approved version should remain available for archive.");
  panel.once("dialog", (dialog) => dialog.accept());
  await panel.locator('[data-skill-record="approved-supplier@@1.0.0"]').getByRole("button", { name: "Archive" }).click();
  await waitUntil(async () => (await storedSkills(worker)).find((item) => item.id === approved.id)?.status === "archived", "Approved version should become archived.");
  skills = await storedSkills(worker);
  const archivedApproved = skills.find((item) => item.id === approved.id);
  assert.ok(archivedApproved.archivedAt);
  assert.ok(archivedApproved.approval, "Archiving must preserve exact approval history.");
  await panel.getByRole("button", { name: /^Archived/ }).click();
  await waitUntil(async () => await panel.locator("[data-skill-record]").count() === 2, "Archived filter should show both archived exact versions.");
  assert.equal(await panel.locator('[data-skill-status="archived"] [data-delete-draft]').count(), 0);
  assert.equal(await panel.locator('[data-skill-status="archived"] [data-duplicate-skill]').count(), 2);
  pass("Approved versions archive into immutable history and archived versions cannot be deleted from the UI");

  await panel.screenshot({ path: join(artifactDir, "skill-library-lifecycle.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Skill library lifecycle installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "skill-library-lifecycle-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function storedSkills(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []);
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
