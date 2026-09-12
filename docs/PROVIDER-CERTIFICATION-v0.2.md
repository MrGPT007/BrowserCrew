# BrowserCrew v0.2 live provider certification

V02-B03 is the live-deployment gate for the four provider types BrowserCrew advertises in v0.2: **OpenAI API**, **Anthropic API**, **LM Studio**, and **Ollama**.

## Evidence boundary

**Deterministic fixtures are not live certification.** The normal quality matrix continues to prove BrowserCrew request translation, streaming normalization, tool-call handling, error redaction, timeouts, cancellation wiring, and local privacy invariants with controlled fixtures. Those tests are mandatory regression evidence, but none of them proves that a real provider account, real model deployment, or real local model server works with the release candidate.

A V02-B03 live receipt is valid only when `scripts/provider-certify.mjs` drives the installed extension through the real Connect AI and Chat surfaces against the configured live deployment. A green aggregate requires one valid receipt for all four providers on the **same exact candidate SHA**.

## What one live certification run proves

Each run must pass all of these capabilities through BrowserCrew itself:

- Connect AI authenticates and receives a successful model response.
- Chat makes a real streaming request and receives a unique response token.
- The configured model receives BrowserCrew's bounded page-read tool schema, calls it, and BrowserCrew executes the approved read outside the model before returning the result.
- Stop cancels an in-flight live stream, the provider transport is observed as aborted/failed, and no additional response text appears after BrowserCrew reports Stopped.
- A cloud credential is absent from durable Chrome/local storage and exists only in session storage while the certification session is active.
- The emitted receipt contains no raw provider credential, page snapshot, prompt transcript, or model response text.

## Safe endpoint rules

The certification harness is intentionally stricter than a generic connection test because it may receive live credentials.

- `openai` accepts only `https://api.openai.com/v1`.
- `anthropic` accepts only `https://api.anthropic.com/v1`.
- `lmstudio` and `ollama` accept only `/v1` on `127.0.0.1` or `localhost`, over HTTP or HTTPS.
- URLs with embedded usernames/passwords, query strings, or fragments are rejected before the provider credential is used.

This prevents a manual workflow input from redirecting a cloud credential to an arbitrary host.

## Required environment variables

`scripts/provider-certify.mjs` requires:

- `BROWSERCREW_PROVIDER_KIND` — `openai`, `anthropic`, `lmstudio`, or `ollama`.
- `BROWSERCREW_PROVIDER_MODEL` — exact deployed model name.
- `BROWSERCREW_PROVIDER_BASE_URL` — exact safe base URL described above.
- `BROWSERCREW_CANDIDATE_SHA` — exact 40-character Git commit being certified. The script also reads `git rev-parse HEAD` and refuses a mismatch.
- `BROWSERCREW_PROVIDER_SECRET` — required for OpenAI API and Anthropic API. LM Studio and Ollama normally leave it empty.
- `BROWSERCREW_BROWSER_EXECUTABLE` — optional explicit browser executable. When omitted, the Playwright Chromium channel is used.

Never put `BROWSERCREW_PROVIDER_SECRET` in a shell command, repository file, workflow input, issue, PR, or downloaded receipt. Use an environment secret only.

## Cloud certification in GitHub Actions

The manual workflow is `.github/workflows/provider-certification.yml`. It has **workflow_dispatch only**; it does not run on pull requests or pushes.

Configure repository Actions secrets:

- `BROWSERCREW_OPENAI_API_KEY`
- `BROWSERCREW_ANTHROPIC_API_KEY`

For each cloud provider, manually run **provider-certification** and provide:

1. `provider_kind`: `openai` or `anthropic`.
2. `expected_candidate_sha`: the exact current `main` SHA intended for release certification.
3. `model`: the exact model to certify.
4. `base_url`: the official `/v1` URL for that provider.

The workflow checks out `main`, compares `git rev-parse HEAD` with `expected_candidate_sha`, and only then starts the step that can see that provider's credential. The certification script independently repeats the SHA and endpoint checks.

Download the resulting sanitized receipt artifact. A failed run is not certification even if an artifact exists; failed receipts are diagnostic only.

## Local LM Studio and Ollama certification

Local providers must be certified where the model server is actually running. The manual workflow's local job uses a **self-hosted Windows x64 runner** with the label `browsercrew-provider-certification`.

On that runner:

1. Run LM Studio or Ollama and load the exact model being certified.
2. Expose the OpenAI-compatible endpoint on loopback only, for example `http://127.0.0.1:1234/v1` or `http://127.0.0.1:11434/v1`.
3. Ensure the self-hosted Actions runner is online with labels `self-hosted`, `Windows`, `X64`, and `browsercrew-provider-certification`.
4. Dispatch the manual workflow with `provider_kind` set to `lmstudio` or `ollama`, the same release candidate SHA used for cloud certification, the exact model name, and the loopback base URL.

No cloud credential is supplied to the local-provider job.

You may also run the same script directly from a local checkout at the exact candidate SHA by setting the environment variables above and running `npm run provider-certify`.

## Aggregate the four receipts

Place the four successful receipt files at:

- `artifacts/provider-certification/openai/receipt.json`
- `artifacts/provider-certification/anthropic/receipt.json`
- `artifacts/provider-certification/lmstudio/receipt.json`
- `artifacts/provider-certification/ollama/receipt.json`

Then run:

```text
BROWSERCREW_CANDIDATE_SHA=<exact-sha> npm run provider-certification-aggregate
```

On PowerShell, set `$env:BROWSERCREW_CANDIDATE_SHA` first and run the npm command separately.

The aggregate fails unless all four receipts are live-certification receipts, all capability checks passed, credential-scope proof is present, and every receipt names the same exact candidate SHA. The resulting `artifacts/provider-certification/aggregate.json` is the machine-readable V02-B03 evidence summary.

## Release rule

Merging the certification harness does **not** pass V02-B03. V02-B03 remains blocked until genuine successful live receipts exist for OpenAI API, Anthropic API, LM Studio, and Ollama on the same exact release candidate, and the aggregate passes. Chrome Web Store/public distribution review remains a separate V02-B08 gate.
