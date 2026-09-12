import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "privacy-smoke");
const timeoutMs = 30_000;
const CANARY = Object.freeze({
  provider: "BC_CANARY_PROVIDER_SECRET_7f31e9",
  password: "BC_CANARY_PASSWORD_FIELD_a48c11",
  script: "BC_CANARY_SCRIPT_TEXT_39dd72",
  hidden: "BC_CANARY_HIDDEN_TEXT_12ba60",
  unselected: "BC_CANARY_UNSELECTED_TAB_65fce2",
  history: "BC_CANARY_UNRELATED_HISTORY_2cb740",
  skill: "BC_CANARY_UNRELATED_SKILL_e2719d"
});
const forbiddenInTaskOrModel = Object.values(CANARY);

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const fixtureServer = await startFixtureServer();
const providerServer = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-privacy-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, [fixtureServer.origin, providerServer.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(serviceWorker.url()).host;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedUnrelatedLocalMemory(panel);

  const unselectedPage = await context.newPage();
  await unselectedPage.goto(`${fixtureServer.origin}/unselected.html`);
  const selectedPage = await context.newPage();
  await selectedPage.goto(`${fixtureServer.origin}/privacy.html`);

  await configureProviderWithSecret(panel, providerServer.origin);
  pass("Provider secret was accepted through the normal session-only AI setup path");

  await panel.getByRole("tab", { name: "Workspace" }).click();
  await selectActivePageFromPanel(panel, selectedPage, "Privacy Product Fixture");
  await panel.locator("#goalInput").fill("Find the product name and price on this page.");
  await panel.locator("#runButton").click();
  await panel.locator("#resultCard").waitFor({ state: "visible", timeout: timeoutMs });
  await waitForText(panel.locator("#resultGrid"), "Privacy Lamp");
  await waitForText(panel.locator("#resultGrid"), "$77.00");
  pass("Selected-page read completed with only the intended visible product facts");

  const requests = providerServer.requests;
  assert.ok(requests.length >= 2, "Expected connection-test and task provider requests.");
  assert.ok(requests.every((request) => request.authorization === `Bearer ${CANARY.provider}`), "Provider secret should be used only as the chosen endpoint authorization credential in this test.");
  const requestBodies = requests.map((request) => request.body).join("\n");
  for (const canary of forbiddenInTaskOrModel) {
    assert.equal(requestBodies.includes(canary), false, "A privacy canary leaked into a model request body.");
  }
  assert.match(requestBodies, /Privacy Lamp/);
  assert.match(requestBodies, /\$77\.00/);
  pass("Instrumented model request bodies excluded provider, password, hidden/script, unselected-tab, history, and skill canaries");

  const storage = await panel.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null)
  }));
  const localText = JSON.stringify(storage.local);
  const sessionText = JSON.stringify(storage.session);
  assert.equal(localText.includes(CANARY.provider), false, "Provider secret must not be written to chrome.storage.local.");
  assert.equal(sessionText.includes(CANARY.provider), true, "Provider secret should remain available only in session storage for the configured session.");

  const tasks = storage.local["browsercrew.tasks.v1"] || [];
  const createdTask = tasks.find((task) => task.id !== "privacy-seeded-history" && task.goal === "Find the product name and price on this page.");
  assert.ok(createdTask, "Privacy smoke could not find the newly completed read task.");
  const createdTaskText = JSON.stringify(createdTask);
  for (const canary of forbiddenInTaskOrModel) {
    assert.equal(createdTaskText.includes(canary), false, "A privacy canary leaked into the newly created durable task/evidence record.");
  }
  assert.equal(createdTask.status, "completed");
  pass("Durable task/evidence history excluded all seeded privacy canaries and the raw provider credential");

  const resultText = await panel.locator("#resultCard").innerText();
  for (const canary of forbiddenInTaskOrModel) {
    assert.equal(resultText.includes(canary), false, "A privacy canary leaked into the visible result receipt.");
  }
  pass("Visible result receipt exposed no seeded secret or out-of-scope canary");

  assert.equal(requestBodies.includes(CANARY.history), false, "Unrelated task history must not be automatically added to a model request.");
  assert.equal(requestBodies.includes(CANARY.skill), false, "Unrelated saved skills must not be automatically added to a model request.");
  assert.equal(requestBodies.includes(CANARY.unselected), false, "Text from an unselected tab must not be sent to the model.");
  pass("Unrelated local memory and unselected tabs stayed outside the active model context");

  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const artifactText = await readFile(join(artifactDir, "report.json"), "utf8");
  for (const canary of forbiddenInTaskOrModel) {
    assert.equal(artifactText.includes(canary), false, "Privacy smoke artifact must not serialize raw canary values.");
  }
  console.log("BrowserCrew seeded privacy smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: "Privacy smoke failed; inspect the assertion without printing seeded secret values." };
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixtureServer.close();
  await providerServer.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) {
  report.checks.push({ name, at: new Date().toISOString() });
}

