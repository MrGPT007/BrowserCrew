import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "accessibility-smoke");
const timeoutMs = 30_000;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), "browsercrew-accessibility-"));
const extensionDir = join(tempRoot, "extension");
const userDataDir = join(tempRoot, "profile");
let context;
const report = { startedAt: new Date().toISOString(), checks: [], machineGate: true, manualAssistiveTechnologyReviewRequired: false };

try {
  await prepareTestExtension(extensionDir);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 800 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedAccessibilityState(panel);
  await panel.reload();
  await panel.locator("#tab-chat").waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil(async () => (await panel.locator("#chatConnectionPicker option").count()) >= 2, "Named AI picker did not load seeded connections.");

  assert.equal(await hasPageOverflow(panel), false, "Primary side-panel layout should not force page-level horizontal scrolling at 360px.");
  const viewportMeta = await panel.locator('meta[name="viewport"]').getAttribute("content");
  assert.doesNotMatch(viewportMeta || "", /maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i, "Viewport must not disable user zoom.");
  pass("Narrow side-panel layout reflowed without disabling browser zoom");

  const unnamed = await panel.evaluate(() => {
    const visible = (node) => !node.hidden && !node.closest("[hidden]") && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden";
    const name = (node) => {
      const labelledBy = node.getAttribute("aria-labelledby");
      if (labelledBy) return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (node.getAttribute("aria-label")) return node.getAttribute("aria-label").trim();
      if (node.labels?.length) return [...node.labels].map((label) => label.textContent || "").join(" ").trim();
      return (node.textContent || "").replace(/\s+/g, " ").trim();
    };
    return [...document.querySelectorAll("button,input,textarea,select")]
      .filter(visible)
      .filter((node) => !name(node))
      .map((node) => node.id || node.outerHTML.slice(0, 120));
  });
  assert.deepEqual(unnamed, [], `Visible controls must have accessible names: ${unnamed.join(", ")}`);
  pass("Visible primary controls exposed meaningful accessible names");

  await panel.locator("#tab-chat").focus();
  await panel.keyboard.press("ArrowRight");
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "tab-workspace");
  assert.equal(await panel.locator("#tab-workspace").getAttribute("aria-selected"), "true");
  await panel.keyboard.press("ArrowLeft");
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "tab-chat");
  assert.equal(await panel.locator("#tab-chat").getAttribute("aria-selected"), "true");
  pass("Primary tablist supported roving focus and arrow-key activation");

  await panel.locator("#tab-ai").click();
  const selectedProvider = panel.locator('.provider-card[aria-checked="true"]');
  await selectedProvider.focus();
  const beforeProvider = await panel.evaluate(() => document.activeElement?.dataset?.provider || "");
  await panel.keyboard.press("ArrowRight");
  const afterProvider = await panel.evaluate(() => document.activeElement?.dataset?.provider || "");
  assert.notEqual(afterProvider, beforeProvider, "ArrowRight should move custom radio selection.");
  assert.equal(await panel.locator(`.provider-card[data-provider="${afterProvider}"]`).getAttribute("aria-checked"), "true");
  assert.equal(await panel.locator('.provider-card[tabindex="0"]').count(), 1, "Custom radio group should expose exactly one Tab stop.");
  pass("Custom provider radios implemented standard roving/arrow-key behavior");

  await panel.locator("#tab-chat").click();
  const commandButton = panel.locator("#commandPaletteButton");
  await commandButton.focus();
  await commandButton.click();
  await waitUntil(async () => await panel.evaluate(() => document.activeElement?.id === "commandSearch"), "Command search did not receive focus when the command bar opened.");
  assert.equal(await panel.locator("#commandSearch").getAttribute("role"), "combobox");
  assert.equal(await panel.locator("#commandSearch").getAttribute("aria-controls"), "commandList");
  assert.equal(await panel.locator("#commandSearch").getAttribute("aria-expanded"), "true");
  const activeBefore = await panel.locator("#commandSearch").getAttribute("aria-activedescendant");
  assert.ok(activeBefore, "Command search should identify its active option.");
  await panel.keyboard.press("ArrowDown");
  await panel.waitForTimeout(25);
  const activeAfter = await panel.locator("#commandSearch").getAttribute("aria-activedescendant");
  assert.ok(activeAfter && activeAfter !== activeBefore, "ArrowDown should update the active descendant.");
  assert.equal(await panel.locator(`#${activeAfter}`).getAttribute("aria-selected"), "true");
  assert.equal(await panel.locator("#app").evaluate((node) => node.inert), true, "Background app should be inert while modal command bar is open.");

  await panel.evaluate(() => {
    const dialog = document.querySelector('#commandPalette [role="dialog"]');
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && !node.closest("[hidden]") && getComputedStyle(node).display !== "none");
    focusable.at(-1)?.focus();
  });
  await panel.keyboard.press("Tab");
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "commandSearch", "Tab from the final modal control should wrap to the first control.");

  const cdp = await context.newCDPSession(panel);
  const axTree = await cdp.send("Accessibility.getFullAXTree");
  assert.ok(findAxNode(axTree.nodes, "dialog", "Command bar"), "Chromium accessibility tree should expose the command bar as a named dialog.");
  assert.ok(findAxNode(axTree.nodes, "combobox", "Search commands"), "Chromium accessibility tree should expose command search as a named combobox.");

  await panel.keyboard.press("Escape");
  await waitUntil(async () => await panel.locator("#commandPalette").getAttribute("hidden") !== null, "Escape did not close the command bar.");
  await panel.waitForTimeout(25);
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "commandPaletteButton", "Closing command bar should restore focus to its opener.");
  assert.equal(await panel.locator("#app").evaluate((node) => node.inert), false);
  pass("Command bar exposed combobox/listbox semantics, trapped focus, closed with Escape, and restored focus");

  await panel.locator("#chatConnectionPicker").focus();
  await panel.locator("#chatConnectionPicker").selectOption("conn-b");
  await panel.locator("#connectionTransferReview").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await panel.locator("#app").evaluate((node) => node.inert), true);
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "confirmConnectionSwitchButton");
  await panel.keyboard.press("Tab");
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "cancelConnectionSwitchButton", "Focus should wrap inside transfer review.");
  await panel.keyboard.press("Shift+Tab");
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "confirmConnectionSwitchButton");
  await panel.keyboard.press("Escape");
  await panel.locator("#connectionTransferReview").waitFor({ state: "hidden", timeout: timeoutMs });
  await panel.waitForTimeout(25);
  assert.equal(await panel.evaluate(() => document.activeElement?.id), "chatConnectionPicker", "Closing transfer review should restore focus to the connection picker.");
  assert.equal(await panel.locator("#app").evaluate((node) => node.inert), false);
  pass("Connection-transfer modal trapped focus, supported Escape, and restored focus to the invoking control");

  for (const id of ["chatRunStatus", "c5Status", "connectionResult"]) {
    const node = panel.locator(`#${id}`);
    assert.equal(await node.getAttribute("role"), "status", `${id} should be exposed as a status region.`);
    assert.equal(await node.getAttribute("aria-live"), "polite", `${id} should announce important changes politely.`);
    assert.equal(await node.getAttribute("aria-atomic"), "true", `${id} should announce the complete status message.`);
  }
  const statusCopy = await panel.locator("#aiStatus .status-label").innerText();
  assert.ok(statusCopy.trim(), "AI status must include text in addition to its visual dot.");
  pass("Primary asynchronous states used text plus polite atomic status semantics");

  await panel.emulateMedia({ reducedMotion: "reduce" });
  const transitionDuration = await panel.locator("#commandPaletteButton").evaluate((node) => getComputedStyle(node).transitionDuration);
  assert.ok(parseFirstDurationSeconds(transitionDuration) <= 0.001, `Reduced-motion transition should be effectively disabled; got ${transitionDuration}`);
  pass("Reduced-motion preference collapsed interaction transitions");

  await panel.evaluate(() => localStorage.setItem("browsercrew.theme", "dark"));
  await panel.reload();
  await panel.locator("#tab-chat").waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await panel.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await hasPageOverflow(panel), false, "Dark mode should retain narrow-width reflow.");
  pass("Dark mode retained the same narrow-width accessibility baseline");

  await panel.screenshot({ path: join(artifactDir, "accessibility-v02-b05.png"), fullPage: true });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  report.browser = await panel.evaluate(() => navigator.userAgent);
  report.viewport = { width: 360, height: 800 };
  report.note = "Machine-tested v0.2 accessibility gate: keyboard behavior, narrow layout, reduced motion, modal focus, status semantics, and Chromium accessibility tree.";
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("BrowserCrew V02-B05 accessibility installed-extension smoke checks passed.");
  for (const check of report.checks) console.log(`✓ ${check.name}`);
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.ok = false;
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  if (context) await context.close().catch(() => {});
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

