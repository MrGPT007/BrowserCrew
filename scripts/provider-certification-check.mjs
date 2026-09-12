import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const files = [
  "scripts/provider-certify.mjs",
  "scripts/provider-certification-aggregate.mjs",
  ".github/workflows/provider-certification.yml",
  "docs/PROVIDER-CERTIFICATION-v0.2.md",
  "docs/RELEASE-EVIDENCE-v0.2.md",
  "src/connections-runtime.js",
  "src/provider-adapters.js",
  "package.json"
];
for (const file of files) await access(file);
await Promise.all([
  execFileAsync(process.execPath, ["--check", "scripts/provider-certify.mjs"]),
  execFileAsync(process.execPath, ["--check", "scripts/provider-certification-aggregate.mjs"])
]);

const certify = await readFile("scripts/provider-certify.mjs", "utf8");
for (const phrase of [
  'openai: "OpenAI API"',
  'anthropic: "Anthropic API"',
  'lmstudio: "LM Studio"',
  'ollama: "Ollama"',
  "BROWSERCREW_PROVIDER_SECRET",
  "BROWSERCREW_CANDIDATE_SHA",
  "assert.equal(candidateSha, gitSha",
  'url.hostname, "api.openai.com"',
  'url.hostname, "api.anthropic.com"',
  '["127.0.0.1", "localhost"]',
  "chrome.storage.local.get(null)",
  "chrome.storage.session.get(null)",
  'getByRole("tab", { name: "Connect AI" })',
  'getByRole("tab", { name: "Chat" })',
  "chatEnablePageReadTool",
  "chatStopButton",
  "requestfailed",
  "transportAbortObserved: true",
  "browsercrew.live_provider_certification",
  "countsAsLiveCertification: false",
  "Certification receipt must never contain the raw provider credential"
]) if (!certify.includes(phrase)) throw new Error(`Live provider certification contract missing: ${phrase}`);
if (/console\.log\([^\n]*secret/i.test(certify)) throw new Error("Live provider certification must never print the provider secret.");

const aggregate = await readFile("scripts/provider-certification-aggregate.mjs", "utf8");
for (const phrase of [
  '["openai", "anthropic", "lmstudio", "ollama"]',
  "browsercrew.live_provider_certification",
  "candidateShas.size, 1",
  "connectionAuth",
  "streamingText",
  "normalizedToolCalling",
  "cancellation",
  "transportAbortObserved",
  "browsercrew.live_provider_certification_aggregate",
  "deterministicFixturesCountAsLiveCertification: false"
]) if (!aggregate.includes(phrase)) throw new Error(`Provider certification aggregate contract missing: ${phrase}`);

const workflow = await readFile(".github/workflows/provider-certification.yml", "utf8");
if (!workflow.includes("workflow_dispatch:")) throw new Error("Live provider certification workflow must be manual-only.");
if (/^\s*(push|pull_request):/m.test(workflow)) throw new Error("Live provider certification workflow must never run automatically on push or pull_request.");
for (const phrase of [
  "ref: main",
  "expected_candidate_sha",
  "git rev-parse HEAD",
  "BROWSERCREW_OPENAI_API_KEY",
  "BROWSERCREW_ANTHROPIC_API_KEY",
  "BROWSERCREW_PROVIDER_KIND: openai",
  "BROWSERCREW_PROVIDER_KIND: anthropic",
  "browsercrew-provider-certification",
  "npm run provider-certify",
  "if: always()"
]) if (!workflow.includes(phrase)) throw new Error(`Manual provider workflow contract missing: ${phrase}`);

const runtime = await readFile("src/connections-runtime.js", "utf8");
for (const phrase of ["openai", "anthropic", "lmstudio", "ollama", "chrome.storage.session"]) {
  if (!runtime.includes(phrase)) throw new Error(`Production provider runtime contract missing: ${phrase}`);
}
const adapters = await readFile("src/provider-adapters.js", "utf8");
for (const phrase of ["/messages", "x-api-key", "anthropic-version"]) {
  if (!adapters.includes(phrase)) throw new Error(`Native Anthropic adapter contract missing: ${phrase}`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.scripts?.["provider-certification-check"] !== "node scripts/provider-certification-check.mjs") throw new Error("provider-certification-check must stay wired.");
if (pkg.scripts?.["provider-certify"] !== "node scripts/provider-certify.mjs") throw new Error("provider-certify must stay wired.");
if (pkg.scripts?.["provider-certification-aggregate"] !== "node scripts/provider-certification-aggregate.mjs") throw new Error("provider-certification-aggregate must stay wired.");
if (!String(pkg.scripts?.check || "").includes("provider-certification-check.mjs")) throw new Error("npm run check must enforce live provider certification contracts.");

const docs = await readFile("docs/PROVIDER-CERTIFICATION-v0.2.md", "utf8");
for (const phrase of [
  "Deterministic fixtures are not live certification",
  "OpenAI API",
  "Anthropic API",
  "LM Studio",
  "Ollama",
  "same exact candidate SHA",
  "self-hosted",
  "BROWSERCREW_PROVIDER_SECRET"
]) if (!docs.includes(phrase)) throw new Error(`Provider certification operator documentation missing: ${phrase}`);

const evidence = await readFile("docs/RELEASE-EVIDENCE-v0.2.md", "utf8");
if (!evidence.includes("V02-B03")) throw new Error("Release ledger must retain V02-B03 until genuine live receipts exist.");
if (!evidence.toLowerCase().includes("live provider")) throw new Error("Release ledger must preserve the live-provider evidence boundary.");

console.log("BrowserCrew V02-B03 live provider certification contracts passed.");
