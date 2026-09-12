import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "connections-smoke");
const timeoutMs = 30_000;
const SECRET_CANARY = "CONNECTION_SECRET_CANARY_51cb72";

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const providerA = await startProviderServer("Local A");
const providerB = await startProviderServer("Cloud B");
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-connections-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, [providerA.origin, providerB.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  let panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.locator("#connectionRegistryCard").waitFor({ state: "visible", timeout: timeoutMs });

  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#modelInput").fill("model-a");
  await panel.locator("#serverInput").fill(`${providerA.origin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  await panel.locator("#connectionNameInput").fill("Local A");
  await panel.locator("#saveConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  await waitForText(panel.locator("#connectionList"), "Local A");
  pass("Migrated the existing provider setup into a named Local A connection and tested it");

  await panel.locator("#newConnectionButton").click();
  await panel.getByRole("radio", { name: /OpenAI API/ }).click();
  await panel.locator("#connectionNameInput").fill("Cloud B");
  await panel.locator("#modelInput").fill("model-b");
  await panel.locator("#serverInput").fill(`${providerB.origin}/v1`);
  await panel.locator("#apiKeyInput").fill(SECRET_CANARY);
  await panel.locator("#saveConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  await waitForText(panel.locator("#connectionList"), "Cloud B");
  assert.equal(await panel.locator("#connectionList .connection-item").count(), 2, "C2 should keep two named AI connections.");
  pass("Saved and tested a second named AI connection with explicit connected status");

  const storage = await panel.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null)
  }));
  assert.equal(JSON.stringify(storage.local).includes(SECRET_CANARY), false, "Connection secret must not be stored in durable local storage.");
  assert.equal(JSON.stringify(storage.session).includes(SECRET_CANARY), true, "Connection secret should stay available in Chrome session storage.");
  pass("Named connection secrets stayed out of durable local storage");

  await panel.getByRole("tab", { name: "Chat" }).click();
  await waitForText(panel.locator("#chatConnectionPicker"), "Cloud B");
  assert.match(await panel.locator("#chatConnectionPicker").inputValue(), /.+/);
  assert.match(await panel.locator("#chatModelName").innerText(), /model-b/i);
  await panel.locator("#chatInput").fill("Which connection is answering?");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Reply from Cloud B.");
  pass("Chat used the active Cloud B profile without leaving the conversation");

  const localAOption = panel.locator("#chatConnectionPicker option", { hasText: "Local A" });
  const localAId = await localAOption.getAttribute("value");
  await panel.locator("#chatConnectionPicker").selectOption(localAId);
  await panel.locator("#connectionTransferReview").waitFor({ state: "visible", timeout: timeoutMs });
  const reviewText = await panel.locator("#connectionTransferReview").innerText();
  assert.match(reviewText, /existing conversation/i);
  assert.match(reviewText, /Local A/i);
  await panel.locator("#confirmConnectionSwitchButton").click();
  await waitUntil(async () => (await panel.locator("#chatConnectionPicker").inputValue()) === localAId, "Local A should become the selected Chat connection after approval.");
  await waitForText(panel.locator("#chatModelName"), "model-a");
  pass("Switching a populated chat required explicit context-transfer review before changing providers");

  await panel.locator("#chatInput").fill("And now?");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Reply from Local A.");
  assert.ok(providerA.chatRequests >= 1, "Local A should receive a Chat request after the approved switch.");
  assert.ok(providerB.chatRequests >= 1, "Cloud B should have received the earlier Chat request.");
  pass("The approved model switch changed the provider used by the next Chat message");

  await panel.close();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Chat" }).click();
  await waitForText(panel.locator("#chatConnectionPicker"), "Local A");
  assert.equal(await panel.locator("#chatConnectionPicker").inputValue(), localAId);
  await waitForText(panel.locator("#chatMessages"), "Reply from Local A.");
  pass("Named connections, active selection, and conversation survived side-panel close and reopen");

  await panel.screenshot({ path: join(artifactDir, "connections-c2.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew C2 named-connection installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await providerA.close();
  await providerB.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

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

async function startProviderServer(name) {
  const state = { chatRequests: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "Not found" } })); return;
    }
    const body = JSON.parse(await readBody(request));
    if (!body.stream) {
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({ model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "BrowserCrew connection works" }, finish_reason: "stop" }] }));
      return;
    }
    state.chatRequests += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const content = `Reply from ${name}.`;
    response.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  });
  return listen(server, state);
}

function listen(server, state) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ origin: `http://127.0.0.1:${address.port}`, ...state, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function waitForText(locator, text) {
  await waitUntil(async () => (await locator.innerText().catch(() => "")).includes(text), `Timed out waiting for text: ${text}`);
}

async function waitUntil(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
