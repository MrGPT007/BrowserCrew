import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providerKind = String(process.env.BROWSERCREW_PROVIDER_KIND || "").trim().toLowerCase();
const model = String(process.env.BROWSERCREW_PROVIDER_MODEL || "").trim();
const baseUrlText = String(process.env.BROWSERCREW_PROVIDER_BASE_URL || "").trim();
const secret = String(process.env.BROWSERCREW_PROVIDER_SECRET || "");
const candidateSha = String(process.env.BROWSERCREW_CANDIDATE_SHA || "").trim();
const browserExecutable = String(process.env.BROWSERCREW_BROWSER_EXECUTABLE || "").trim();
const artifactDir = join(repoRoot, "artifacts", "provider-certification", providerKind || "unknown");
const timeoutMs = 60_000;
const providerLabels = {
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  lmstudio: "LM Studio",
  ollama: "Ollama"
};
const cloudProviders = new Set(["openai", "anthropic"]);
const localProviders = new Set(["lmstudio", "ollama"]);
let stage = "preflight";
let context;
let fixture;
let tempRoot;
let endpoint;

const receipt = {
  kind: "browsercrew.live_provider_certification",
  schemaVersion: 1,
  release: "v0.2",
  candidateSha,
  provider: {
    kind: providerKind,
    model,
    endpoint: null,
    secretConfigured: Boolean(secret)
  },
  runtime: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    browserUserAgent: null
  },
  capabilities: {
    connectionAuth: { passed: false },
    streamingText: { passed: false },
    normalizedToolCalling: { passed: false },
    cancellation: { passed: false }
  },
  credentialScope: {
    durableStorageExcluded: false,
    sessionOnlyWhenRequired: false,
    receiptExcluded: false
  },
  deterministicProtocolEvidence: {
    countsAsLiveCertification: false,
    note: "Deterministic BrowserCrew protocol fixtures remain separate regression evidence and never substitute for this live deployment receipt."
  },
  startedAt: new Date().toISOString(),
  completedAt: null,
  ok: false
};

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  assert.ok(providerLabels[providerKind], "BROWSERCREW_PROVIDER_KIND must be one of openai, anthropic, lmstudio, or ollama.");
  assert.ok(model, "BROWSERCREW_PROVIDER_MODEL is required.");
  assert.match(candidateSha, /^[0-9a-f]{40}$/i, "BROWSERCREW_CANDIDATE_SHA must be an exact 40-character commit SHA.");
  const gitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  assert.equal(candidateSha, gitSha, "Provider certification must run from the exact candidate SHA it records.");
  endpoint = validateEndpoint(providerKind, baseUrlText);
  receipt.provider.endpoint = endpoint.safe;
  if (cloudProviders.has(providerKind)) assert.ok(secret, `${providerKind} live certification requires BROWSERCREW_PROVIDER_SECRET.`);

  stage = "fixture";
  const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
  const textToken = `BROWSERCREW_LIVE_TEXT_${nonce}`;
  const toolToken = `BROWSERCREW_LIVE_TOOL_${nonce}`;
  const cancelToken = `BROWSERCREW_LIVE_CANCEL_${nonce}`;
  fixture = await startFixtureServer(toolToken);
  tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-provider-certification-"));
  const extensionDir = join(tempRoot, "extension");
  const userDataDir = join(tempRoot, "profile");
  await prepareCertificationExtension(extensionDir, [endpoint.origin, fixture.origin]);

  stage = "browser-launch";
  const launchOptions = {
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  };
  if (browserExecutable) launchOptions.executablePath = browserExecutable;
  else launchOptions.channel = "chromium";
  context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  receipt.runtime.browserUserAgent = await panel.evaluate(() => navigator.userAgent);

  stage = "connection-auth";
  await configureLiveProvider(panel, providerLabels[providerKind], model, endpoint.safe, secret, cloudProviders.has(providerKind));
  receipt.capabilities.connectionAuth = {
    passed: true,
    method: "Installed Connect AI test through BrowserCrew TEST_PROVIDER"
  };

  stage = "streaming-text";
  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.locator("#chatInput").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#chatNewButton").click();
  const textRequest = waitForProviderRequest(context, endpoint, textToken, hasStreamingFlag);
  await panel.locator("#chatInput").fill(`Live certification ${textToken}. Reply with exactly this token: ${textToken}. Do not call tools.`);
  await panel.locator("#chatSendButton").click();
  const textNetwork = await textRequest;
  await waitForText(panel.locator("#chatMessages"), textToken, timeoutMs);
  receipt.capabilities.streamingText = {
    passed: true,
    streamRequested: textNetwork.streamRequested,
    responseTokenObserved: true
  };

  stage = "normalized-tool-call";
  await panel.locator("#chatNewButton").click();
  const target = await context.newPage();
  await target.goto(`${fixture.origin}/certification.html`);
  await enablePageRead(panel, target);
  const toolPromptMarker = `TOOL_REQUEST_${nonce}`;
  const toolRequest = waitForProviderRequest(context, endpoint, toolPromptMarker, (body) => body.includes('"tools"'));
  await panel.locator("#chatInput").fill(`${toolPromptMarker}. You must use the approved page-read tool exactly once before answering. Read the page and return the certification code shown there.`);
  await panel.locator("#chatSendButton").click();
  await toolRequest;
  await waitForText(panel.locator("#chatMessages"), "Page read result", timeoutMs);
  await waitForText(panel.locator("#chatMessages"), toolToken, timeoutMs);
  const activity = await panel.locator("#chatActivityList").innerText();
  assert.match(activity, /Page read finished/i, "BrowserCrew must expose completed page-read activity for the live tool call.");
  receipt.capabilities.normalizedToolCalling = {
    passed: true,
    modelReceivedToolSchema: true,
    pageReadExecutedOutsideModel: true,
    resultReturnedThroughBrowserCrew: true
  };

  stage = "cancellation";
  await panel.locator("#chatNewButton").click();
  const cancelRequestPromise = waitForProviderRequest(context, endpoint, cancelToken, hasStreamingFlag);
  await panel.locator("#chatInput").fill(`${cancelToken}. Begin a deliberately long answer: count from 1 to 10000, one number per line, and do not stop early unless the request is cancelled.`);
  await panel.locator("#chatSendButton").click();
  const cancelNetwork = await cancelRequestPromise;
  const networkOutcomePromise = waitForRequestOutcome(context, cancelNetwork.request, 12_000);
  await panel.locator("#chatStopButton").waitFor({ state: "visible", timeout: timeoutMs });
  await panel.locator("#chatStopButton").click();
  await waitForText(panel.locator("#chatRunStatus"), "Stopped", 15_000);
  await panel.waitForTimeout(500);
  const stoppedText = await panel.locator("#chatMessages").innerText();
  await panel.waitForTimeout(1200);
  assert.equal(await panel.locator("#chatMessages").innerText(), stoppedText, "No additional live provider text may appear after BrowserCrew reports Stopped.");
  const networkOutcome = await networkOutcomePromise;
  assert.equal(networkOutcome, "aborted_or_failed", "BrowserCrew Stop must abort the in-flight live provider stream before certification passes.");
  receipt.capabilities.cancellation = {
    passed: true,
    liveRequestStarted: true,
    stoppedStatusObserved: true,
    outputSettledAfterStop: true,
    transportOutcome: networkOutcome,
    transportAbortObserved: true
  };

  stage = "credential-scope";
  const storage = await panel.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
    localStorage: Object.fromEntries(Object.entries(localStorage))
  }));
  const durableText = JSON.stringify({ local: storage.local, localStorage: storage.localStorage });
  const sessionText = JSON.stringify(storage.session);
  if (secret) {
    assert.equal(durableText.includes(secret), false, "The live provider credential must not appear in durable BrowserCrew storage.");
    assert.equal(sessionText.includes(secret), true, "Cloud provider credential must remain available only in Chrome session storage during certification.");
  }
  receipt.credentialScope.durableStorageExcluded = true;
  receipt.credentialScope.sessionOnlyWhenRequired = cloudProviders.has(providerKind) ? sessionText.includes(secret) : true;

  receipt.completedAt = new Date().toISOString();
  receipt.ok = Object.values(receipt.capabilities).every((value) => value.passed === true)
    && receipt.credentialScope.durableStorageExcluded
    && receipt.credentialScope.sessionOnlyWhenRequired;
  assert.equal(receipt.ok, true, "Every live provider capability must pass before a certification receipt can be green.");
  receipt.credentialScope.receiptExcluded = true;
  await writeReceipt(receipt, secret);
  console.log(`BrowserCrew live provider certification passed for ${providerKind} at ${candidateSha}.`);
} catch (error) {
  receipt.completedAt = new Date().toISOString();
  receipt.ok = false;
  receipt.failure = { stage, type: String(error?.name || "Error").slice(0, 80) };
  receipt.credentialScope.receiptExcluded = true;
  await writeReceipt(receipt, secret).catch(() => {});
  throw new Error(`Live provider certification failed during ${stage}. See the sanitized receipt artifact.`);
} finally {
  if (context) await context.close().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function validateEndpoint(kind, value) {
  assert.ok(value, "BROWSERCREW_PROVIDER_BASE_URL is required.");
  const url = new URL(value);
  assert.equal(Boolean(url.username || url.password || url.search || url.hash), false, "Provider certification URLs may not embed credentials, query strings, or fragments.");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (kind === "openai") {
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "api.openai.com");
    assert.ok(!url.port || url.port === "443");
    assert.equal(pathname, "/v1");
  } else if (kind === "anthropic") {
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "api.anthropic.com");
    assert.ok(!url.port || url.port === "443");
    assert.equal(pathname, "/v1");
  } else {
    assert.ok(localProviders.has(kind));
    assert.ok(["http:", "https:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), `${kind} live certification is restricted to a loopback endpoint.`);
    assert.equal(pathname, "/v1");
  }
  const safe = `${url.origin}${pathname}`;
  return { origin: url.origin, safe };
}

async function configureLiveProvider(panel, label, exactModel, safeBaseUrl, providerSecret, providerNeedsSecret) {
  await panel.getByRole("tab", { name: "Connect AI" }).click();
  const provider = panel.getByRole("radio", { name: new RegExp(`^${escapeRegExp(label)}`) });
  await provider.waitFor({ state: "visible", timeout: timeoutMs });
  await provider.click();
  await panel.locator("#modelInput").fill(exactModel);
  await panel.locator("#serverInput").fill(safeBaseUrl);
  if (providerNeedsSecret) await panel.locator("#apiKeyInput").fill(providerSecret);
  await panel.locator("#testConnectionButton").click();
  await waitForText(panel.locator("#connectionResult"), "Connected", timeoutMs);
  assert.match(await panel.locator("#aiStatus").innerText(), /Connected/i);
}

async function enablePageRead(panel, target) {
  await target.bringToFront();
  await panel.getByRole("tab", { name: "Chat" }).click();
  await panel.evaluate(() => {
    const checkbox = document.querySelector("#chatEnablePageReadTool");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForText(panel.locator("#chatToolGrantSummary"), "Allowed once", 15_000);
}

function waitForProviderRequest(contextValue, endpointInfo, marker, bodyPredicate) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      contextValue.off("request", onRequest);
      rejectPromise(new Error("Timed out waiting for the live provider request."));
    }, timeoutMs);
    const onRequest = (request) => {
      try {
        const url = new URL(request.url());
        if (url.origin !== endpointInfo.origin || request.method() !== "POST") return;
        const body = String(request.postData() || "");
        if (!body.includes(marker) || !bodyPredicate(body)) return;
        clearTimeout(timer);
        contextValue.off("request", onRequest);
        resolvePromise({ request, streamRequested: hasStreamingFlag(body) });
      } catch {}
    };
    contextValue.on("request", onRequest);
  });
}