async function seedUnrelatedLocalMemory(panel) {
  await panel.evaluate(({ historyCanary, skillCanary }) => chrome.storage.local.set({
    "browsercrew.tasks.v1": [{
      id: "privacy-seeded-history", schemaVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      goal: `Unrelated private history ${historyCanary}`, status: "completed", selectedResource: null, providerRef: null,
      checkpoint: "completed", journal: [], result: { note: historyCanary }, error: null
    }],
    "browsercrew.skills.v1": [{
      id: "privacy-seeded-skill", schemaVersion: 1, name: "Private local skill", goal: `Unrelated private skill ${skillCanary}`,
      mode: "read_only", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
  }), { historyCanary: CANARY.history, skillCanary: CANARY.skill });
}

async function configureProviderWithSecret(panel, providerOrigin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /OpenAI API/ }).click();
  await panel.locator("#modelInput").fill("browsercrew-privacy-smoke");
  await panel.locator("#serverInput").fill(`${providerOrigin}/v1`);
  await panel.locator("#apiKeyInput").fill(CANARY.provider);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  assert.match(await panel.locator("#aiStatus").innerText(), /Connected/i);
}

async function selectActivePageFromPanel(panel, targetPage, expectedTitle) {
  await targetPage.bringToFront();
  await panel.evaluate(() => document.querySelector("#selectTabButton")?.click());
  await waitForText(panel.locator("#selectedTabSummary"), expectedTitle);
  assert.equal(await panel.locator("#pageStatus").getAttribute("data-state"), "ok");
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for expected UI text.`);
}

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer() {
  const selectedHtml = `<!doctype html><html><head><title>Privacy Product Fixture</title></head><body>
    <main><h1>Privacy Lamp</h1><p>Price: $77.00</p>
    <input type="password" value="${CANARY.password}" aria-label="Account password" />
    <div style="display:none">${CANARY.hidden}</div>
    <script>window.__fixturePrivate = ${JSON.stringify(CANARY.script)};</script></main>
  </body></html>`;
  const unselectedHtml = `<!doctype html><html><head><title>Unselected Private Tab</title></head><body><main>${CANARY.unselected}</main></body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const html = url.pathname === "/privacy.html" ? selectedHtml : url.pathname === "/unselected.html" ? unselectedHtml : null;
    if (!html) {
      response.writeHead(404, { "Content-Type": "text/plain" }); response.end("Not found"); return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
  });
  return listen(server, []);
}

async function startProviderServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "Not found" } })); return;
    }
    const raw = await readBody(request);
    requests.push({ authorization: String(request.headers.authorization || ""), body: raw });
    const body = JSON.parse(raw);
    const system = String(body.messages?.find((message) => message.role === "system")?.content || "");
    const content = /Reply with exactly/i.test(system)
      ? "BrowserCrew connection works"
      : JSON.stringify({ items: [{ label: "Product name", value: "Privacy Lamp" }, { label: "Price", value: "$77.00" }], notes: "Verified fixture facts." });
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({
      id: `privacy-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model || "browsercrew-privacy-smoke",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }));
  });
  return listen(server, requests);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server, requests) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ origin: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
