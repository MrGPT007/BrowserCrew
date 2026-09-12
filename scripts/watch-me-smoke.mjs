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
  await waitForText(panel.locator("#watchMeStatus"), "Watching");
  assert.match(await panel.locator("#watchMeBadge").innerText(), /Watching/i);
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

  await target.bringToFront();
  await panel.evaluate(() => document.querySelector("#watchMeStopButton")?.click());
  await waitForText(panel.locator("#watchMeDraftResult"), "Draft ready for review");
  await panel.locator("#versionedSkillList [data-approve-skill]").waitFor({ state: "visible", timeout: timeoutMs });
  pass("Stopping Watch Me produced a reviewable draft instead of an immediately executable macro");

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
  pass("Durable Watch Me state excludes typed/selected literals and marks secret inputs without defaults");

  const approveButton = panel.locator("#versionedSkillList [data-approve-skill]").first();
  panel.once("dialog", (dialog) => dialog.accept());
  await approveButton.click();
  await waitForText(panel.locator("#versionedSkillList"), "Approved");
  const storedAfterApproval = await worker.evaluate(async () => chrome.storage.local.get("browsercrew.skillLibrary.v1"));
  const approved = storedAfterApproval["browsercrew.skillLibrary.v1"]?.find((item) => item.id === draft.id && item.version === draft.version);
  assert.equal(approved?.status, "approved");
  assert.ok(approved?.approval?.approvedAt, "Approval should record an explicit timestamp.");
  pass("User explicitly approved the exact recorded skill version through the Skills UI");

  const safeDump = JSON.stringify(storedAfterApproval);
  for (const literal of Object.values(LITERALS)) assert.equal(safeDump.includes(literal), false, "Approval must not reintroduce demonstration literals.");
  await panel.screenshot({ path: join(artifactDir, "watch-me-skills.png"), fullPage: true });
  report.skill = { id: approved.id, version: approved.version, status: approved.status, stepCount: approved.steps.length, inputCount: Object.keys(approved.inputs || {}).length };
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Watch Me Fixture</title></head><body>
    <main>
      <h1>Prepare a review</h1>
      <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email">
      <label for="department">Department</label><select id="department" name="department"><option value="sales">Sales</option><option value="finance-private-choice">Finance</option></select>
      <label for="password">Account password</label><input id="password" name="password" type="password" autocomplete="current-password">
      <button id="preview" type="button">Preview</button>
      <p id="ready" hidden>Ready to review</p>
    </main>
    <script>document.querySelector('#preview').addEventListener('click',()=>{document.querySelector('#ready').hidden=false;});</script>
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