function waitForRequestOutcome(contextValue, targetRequest, timeout) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contextValue.off("requestfailed", failed);
      contextValue.off("requestfinished", finished);
      resolvePromise(value);
    };
    const failed = (request) => { if (request === targetRequest) finish("aborted_or_failed"); };
    const finished = (request) => { if (request === targetRequest) finish("finished"); };
    const timer = setTimeout(() => finish("unobserved"), timeout);
    contextValue.on("requestfailed", failed);
    contextValue.on("requestfinished", finished);
  });
}

function hasStreamingFlag(body) {
  return body.includes('"stream":true') || body.includes('"stream": true');
}

async function prepareCertificationExtension(target, origins) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", "dist", ".browser"].includes(first);
    }
  });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set(origins.map((origin) => `${origin}/*`))];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startFixtureServer(toolToken) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/certification.html") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><title>Provider certification fixture</title></head><body><main><h1>BrowserCrew Provider Certification</h1><p>Certification code: ${toolToken}</p></main></body></html>`);
  });
  return listen(server);
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function waitForText(locator, text, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await locator.innerText().catch(() => "");
    if (value.includes(text)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for expected live certification UI text.");
}

async function writeReceipt(value, credential) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (credential) assert.equal(serialized.includes(credential), false, "Certification receipt must never contain the raw provider credential.");
  await writeFile(join(artifactDir, "receipt.json"), serialized);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
