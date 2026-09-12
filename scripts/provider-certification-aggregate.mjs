import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(String(process.env.BROWSERCREW_PROVIDER_RECEIPTS_DIR || "artifacts/provider-certification"));
const output = resolve(String(process.env.BROWSERCREW_PROVIDER_AGGREGATE_PATH || join(root, "aggregate.json")));
const requiredKinds = ["openai", "anthropic", "lmstudio", "ollama"];
const receipts = [];

for (const kind of requiredKinds) {
  const path = join(root, kind, "receipt.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.equal(receipt.kind, "browsercrew.live_provider_certification", `${kind} receipt must be live certification evidence.`);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.release, "v0.2");
  assert.equal(receipt.provider?.kind, kind, `${kind} receipt provider identity mismatch.`);
  assert.equal(receipt.ok, true, `${kind} live certification did not pass.`);
  assert.match(String(receipt.candidateSha || ""), /^[0-9a-f]{40}$/i, `${kind} receipt must contain an exact candidate SHA.`);
  for (const capability of ["connectionAuth", "streamingText", "normalizedToolCalling", "cancellation"]) {
    assert.equal(receipt.capabilities?.[capability]?.passed, true, `${kind} did not pass ${capability}.`);
  }
  assert.equal(receipt.capabilities?.cancellation?.transportAbortObserved, true, `${kind} did not prove live transport cancellation.`);
  assert.equal(receipt.credentialScope?.durableStorageExcluded, true, `${kind} credential durable-storage proof is missing.`);
  assert.equal(receipt.credentialScope?.receiptExcluded, true, `${kind} credential receipt-exclusion proof is missing.`);
  assert.equal(receipt.deterministicProtocolEvidence?.countsAsLiveCertification, false, `${kind} may not count deterministic fixtures as live proof.`);
  receipts.push(receipt);
}

const candidateShas = new Set(receipts.map((receipt) => receipt.candidateSha));
assert.equal(candidateShas.size, 1, "All live provider receipts must certify the exact same candidate SHA.");
const candidateSha = receipts[0].candidateSha;
const explicit = String(process.env.BROWSERCREW_CANDIDATE_SHA || "").trim();
if (explicit) assert.equal(candidateSha, explicit, "Aggregate candidate SHA does not match BROWSERCREW_CANDIDATE_SHA.");

const aggregate = {
  kind: "browsercrew.live_provider_certification_aggregate",
  schemaVersion: 1,
  release: "v0.2",
  candidateSha,
  generatedAt: new Date().toISOString(),
  requiredProviders: requiredKinds,
  providerReceipts: receipts.map((receipt) => ({
    kind: receipt.provider.kind,
    model: receipt.provider.model,
    endpoint: receipt.provider.endpoint,
    completedAt: receipt.completedAt,
    ok: receipt.ok
  })),
  deterministicFixturesCountAsLiveCertification: false,
  ok: true
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`BrowserCrew v0.2 live provider certification aggregate passed for ${candidateSha}.`);
