import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "watch-me-smoke");
const timeoutMs = 30_000;
const LITERALS = {
  email: "watched-user@example.test",
  password: "WATCH_ME_PASSWORD_CANARY_42",
  department: "finance-private-choice"
};
const REPLAY_VALUES = {
  email: "replay-user@example.test",
  password: "RUNTIME_PASSWORD_CANARY_99",
  department: "sales"
};

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const fixture = await startFixtureServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-watch-me-"));
const extensionDir = join(tempRoot, "extension");
const profileDir = join(tempRoot, "profile");
let context;
const report = { schemaVersion: 1, kind: "browsercrew.watch_me_smoke", startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, fixture.origin);
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

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/form.html`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Skills" }).click();
  await panel.locator("#watchMeStartButton").waitFor({ state: "visible", timeout: timeoutMs });
  pass("Skills tab exposes Watch me do it without replacing the legacy Skills surface");

  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStartButton")?.click());
  await panel.locator("#watchMeRunning").waitFor({ state: "visible", timeout: timeoutMs });
  await waitForText(panel.locator("#watchMeBadge"), "Watching");
  assert.match(await panel.locator("#watchMeStatus").innerText(), /Watching/i);
  pass("Watch me do it started only for the user-selected active fixture page");

  await target.locator("#email").fill(LITERALS.email);
  await target.locator("#email").press("Tab");
  await target.locator("#department").selectOption(LITERALS.department);
  await target.locator("#password").fill(LITERALS.password);
  await target.locator("#password").press("Tab");
  await target.locator("#preview").click();
  await target.locator("#ready").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => /[4-9] step/.test(await panel.locator("#watchMeStatus").innerText()), "Watch Me should record semantic form interactions.");
  pass("Recorder captured semantic type/select/click activity while the user performed the workflow");

  await panel.locator("#watchMeCompletionText").fill("Ready to review");
  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStopButton")?.click());
  await waitForText(panel.locator("#watchMeDraftResult"), "Draft ready for review");
  await panel.locator("#versionedSkillList [data-approve-skill]").waitFor({ state: "visible", timeout: timeoutMs });
  pass("Stopping Watch Me required a visible success marker and produced a reviewable draft");

  const storedBeforeApproval = await worker.evaluate(async () => chrome.storage.local.get(["browsercrew.watchMe.v1", "browsercrew.skillLibrary.v1"]));
  const durableBefore = JSON.stringify(storedBeforeApproval);
  for (const [name, literal] of Object.entries(LITERALS)) {
    assert.equal(durableBefore.includes(literal), false, `${name} demonstration literal must never be stored by Watch Me.`);
  }
  const draft = storedBeforeApproval["browsercrew.skillLibrary.v1"]?.find((item) => item.provenance?.source === "watch_me_demonstration");
  assert.ok(draft, "Watch Me should save one versioned demonstration draft.");
  assert.equal(draft.status, "draft");
  assert.equal(Object.values(draft.inputs || {}).some((input) => input.secret === true), true, "Password-like demonstration input should be marked secret.");
  assert.equal(Object.values(draft.inputs || {}).every((input) => !Object.prototype.hasOwnProperty.call(input, "default")), true, "Recorded inputs should not persist demonstration defaults.");
  assert.equal(draft.steps.some((step) => step.target?.coordinates), false, "Recorded steps must not use raw screen coordinates.");
  const finalDraftStep = draft.steps.at(-1);
  assert.equal(finalDraftStep?.kind, "verify", "Recorded skill must end with an executable verification step.");
  assert.equal(finalDraftStep?.expect?.visibleText, "Ready to review", "Recorded skill must pin the user-chosen visible completion evidence.");
  pass("Durable Watch Me state excludes demonstration literals and ends with explicit completion evidence");

  const approveButton = panel.locator("#versionedSkillList [data-approve-skill]").first();
  panel.once("dialog", (dialog) => dialog.accept());
  await approveButton.click();
  await waitForText(panel.locator("#versionedSkillList"), "Approved");
  const storedAfterApproval = await worker.evaluate(async () => chrome.storage.local.get("browsercrew.skillLibrary.v1"));
  const approved = storedAfterApproval["browsercrew.skillLibrary.v1"]?.find((item) => item.id === draft.id && item.version === draft.version);
  assert.equal(approved?.status, "approved");
  assert.ok(approved?.approval?.approvedAt, "Approval should record an explicit timestamp.");
  assert.equal(approved.steps.at(-1)?.kind, "verify");
  pass("User explicitly approved the exact recorded skill version with final completion proof");

  const safeDump = JSON.stringify(storedAfterApproval);
  for (const literal of Object.values(LITERALS)) assert.equal(safeDump.includes(literal), false, "Approval must not reintroduce demonstration literals.");

  await target.goto(`${fixture.origin}/form.html`);
  await target.bringToFront();
  const selected = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }));
  assert.equal(selected?.ok, true);
  assert.equal(new URL(selected.tab.url).origin, fixture.origin);

  const grant = {
    origins: [fixture.origin],
    actionClasses: ["read", "page_write_prepare"],
    dataDestinations: [],
    revoked: false,
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
  const replay = await panel.evaluate(async ({ skillId, version, tabId, inputValues, grantValue }) => {
    const port = chrome.runtime.connect({ name: "browsercrew-skills" });
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("Replay timed out.")); }, 20_000);
      port.onMessage.addListener((message) => {
        if (message?.requestId !== requestId) return;
        clearTimeout(timeout);
        try { port.disconnect(); } catch {}
        resolve(message);
      });
      port.postMessage({ type: "run", requestId, skillId, version, tabId, inputValues, grant: grantValue });
    });
  }, { skillId: approved.id, version: approved.version, tabId: selected.tab.id, inputValues: REPLAY_VALUES, grantValue: grant });

  assert.equal(replay.ok, true, replay.error?.message || "Approved recorded skill should replay successfully.");
  assert.equal(await target.locator("#email").inputValue(), REPLAY_VALUES.email);
  assert.equal(await target.locator("#department").inputValue(), REPLAY_VALUES.department);
  assert.equal(await target.locator("#password").inputValue(), REPLAY_VALUES.password);
  await target.locator("#ready").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0", "Safe replay must not invoke the real Save/submit path.");
  pass("Approved skill replay re-found semantic targets, used new runtime inputs, and verified the visible result without submitting");

  const runStorage = await worker.evaluate(async () => chrome.storage.local.get("browsercrew.skillRuns.v1"));
  const replayRun = runStorage["browsercrew.skillRuns.v1"]?.find((item) => item.id === replay.run?.id);
  assert.ok(replayRun, "Replay should persist a durable sanitized run receipt.");
  assert.equal(replayRun.status, "completed");
  assert.equal(replayRun.receipt?.status, "completed");
  assert.equal(replayRun.receipt?.skillRef?.id, approved.id);
  assert.equal(replayRun.receipt?.skillRef?.version, approved.version);
  const replayDurable = JSON.stringify(replayRun);
  for (const literal of Object.values(REPLAY_VALUES)) assert.equal(replayDurable.includes(literal), false, "Runtime input values must never enter durable skill-run history.");
  const intents = replayRun.events.filter((event) => event.type === "skill.step.intent");
  const completions = replayRun.events.filter((event) => event.type === "skill.step.complete");
  assert.equal(intents.length, approved.steps.length, "Every replayed step must have a durable intent journal entry.");
  assert.equal(completions.length, approved.steps.length, "Every successful replayed step must have a completion journal entry.");
  assert.ok(new Date(intents[0].at).getTime() <= new Date(completions[0].at).getTime(), "Step intent must be journaled before completion.");
  pass("Replay saved an exact-version sanitized intent/completion journal without runtime input values");

  const unsafeSkill = {
    schemaVersion: 1,
    id: "unsafe-recorded-save",
    version: "1.0.0",
    status: "approved",
    title: "Unsafe recorded save",
    description: "Test-only approved skill proving recorded demonstrations do not grant commit authority.",
    inputs: {},
    allowedOrigins: [fixture.origin],
    actionClasses: ["read", "page_write_prepare"],
    dataDestinations: [],
    budgets: { maxSteps: 5, maxMinutes: 5 },
    steps: [
      { id: "step-01", kind: "click", purpose: "Attempt to save changes.", origin: fixture.origin, target: { role: "button", label: "Save changes", id: "save" } },
      { id: "step-02", kind: "verify", purpose: "Verify the saved state.", origin: fixture.origin, expect: { visibleText: "Saved" } }
    ],
    completionCriteria: [{ claim: "Changes were saved.", verification: "Require visible Saved text." }],
    recovery: { retryWrites: false, reconcileUnknownWrites: true },
    provenance: { source: "watch_me_demonstration", createdAt: new Date().toISOString() },
    approval: { approvedAt: new Date().toISOString(), approvedBy: "test" }
  };
  await worker.evaluate(async (skill) => {
    const key = "browsercrew.skillLibrary.v1";
    const data = await chrome.storage.local.get(key);
    const skills = Array.isArray(data[key]) ? data[key] : [];
    skills.push(skill);
    await chrome.storage.local.set({ [key]: skills });
  }, unsafeSkill);

  const unsafeReplay = await panel.evaluate(async ({ tabId, grantValue }) => {
    const port = chrome.runtime.connect({ name: "browsercrew-skills" });
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { try { port.disconnect(); } catch {} reject(new Error("Unsafe replay timed out.")); }, 20_000);
      port.onMessage.addListener((message) => {
        if (message?.requestId !== requestId) return;
        clearTimeout(timeout);
        try { port.disconnect(); } catch {}
        resolve(message);
      });
      port.postMessage({ type: "run", requestId, skillId: "unsafe-recorded-save", version: "1.0.0", tabId, inputValues: {}, grant: grantValue });
    });
  }, { tabId: selected.tab.id, grantValue: grant });
  assert.equal(unsafeReplay.ok, false, "Recorded Save click must be refused even with a page-write-prepare grant.");
  assert.equal(unsafeReplay.error?.code, "SKILL_CLICK_REQUIRES_COMMIT_APPROVAL");
  assert.equal(await target.locator("body").getAttribute("data-submits"), "0", "Blocked unsafe replay must dispatch zero submit/save actions.");
  pass("Recorded demonstration did not inherit Save/submit authority; commit-like click was blocked before dispatch");

  await panel.screenshot({ path: join(artifactDir, "watch-me-skills.png"), fullPage: true });
  report.skill = { id: approved.id, version: approved.version, status: approved.status, stepCount: approved.steps.length, inputCount: Object.keys(approved.inputs || {}).length };
  report.replay = { runId: replay.run.id, status: replay.run.status, journalEvents: replayRun.events.length, submitted: false };
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew Watch Me installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareTestExtension(target, origin) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", ".browser", "dist"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Watch Me Fixture</title></head><body data-submits="0">
    <main>
      <h1>Prepare a review</h1>
      <form id="reviewForm">
        <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email">
        <label for="department">Department</label><select id="department" name="department"><option value="sales">Sales</option><option value="finance-private-choice">Finance</option></select>
        <label for="password">Account password</label><input id="password" name="password" type="password" autocomplete="current-password">
        <button id="preview" type="button">Preview</button>
        <button id="save" type="submit">Save changes</button>
      </form>
      <p id="ready" hidden>Ready to review</p>
      <p id="saved" hidden>Saved</p>
    </main>
    <script>
      document.querySelector('#preview').addEventListener('click',()=>{document.querySelector('#ready').hidden=false;});
      document.querySelector('#reviewForm').addEventListener('submit',(event)=>{
        event.preventDefault();
        document.body.dataset.submits=String(Number(document.body.dataset.submits||'0')+1);
        document.querySelector('#saved').hidden=false;
      });
    </script>
  </body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/form.html") { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolveClose) => server.close(() => resolveClose())) };
}

async function waitForText(locator, expected) {
  await waitUntil(async () => (await locator.innerText()).includes(expected), `Expected text: ${expected}`);
}

async function waitUntil(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}