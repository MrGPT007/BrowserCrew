import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "skill-draft-review-smoke");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-skill-draft-review-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
const timeoutMs = 30_000;
let context;
const report = { schemaVersion: 1, kind: "browsercrew.skill_draft_review_smoke", startedAt: new Date().toISOString(), checks: [] };

const origin = "https://example.test";
const unusedOrigin = "https://unused.example.test";
const draft = {
  schemaVersion: 1,
  id: "review-recorded-form",
  version: "0.1.0",
  status: "draft",
  title: "My recorded browser job",
  description: "Recorded draft waiting for review.",
  inputs: {
    emailAddress: { name: "emailAddress", type: "string", required: true, secret: false, label: "Email address" },
    department: { name: "department", type: "string", required: true, secret: false, label: "Department" }
  },
  allowedOrigins: [origin, unusedOrigin],
  actionClasses: ["read", "page_write_prepare", "download"],
  dataDestinations: [],
  budgets: { maxSteps: 18, maxMinutes: 30 },
  steps: [
    { id: "step-open", kind: "navigate", purpose: "Open the demonstrated page.", origin, url: `${origin}/form` },
    { id: "step-email", kind: "type", purpose: "Enter the reviewed email.", origin, target: { role: "textbox", label: "Email address" }, value: "{{input.emailAddress}}" },
    { id: "step-department", kind: "select", purpose: "Choose the reviewed department.", origin, target: { role: "combobox", label: "Department" }, value: "{{input.department}}" },
    { id: "step-preview", kind: "click", purpose: "Choose Preview.", origin, target: { role: "button", label: "Preview" } },
    { id: "step-verify", kind: "verify", purpose: "Verify the reviewed result.", origin, expect: { visibleText: "Ready to review" } }
  ],
  completionCriteria: [{ claim: "The form reached review state.", verification: "Visible text says Ready to review." }],
  recovery: { retryWrites: false, reconcileUnknownWrites: true },
  provenance: { source: "watch_me_demonstration", sessionId: "watch-review-smoke", createdAt: "2026-09-12T12:00:00.000Z", eventCount: 5 }
};

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

  await worker.evaluate(async (skillSeed) => {
    await chrome.storage.local.set({ "browsercrew.skillLibrary.v1": [skillSeed] });
  }, draft);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  const reviewButton = panel.getByRole("button", { name: "Review & edit draft" });
  await reviewButton.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await panel.getByRole("button", { name: "Approve this version" }).isVisible(), true);
  pass("Draft skills expose an explicit review step before exact-version approval");

  await reviewButton.click();
  const editor = panel.locator("[data-draft-review-editor]");
  await editor.waitFor({ state: "visible", timeout: timeoutMs });
  const editorText = await editor.innerText();
  assert.match(editorText, /cannot add websites, actions, permissions, budgets, or runtime values/i);
  assert.match(editorText, /only make this draft narrower/i);
  assert.match(editorText, /Recorded runtime values are never displayed here/i);
  assert.equal(await editor.locator("[data-runtime-value]").count(), 0, "Draft review must not expose an input for recorded runtime values.");
  assert.equal(await editor.locator("[data-scope-origin]").count(), 2, "Draft review should list only already-recorded websites.");
  assert.equal(await editor.locator("[data-scope-action]").count(), 3, "Draft review should list only already-recorded actions.");
  pass("Draft review explains its narrow authority and exposes no demonstrated runtime values");

  const requiredWrite = editor.locator('[data-scope-action="page_write_prepare"]');
  await requiredWrite.uncheck();
  await editor.getByRole("button", { name: "Save draft review" }).click();
  await waitUntil(async () => /page_write_prepare/i.test(await panel.locator("#toast").innerText()), "Removing an action still required by kept steps should fail visibly.");
  assert.equal(await editor.count(), 1, "Rejected scope narrowing must keep the editor open and persist nothing.");
  await requiredWrite.check();
  pass("Draft review refuses to remove site/action scope that kept steps still require");

  await editor.locator(`[data-scope-origin="${unusedOrigin}"]`).uncheck();
  await editor.locator('[data-scope-action="download"]').uncheck();
  await editor.locator("[data-draft-title]").fill("Prepare reviewed form");
  await editor.locator("[data-draft-description]").fill("Prepare the form with reviewed run-time inputs and verify the final review state.");
  const emailRow = editor.locator('[data-draft-input="emailAddress"]');
  await emailRow.locator("[data-input-name]").fill("recipientEmail");
  await emailRow.locator("[data-input-label]").fill("Recipient email");
  const emailStep = editor.locator('[data-draft-step="step-email"]');
  await emailStep.locator("[data-step-purpose]").fill("Enter the recipient email only at run time.");
  const previewStep = editor.locator('[data-draft-step="step-preview"]');
  await previewStep.locator("[data-keep-step]").uncheck();
  const finalKeep = editor.locator('[data-draft-step="step-verify"] [data-keep-step]');
  assert.equal(await finalKeep.isDisabled(), true, "The final result check removal control must stay disabled.");
  assert.equal(await finalKeep.isChecked(), true);
  pass("User can rename draft metadata and runtime prompts, edit step descriptions, remove a non-final step, and narrow unused scope");

  await editor.getByRole("button", { name: "Save draft review" }).click();
  await waitUntil(async () => /Draft review saved/i.test(await panel.locator("#toast").innerText()), "Draft review should save through the validated skill library runtime.");
  await waitUntil(async () => await panel.locator("[data-draft-review-editor]").count() === 0, "Draft editor should close after save.");

  const skills = await worker.evaluate(async () => (await chrome.storage.local.get("browsercrew.skillLibrary.v1"))["browsercrew.skillLibrary.v1"] || []);
  assert.equal(skills.length, 1);
  const saved = skills[0];
  assert.equal(saved.id, draft.id);
  assert.equal(saved.version, draft.version);
  assert.equal(saved.status, "draft", "Editing must not approve the skill.");
  assert.equal(saved.approval, undefined, "Editing must not create approval metadata.");
  assert.equal(saved.title, "Prepare reviewed form");
  assert.equal(saved.inputs.emailAddress, undefined);
  assert.equal(saved.inputs.recipientEmail.label, "Recipient email");
  assert.equal(saved.inputs.recipientEmail.name, "recipientEmail");
  assert.equal(saved.steps.find((step) => step.id === "step-email")?.value, "{{input.recipientEmail}}");
  assert.equal(saved.steps.find((step) => step.id === "step-email")?.purpose, "Enter the recipient email only at run time.");
  assert.equal(saved.steps.some((step) => step.id === "step-preview"), false);
  assert.equal(saved.steps.at(-1).id, "step-verify");
  assert.equal(saved.steps.at(-1).expect.visibleText, "Ready to review");
  assert.deepEqual(saved.allowedOrigins, [origin], "Saved review may only reduce the recorded website set.");
  assert.deepEqual(saved.actionClasses, ["read", "page_write_prepare"], "Saved review may only reduce the recorded action set.");
  assert.deepEqual(saved.budgets, draft.budgets);
  assert.equal(JSON.stringify(saved).includes("person@example.com"), false);
  assert.equal(JSON.stringify(saved).includes("RUNTIME_SECRET_CANARY"), false);
  pass("Saved review preserves exact draft identity and verification while narrowing scope without granting approval or persisting runtime literals");

  await panel.getByRole("button", { name: "Approve this version" }).waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await panel.locator("#versionedSkillList").innerText(), /Prepare reviewed form/);
  assert.match(await panel.locator("#versionedSkillList").innerText(), /Needs review/);
  pass("Edited skill remains visibly reviewable and unapproved after save");

  await panel.screenshot({ path: join(artifactDir, "skill-draft-review.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew skill draft review installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "skill-draft-review-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) {
  report.checks.push({ name, at: new Date().toISOString() });
}

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
