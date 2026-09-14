import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "browser-control-smoke");
const timeoutMs = 40_000;
const VISIBLE_CANARY = "CONTROL_VISIBLE_CANARY_79b1";
const SECRET_CANARY = "CONTROL_SECRET_CANARY_4e2d";
const PENDING_APPROVAL_KEY = "browsercrew.browserControlPendingApproval.v1";
const CHAT_STORAGE_KEY = "browsercrew.conversations.v1";

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const fixtureServer = await startFixtureServer();
const providerServer = await startProviderServer(`${fixtureServer.origin}/second.html`);
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-control-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { kind: "browsercrew.browser_control_smoke", startedAt: new Date().toISOString(), checks: [] };

try {
  await prepareTestExtension(extensionDir);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await configureLocalProvider(panel, providerServer.origin);

  const target = await context.newPage();
  await target.goto(`${fixtureServer.origin}/control.html`);
  const targetTabId = await resolveTabId(panel, `${fixtureServer.origin}/control.html`);
  providerServer.setTargetTabId(targetTabId);

  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#browserControlStatus").click();
  await waitForText(panel.locator("#browserControlStatus"), "ON");
  assert.equal(await panel.locator("#browserControlStatus").getAttribute("aria-pressed"), "true");
  pass("Browser control required an explicit user activation and became visibly ON");

  await panel.locator("#chatInput").fill("Browser control flow: inspect the test page, type the note, apply it, open the second page, then tell me when finished.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Browser control finished");

  const pageState = await target.evaluate(() => ({
    note: document.querySelector("#taskNote")?.value,
    result: document.querySelector("#result")?.textContent,
    applyClicks: window.__browserCrewApplyClicks || 0,
    dangerClicks: window.__browserCrewDangerClicks || 0
  }));
  assert.equal(pageState.note, "BrowserCrew was here");
  assert.equal(pageState.result, "BrowserCrew was here");
  assert.equal(pageState.applyClicks, 1, "The approved ordinary click should run exactly once.");
  assert.equal(pageState.dangerClicks, 0);
  assert.ok(context.pages().some((page) => page.url() === `${fixtureServer.origin}/second.html`), "Browser control should be able to open a new normal website tab.");
  pass("One Chat request iteratively observed, typed, clicked, and opened a new tab through verified browser actions");

  const controlRequests = providerServer.requests.filter((item) => item.stream && /Browser control flow/i.test(item.userText));
  assert.ok(controlRequests.length >= 6, "The provider should receive multiple model turns across the browser-control loop.");
  const firstTool = controlRequests[0].body.tools?.find((tool) => tool.function?.name === "browsercrew_browser_control")?.function;
  assert.ok(firstTool, "Browser control must be offered as an explicit model tool only while the session grant is ON.");
  assert.ok(firstTool.parameters?.properties?.action?.enum?.includes("open_tab"));
  assert.equal(Object.prototype.hasOwnProperty.call(firstTool.parameters?.properties || {}, "approvedConsequential"), false, "The model must never receive an approval-bypass argument.");
  const observedToolText = controlRequests.filter((item) => item.toolText).map((item) => item.toolText).join("\n");
  assert.ok(observedToolText.includes(VISIBLE_CANARY), "The model should receive bounded visible page context from observe.");
  assert.equal(observedToolText.includes(SECRET_CANARY), false, "Browser observation must not expose password-field secrets to the model.");

  await panel.locator("#chatActivityToggle").click();
  await waitForText(panel.locator("#chatActivityList"), "Browser control is ON");
  await waitForText(panel.locator("#chatActivityList"), "Verified completion");
  const durable = await panel.evaluate(() => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(durable).includes(VISIBLE_CANARY), false, "Raw browser observation text must not be persisted in durable local storage.");
  assert.equal(JSON.stringify(durable).includes(SECRET_CANARY), false, "Secret page values must never become durable BrowserCrew state.");
  pass("Browser actions were visible in activity while raw observations and secret values stayed out of durable storage");

  await panel.locator("#chatNewButton").click();
  await target.bringToFront();
  await panel.bringToFront();
  await panel.locator("#chatInput").fill("Dangerous action test: inspect the page and click Delete account, then verify what happened.");
  await panel.locator("#chatSendButton").click();
  await waitForText(panel.locator("#chatMessages"), "Paused for confirmation");
  await panel.locator("#browserControlApproval").waitFor({ state: "visible", timeout: timeoutMs });
  await waitForText(panel.locator("#browserControlApprovalAction"), "Delete account");
  await waitForText(panel.locator("#browserControlApprovalSite"), new URL(fixtureServer.origin).hostname);
  assert.equal(await panel.evaluate(() => document.activeElement?.id || ""), "browserControlApprovalCancel", "Consequential approval should focus Cancel by default.");
  const afterDanger = await target.evaluate(() => window.__browserCrewDangerClicks || 0);
  assert.equal(afterDanger, 0, "Consequential click must not execute without a separate confirmation path.");
  assert.ok(providerServer.requests.some((item) => item.toolText.includes("CONFIRMATION_REQUIRED")), "The model should receive an explicit confirmation-required result.");
  const pendingApproval = await panel.evaluate(async (key) => (await chrome.storage.session.get(key))[key] || null, PENDING_APPROVAL_KEY);
  assert.ok(pendingApproval?.id, "A consequential click should create one pending session approval.");
  assert.equal(pendingApproval.tabId, targetTabId);
  assert.equal(pendingApproval.url, `${fixtureServer.origin}/control.html`);
  assert.equal(pendingApproval.label, "Delete account");
  assert.equal(JSON.stringify(pendingApproval).includes(VISIBLE_CANARY), false);
  assert.equal(JSON.stringify(pendingApproval).includes(SECRET_CANARY), false);
  const dangerConversationId = await panel.locator("#chatConversationSelect").inputValue();
  assert.ok(dangerConversationId, "The pending approval must originate from a concrete saved Chat.");
  pass("Browser control paused before a consequential click and created only a narrow session approval");

  await panel.locator("#browserControlApprovalApprove").click();
  await panel.locator("#browserControlApproval").waitFor({ state: "hidden", timeout: timeoutMs });
  await target.waitForFunction(() => window.__browserCrewDangerClicks === 1, null, { timeout: timeoutMs });
  await waitForText(panel.locator("#chatMessages"), "Approved action verified");
  const afterApproval = await target.evaluate(() => ({
    dangerClicks: window.__browserCrewDangerClicks || 0,
    dangerResult: document.querySelector("#dangerResult")?.textContent || ""
  }));
  assert.equal(afterApproval.dangerClicks, 1, "Approve once should execute the exact consequential click exactly once.");
  assert.equal(afterApproval.dangerResult, "Account deletion request accepted.");
  const pendingAfterApproval = await panel.evaluate(async (key) => (await chrome.storage.session.get(key))[key] || null, PENDING_APPROVAL_KEY);
  assert.equal(pendingAfterApproval, null, "The one-time approval must be consumed before the click executes.");
  const replay = await panel.evaluate(async (approvalId) => chrome.runtime.sendMessage({ type: "APPROVE_BROWSER_CONTROL_ACTION", approvalId }), pendingApproval.id);
  assert.equal(replay?.ok, false, "A consumed approval id must not be reusable.");
  assert.equal(await target.evaluate(() => window.__browserCrewDangerClicks || 0), 1, "Replaying a consumed approval must not click again.");

  const resumeRequests = providerServer.requests.filter((item) => /Dangerous action test/i.test(item.userText) && /internal continuation after a user-approved browser action/i.test(item.systemText));
  assert.ok(resumeRequests.length >= 2, "Approving once should start a fresh tool-enabled model turn for the same task.");
  assert.ok(resumeRequests.every((item) => /do not repeat it/i.test(item.systemText)), "Every resumed model turn must be told not to repeat the approved action.");
  assert.ok(resumeRequests.some((item) => item.toolText.includes("Account deletion request accepted.")), "The resumed agent must re-observe the changed page before declaring success.");
  assert.equal(resumeRequests.some((item) => item.toolText.includes("CONFIRMATION_REQUIRED")), false, "The resumed agent must not request the approved dangerous click again.");

  const chatsAfterResume = await panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key] || [], CHAT_STORAGE_KEY);
  const dangerConversation = chatsAfterResume.find((item) => item.id === dangerConversationId);
  assert.ok(dangerConversation, "The originating Chat must remain available after automatic continuation.");
  const dangerUserMessages = (dangerConversation.messages || []).filter((item) => item.role === "user");
  assert.equal(dangerUserMessages.length, 1, "Automatic approval continuation must not fabricate a second user message.");
  assert.match(dangerUserMessages[0].text, /Dangerous action test/i);
  assert.equal(dangerUserMessages.some((item) => /continue after|approved action/i.test(item.text) && !/Dangerous action test/i.test(item.text)), false, "No hidden continuation text may appear as a durable user message.");
  assert.ok((dangerConversation.activity || []).some((item) => item.type === "browser_approval_resume"), "The automatic continuation must be visible in Chat activity.");
  pass("Approve once executed exactly once, resumed the originating Chat, re-observed the result, and finished without a synthetic user message");

  const resumesBeforeCancel = providerServer.requests.filter((item) => /internal continuation after a user-approved browser action/i.test(item.systemText)).length;
  await panel.locator("#chatNewButton").click();
  await target.bringToFront();
  await panel.bringToFront();
  await panel.locator("#chatInput").fill("Dangerous action test: inspect the page and click Delete account.");
  await panel.locator("#chatSendButton").click();
  await panel.locator("#browserControlApproval").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#browserControlApprovalCancel").click();
  await panel.locator("#browserControlApproval").waitFor({ state: "hidden", timeout: timeoutMs });
  await panel.waitForTimeout(350);
  assert.equal(await target.evaluate(() => window.__browserCrewDangerClicks || 0), 1, "Cancel must leave the consequential action untouched.");
  assert.equal(await panel.evaluate(async (key) => (await chrome.storage.session.get(key))[key] || null, PENDING_APPROVAL_KEY), null);
  const resumesAfterCancel = providerServer.requests.filter((item) => /internal continuation after a user-approved browser action/i.test(item.systemText)).length;
  assert.equal(resumesAfterCancel, resumesBeforeCancel, "Cancel must not trigger an automatic Chat continuation.");
  pass("Cancel discarded the pending consequential action without executing or resuming it");

  await panel.locator("#chatNewButton").click();
  await panel.locator("#chatInput").fill("Revocation test: wait, then inspect the test page.");
  await panel.locator("#chatSendButton").click();
  await panel.locator("#chatStopButton").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#browserControlStatus").click();
  await waitForText(panel.locator("#browserControlStatus"), "Off");
  await waitForText(panel.locator("#chatMessages"), "Browser control is off");
  assert.equal(await panel.locator("#browserControlStatus").getAttribute("aria-pressed"), "false");
  assert.ok(providerServer.requests.some((item) => item.toolText.includes("BROWSER_CONTROL_OFF")), "Turning control off during a run must block the next action at dispatch time.");
  pass("Turning Browser control off during a running Chat revoked the next browser action immediately");

  await panel.screenshot({ path: join(artifactDir, "browser-control-chat.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew browser-control installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await providerServer.close();
  await fixtureServer.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function prepareTestExtension(target) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "artifacts"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function configureLocalProvider(panel, origin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.locator("#connectionNameInput").fill("Browser control smoke");
  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#modelInput").fill("browsercrew-control-smoke");
  await panel.locator("#serverInput").fill(`${origin}/v1`);
  await panel.locator("#saveConnectionButton").click();
  await waitForText(panel.locator("#connectionList"), "Connected");
  await panel.locator("#aiSetupCloseButton").click();
  await panel.locator("#view-chat").waitFor({ state: "visible", timeout: timeoutMs });
}

async function resolveTabId(panel, url) {
  const tab = await panel.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((item) => item.url === targetUrl) || null;
  }, url);
  assert.ok(tab?.id, `Could not resolve Chrome tab id for ${url}`);
  return tab.id;
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/second.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end("<!doctype html><html><head><title>Second control page</title></head><body><main><h1>Second control page</h1><p>BrowserCrew opened this tab.</p></main></body></html>");
      return;
    }
    if (url.pathname !== "/control.html") { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><title>Browser control fixture</title></head><body>
      <main>
        <h1>Browser control fixture</h1>
        <p>${VISIBLE_CANARY}</p>
        <label>Task note <input id="taskNote" name="task-note" placeholder="Task note" /></label>
        <button id="applyButton" type="button">Apply note</button>
        <p id="result">Waiting</p>
        <label>Password <input id="password" type="password" value="${SECRET_CANARY}" /></label>
        <button id="dangerButton" type="button">Delete account</button>
        <p id="dangerResult">No deletion request.</p>
      </main>
      <script>
        window.__browserCrewApplyClicks = 0;
        window.__browserCrewDangerClicks = 0;
        document.querySelector('#applyButton').addEventListener('click',()=>{window.__browserCrewApplyClicks += 1;document.querySelector('#result').textContent=document.querySelector('#taskNote').value;});
        document.querySelector('#dangerButton').addEventListener('click',()=>{window.__browserCrewDangerClicks += 1;document.querySelector('#dangerResult').textContent='Account deletion request accepted.';});
      </script>
    </body></html>`);
  });
  return listen(server);
}

async function startProviderServer(secondUrl) {
  const state = { requests: [], targetTabId: null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "Not found" } })); return;
    }
    const body = JSON.parse(await readBody(request));
    const userText = String([...(body.messages || [])].reverse().find((message) => message.role === "user")?.content || "");
    const systemText = String((body.messages || []).find((message) => message.role === "system")?.content || "");
    const toolMessages = (body.messages || []).filter((message) => message.role === "tool");
    const lastTool = toolMessages.at(-1);
    const toolText = String(lastTool?.content || "");
    state.requests.push({ body, stream: body.stream === true, userText, systemText, toolText, toolCount: toolMessages.length });

    if (!body.stream) {
      sendJson(response, body.model, "BrowserCrew connection works");
      return;
    }

    if (/Browser control flow/i.test(userText)) {
      const count = toolMessages.length;
      if (count === 0) return sendToolCall(response, body.model, { action: "observe", tabId: state.targetTabId });
      if (count === 1) {
        const observed = parseTool(lastTool);
        const ref = findRef(observed, "Task note");
        return sendToolCall(response, body.model, { action: "type", tabId: state.targetTabId, ref, text: "BrowserCrew was here", clearFirst: true });
      }
      if (count === 2) return sendToolCall(response, body.model, { action: "observe", tabId: state.targetTabId });
      if (count === 3) {
        const observed = parseTool(lastTool);
        const ref = findRef(observed, "Apply note");
        return sendToolCall(response, body.model, { action: "click", tabId: state.targetTabId, ref });
      }
      if (count === 4) return sendToolCall(response, body.model, { action: "open_tab", url: secondUrl });
      return sendSseContent(response, body.model, "Browser control finished. I inspected the page, entered the note, applied it, and opened the second page.");
    }

    if (/Dangerous action test/i.test(userText)) {
      const count = toolMessages.length;
      const resumed = /internal continuation after a user-approved browser action/i.test(systemText);
      if (resumed) {
        if (count === 0) return sendToolCall(response, body.model, { action: "observe", tabId: state.targetTabId });
        if (count === 1) {
          const observed = parseTool(lastTool);
          if (!String(observed?.page?.text || "").includes("Account deletion request accepted.")) {
            return sendSseContent(response, body.model, "Approved action verification failed because the changed page state was not visible.");
          }
          return sendSseContent(response, body.model, "Approved action verified. The account deletion request was accepted, and I did not repeat the approved click.");
        }
        return sendSseContent(response, body.model, "Approved action resume exceeded the expected verification steps.");
      }
      if (count === 0) return sendToolCall(response, body.model, { action: "observe", tabId: state.targetTabId });
      if (count === 1) {
        const observed = parseTool(lastTool);
        const ref = findRef(observed, "Delete account");
        return sendToolCall(response, body.model, { action: "click", tabId: state.targetTabId, ref });
      }
      return sendSseContent(response, body.model, "Paused for confirmation. BrowserCrew did not click Delete account.");
    }

    if (/Revocation test/i.test(userText)) {
      if (!toolMessages.length) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (response.destroyed) return;
        return sendToolCall(response, body.model, { action: "observe", tabId: state.targetTabId });
      }
      return sendSseContent(response, body.model, "Browser control is off. I did not start another browser action.");
    }

    sendSseContent(response, body.model, "No browser-control scenario matched.");
  });
  const bound = await listen(server);
  return {
    ...bound,
    setTargetTabId(value) { state.targetTabId = value; },
    get requests() { return state.requests; }
  };
}

function parseTool(message) {
  try { return JSON.parse(String(message?.content || "{}")); } catch { return {}; }
}

function findRef(observation, label) {
  const found = observation?.page?.elements?.find((item) => String(item.label || "").includes(label));
  if (!found?.ref) throw new Error(`Provider fixture could not find browser element ref for ${label}`);
  return found.ref;
}

function sendJson(response, model, content) {
  response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify({ model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
}

function sendToolCall(response, model, args) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
  response.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `control-${Date.now()}`, type: "function", function: { name: "browsercrew_browser_control", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendSseContent(response, model, content) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
  response.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function waitForText(locator, text) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}
