import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "workspace-stop-smoke");
const timeoutMs = 30_000;
const report = { startedAt: new Date().toISOString(), checks: [] };

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const fixture = await startFixtureServer();
const provider = await startProviderServer();
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-workspace-stop-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;

try {
  await prepareTestExtension(extensionDir, [fixture.origin, provider.origin]);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await configureLocalProvider(panel, provider.origin);

  const target = await context.newPage();
  await target.goto(`${fixture.origin}/read.html`);
  await selectActivePage(panel, target);

  const stopGoal = "Stop the slow read and find the product name and price.";
  await runReadJob(panel, stopGoal);
  await waitUntil(() => provider.taskRequests.length === 1, 8_000, () => JSON.stringify(provider.snapshot()));
  const stopEntry = provider.taskRequests[0];
  await panel.locator("#stopButton").click({ force: true });
  await waitUntil(() => stopEntry.aborted, 3_000, () => JSON.stringify(provider.snapshot()));
  const stoppedTask = await waitForTask(panel, stopGoal, (task) => task.status === "cancelled" && task.error?.code === "TASK_CANCELLED");
  assert.equal(stoppedTask.result, null, "Stopped Workspace task must not save a completed result.");
  assert.ok(stoppedTask.journal.some((entry) => entry.type === "provider.intent"), "The slow provider request must have started before Stop.");
  assert.equal(stoppedTask.journal.some((entry) => entry.type === "provider.complete"), false, "No provider-complete checkpoint may be written after Stop aborts the request.");
  assert.notEqual(stoppedTask.error?.code, "PROVIDER_TIMEOUT", "User Stop must not be misclassified as a provider timeout.");
  pass("Stop closed the in-flight provider request and preserved the task as cancelled", {
    status: stoppedTask.status,
    checkpoint: stoppedTask.checkpoint,
    error: stoppedTask.error,
    provider: provider.snapshot()
  });

  await panel.getByRole("tab", { name: "Workspace" }).click();
  const pauseGoal = "Pause the slow read and find the product name and price.";
  await panel.locator("#goalInput").fill(pauseGoal);
  await panel.locator("#runButton").click();
  await waitUntil(() => provider.taskRequests.length === 2, 8_000, () => JSON.stringify(provider.snapshot()));
  const pauseEntry = provider.taskRequests[1];
  await panel.locator("#pauseButton").click({ force: true });
  await waitUntil(() => pauseEntry.completed, 5_000, () => JSON.stringify(provider.snapshot()));
  assert.equal(pauseEntry.aborted, false, "Pause must not abort the current provider request.");
  const pausedTask = await waitForTask(panel, pauseGoal, (task) => task.status === "paused"
    && task.journal.some((entry) => entry.type === "provider.complete")
    && task.error?.code === "TASK_PAUSED");
  assert.equal(pausedTask.result, null, "Paused task must not continue into final verification/completion.");
  assert.equal(pausedTask.error?.code, "TASK_PAUSED");
  pass("Pause let the current provider step finish, then blocked the next step", {
    status: pausedTask.status,
    checkpoint: pausedTask.checkpoint,
    error: pausedTask.error,
    provider: provider.snapshot()
  });

  await panel.getByRole("tab", { name: "History" }).click();
  await waitForText(panel.locator("#historyList"), stopGoal);
  const historyText = await panel.locator("#historyList").innerText();
  assert.match(historyText, /Cancelled/i);
  assert.match(historyText, /Paused/i);
  pass("Cancelled and paused Workspace tasks remained inspectable in History");

  await panel.screenshot({ path: join(artifactDir, "workspace-stop.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew REL-01 installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  report.provider = provider.snapshot();
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  if (context) {
    const panel = context.pages().find((page) => page.url().includes("sidepanel.html"));
    if (panel) await panel.screenshot({ path: join(artifactDir, "workspace-stop-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await fixture.close();
  await provider.close();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name, details = null) { report.checks.push({ name, details, at: new Date().toISOString() }); }

async function prepareTestExtension(target, origins) {
  await cp(repoRoot, target, { recursive: true, filter: (source) => {
    const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
    if (!relative) return true;
    return ![".git", "node_modules", "artifacts"].includes(relative.split(/[/\\]/)[0]);
  }});
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = origins.map((origin) => `${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function configureLocalProvider(panel, origin) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  await panel.getByRole("radio", { name: /LM Studio/ }).click();
  await panel.locator("#modelInput").fill("workspace-stop-smoke");
  await panel.locator("#serverInput").fill(`${origin}/v1`);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected");
}

async function selectActivePage(panel, target) {
  await target.bringToFront();
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await panel.evaluate(() => document.querySelector("#selectTabButton")?.click());
  await waitForText(panel.locator("#selectedTabSummary"), "Workspace Stop fixture");
}

async function runReadJob(panel, goal) {
  await panel.getByRole("tab", { name: "Workspace" }).click();
  await panel.locator("#goalInput").fill(goal);
  await panel.locator("#runButton").click();
  await panel.locator("#runCard").waitFor({ state: "visible", timeout: timeoutMs });
}

async function waitForTask(panel, goal, predicate) {
  let latest = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    latest = await panel.evaluate(async (goal) => {
      const stored = await chrome.storage.local.get("browsercrew.tasks.v1");
      return (stored["browsercrew.tasks.v1"] || []).find((task) => task.goal === goal) || null;
    }, goal);
    if (latest && predicate(latest)) return latest;
    await panel.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for Workspace task state: ${goal} :: ${JSON.stringify(latest)}`);
}

async function waitForText(locator, text) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function waitUntil(predicate, timeout, describe) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for condition. State: ${describe()}`);
}

async function startFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/read.html") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Workspace Stop fixture</title></head><body><main><h1>Abort Widget</h1><p>Product: Abort Widget</p><p>Price: $19</p></main></body></html>`);
  });
  return listen(server);
}

async function startProviderServer() {
  const state = { taskRequests: [], connectionTests: 0, aborted: 0, completed: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(await readBody(req));
    const combined = (body.messages || []).map((item) => String(item.content || "")).join("\n");
    if (combined.includes("Connection test")) {
      state.connectionTests += 1;
      return json(res, { model: "workspace-stop-smoke", choices: [{ message: { role: "assistant", content: "BrowserCrew connection works" } }] });
    }

    const entry = { goal: combined.includes("Pause the slow read") ? "pause" : "stop", aborted: false, completed: false, startedAt: new Date().toISOString() };
    state.taskRequests.push(entry);
    res.on("close", () => {
      if (!res.writableEnded && !entry.completed) {
        entry.aborted = true;
        entry.abortedAt = new Date().toISOString();
        state.aborted += 1;
      }
    });
    const delay = entry.goal === "pause" ? 1100 : 5000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (res.destroyed || entry.aborted) return;
    entry.completed = true;
    entry.completedAt = new Date().toISOString();
    state.completed += 1;
    const content = JSON.stringify({ items: [{ label: "Product", value: "Abort Widget" }, { label: "Price", value: "$19" }], notes: "Fixture response" });
    json(res, { model: "workspace-stop-smoke", choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 20 } });
  });
  const bound = await listen(server);
  return {
    ...bound,
    get taskRequests() { return state.taskRequests; },
    snapshot() { return { connectionTests: state.connectionTests, aborted: state.aborted, completed: state.completed, taskRequests: state.taskRequests.map((item) => ({ ...item })) }; }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, payload, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(payload));
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