function pass(name) { report.checks.push({ name, at: new Date().toISOString() }); }

async function seedAccessibilityState(panel) {
  await panel.evaluate(async () => {
    const now = new Date().toISOString();
    const connections = [
      { id: "conn-a", schemaVersion: 1, name: "Local A", kind: "lmstudio", model: "model-a", baseUrl: "http://127.0.0.1:1234/v1", status: "connected", lastTestedAt: now, createdAt: now, updatedAt: now },
      { id: "conn-b", schemaVersion: 1, name: "Local B", kind: "ollama", model: "model-b", baseUrl: "http://127.0.0.1:11434/v1", status: "connected", lastTestedAt: now, createdAt: now, updatedAt: now }
    ];
    const conversation = {
      id: "a11y-chat",
      schemaVersion: 1,
      title: "Accessibility audit chat",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      providerRef: { kind: "lmstudio", model: "model-a", baseUrl: "http://127.0.0.1:1234/v1" },
      messages: [
        { id: "u1", role: "user", text: "Hello", createdAt: now, context: { pageIncluded: false } },
        { id: "a1", role: "assistant", text: "Hello from BrowserCrew", createdAt: now, model: "model-a", provider: "lmstudio" }
      ],
      activity: []
    };
    await chrome.storage.local.set({
      "browsercrew.connections.v1": connections,
      "browsercrew.activeConnection.v1": "conn-a",
      "browsercrew.settings.v1": { kind: "lmstudio", model: "model-a", baseUrl: "http://127.0.0.1:1234/v1" },
      "browsercrew.conversations.v1": [conversation]
    });
    await chrome.storage.session.remove(["browsercrew.connectionSecrets.v1", "browsercrew.providerSecret.v1"]);
    localStorage.setItem("browsercrew.activeView", "chat");
    localStorage.setItem("browsercrew.theme", "light");
  });
}

async function prepareTestExtension(target) {
  await cp(repoRoot, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length).replace(/^[/\\]/, "");
      if (!relative) return true;
      const first = relative.split(/[/\\]/)[0];
      return ![".git", "node_modules", "artifacts", "dist"].includes(first);
    }
  });
}

function findAxNode(nodes, role, name) {
  return nodes.find((node) => node.role?.value === role && node.name?.value === name) || null;
}

function parseFirstDurationSeconds(value) {
  const first = String(value || "0s").split(",")[0].trim();
  if (first.endsWith("ms")) return Number.parseFloat(first) / 1000;
  return Number.parseFloat(first) || 0;
}

async function hasPageOverflow(panel) {
  return panel.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
}

async function waitUntil(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(message);
}