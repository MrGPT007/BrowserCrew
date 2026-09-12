import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "chat-smoke");
const timeoutMs = 30_000;
const CANARY = {
  hidden: "CHAT_HIDDEN_CANARY_7bd31f",
  script: "CHAT_SCRIPT_CANARY_d11a82",
  password: "CHAT_PASSWORD_CANARY_e06c19"
};

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const provider = await startProviderServer();
const fixture = await startFixtureServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-chat-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir, [provider.origin, fixture.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(serviceWorker.url()).host;

  let panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#modelInput").fill("browsercrew-chat-smoke");
  await panel.locator("#serverInput").fill(`${provider.origin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
  pass("Existing Connect AI setup configured the model used by Chat");

  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#chatInput").waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(await panel.locator("#chatModelName").innerText(), /browsercrew-chat-smoke/i);
  pass("Chat opened as a first-class side-panel view with the configured model visible");

  await panel.keyboard.press("Control+k");
  await panel.locator("#commandPalette").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#commandSearch").fill("Live Activity");
  assert.match(await panel.locator("#commandList").innerText(), /Open Live Activity/i);
  await panel.keyboard.press("Escape");
  assert.equal(await panel.locator("#commandPalette").isHidden(), true);
  pass("Ctrl+K opened the keyboard-first global command bar");

  await panel.locator("#chatInput").fill("Say hello.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatStreamingMessage"), "Hello ");
  assert.equal(await panel.locator("#chatStopButton").isVisible(), true, "Stop should replace Send while streaming.");
  await waitForText(panel.locator("#chatMessages"), "Hello from BrowserCrew.");
  await waitUntil(async () => await panel.locator("#chatStopButton").isHidden(), "Stop button should hide after completion.");
  pass("Chat streamed a model response and exposed Stop while the run was active");

  const page = await context.newPage();
  await page.goto(`${fixture.origin}/page.html`);
  await panel.locator("#chatUseCurrentPage").check();
  await panel.locator("#chatInput").fill("What product and price are on this page?");
  await page.bringToFront();
  await panel.evaluate(() => document.querySelector("#chatSendButton")?.click());
  await waitForText(panel.locator("#chatMessages"), "Visible Chat Lamp costs $88.");
  const bodies = provider.requestBodies.join("\n");
  assert.ok(bodies.includes("Visible Chat Lamp"), "Approved visible page context should reach the selected model.");
  assert.ok(!bodies.includes(CANARY.hidden), "Hidden page text must not reach Chat model context.");
  assert.ok(!bodies.includes(CANARY.script), "Script text must not reach Chat model context.");
  assert.ok(!bodies.includes(CANARY.password), "Password values must not reach Chat model context.");
  pass("Current-page Chat context sent bounded visible text and excluded hidden/script/password canaries");

  await panel.close();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("tab", { name: "Chat" }).click();
  await waitForText(panel.locator("#chatMessages"), "Visible Chat Lamp costs $88.");
  await panel.locator("#chatActivityToggle").click();
  await waitForText(panel.locator("#chatActivityList"), "Current-page context is ready");
  assert.match(await panel.locator("#chatActivityList").innerText(), /Saved|Response complete|Model finished/i);
  pass("Conversation transcript and Live Activity survived side-panel close and reopen");

  await panel.locator("#chatUseCurrentPage").uncheck();
  await panel.locator("#chatInput").fill("Please give a slow response.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatStreamingMessage"), "Working");
  await panel.locator("#chatStopButton").click();
  await waitForText(panel.locator("#chatRunStatus"), "Stopped");
  await waitForText(panel.locator("#chatActivityList"), "Stopped. BrowserCrew will not start another model step");
  pass("Stop aborted an in-flight streamed response and recorded the stopped state");

  const beforeNewChat = await panel.locator("#chatConversationSelect").inputValue();
  await panel.keyboard.press("Control+k");
  await panel.locator("#commandSearch").fill("New chat");
  await panel.keyboard.press("Enter");
  await waitUntil(async () => {
    const value = await panel.locator("#chatConversationSelect").inputValue();
    return Boolean(value && value !== beforeNewChat);
  }, "Ctrl+K New chat should create and select a new saved conversation.");
  assert.equal((await panel.locator("#chatMessages").innerText()).trim(), "");
  pass("Ctrl+K executed New chat without bypassing the normal Chat surface");

  await panel.screenshot({ path: join(artifactDir, "chat-c1.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew C1 Chat installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await provider.close();
  await fixture.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) {
  report.checks.push({ name, at: new Date().toISOString() });
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
  const html = `<!doctype html><html><head><title>Chat Privacy Fixture</title></head><body>
    <main><h1>Visible Chat Lamp</h1><p>Price: $88.</p></main>
    <div hidden>${CANARY.hidden}</div>
    <input type="password" value="${CANARY.password}">
    <script>window.__chatCanary = "${CANARY.script}";</script>
  </body></html>`;
  const server = createServer((request, response) => {
    if (new URL(request.url || "/", "http://127.0.0.1").pathname !== "/page.html") {
      response.writeHead(404); response.end("Not found"); return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
  });
  return listen(server, {});
}

async function startProviderServer() {
  const state = { requestBodies: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }
    const raw = await readBody(request);
    state.requestBodies.push(raw);
    const body = JSON.parse(raw);
    const joined = JSON.stringify(body.messages || []);

    if (!body.stream) {
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({
        id: `chat-connect-${Date.now()}`,
        object: "chat.completion",
        model: body.model || "browsercrew-chat-smoke",
        choices: [{ index: 0, message: { role: "assistant", content: "BrowserCrew connection works" }, finish_reason: "stop" }]
      }));
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    const send = (content) => response.write(`data: ${JSON.stringify({ model: body.model || "browsercrew-chat-smoke", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);

    if (/slow response/i.test(joined)) {
      send("Working");
      const timer = setTimeout(() => {
        if (!response.destroyed) { send(" longer than expected."); response.write("data: [DONE]\n\n"); response.end(); }
      }, 5000);
      request.on("close", () => clearTimeout(timer));
      return;
    }

    const parts = joined.includes("Visible Chat Lamp")
      ? ["Visible Chat Lamp ", "costs $88."]
      : ["Hello ", "from BrowserCrew."];
    send(parts[0]);
    setTimeout(() => {
      if (response.destroyed) return;
      send(parts[1]);
      response.write("data: [DONE]\n\n");
      response.end();
    }, 350);
  });
  return listen(server, state);
}

function listen(server, state) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        ...state,
        close: () => new Promise((done) => server.close(() => done()))
      });
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
