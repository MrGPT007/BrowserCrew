# v0.2 Release Evidence

Status: **NOT READY FOR v0.2 RELEASE**

Evidence baseline date: 12 September 2026.

This document is the release ledger for the v0.2 MVP gates in `docs/PRD.md` section 16. It separates what BrowserCrew has actually demonstrated from what is still missing. A green representative workflow smoke test is not treated as the 25-scenario / 75-run release matrix.

## Current certified baseline

The repository has installed-extension Chromium evidence for all five named workflows on controlled fixtures. The strongest combined run is GitHub Actions run `34668876723`, which tested the PR #10 merge candidate containing head `46d4facb81feba544b48b8217ca1d9e0f00480a6` and passed the v0.1/W1+W3 suite, W2, W4, and W5 in one quality run. PR #10 was then squash-merged to `main` as `ae58670026b29eea95cf1f6d75065253eb9c774d`.

That run proved representative controlled cases for W1–W5, including W3/W4/W5 interruption recovery. It does not by itself satisfy every v0.2 gate.

## Gate ledger

| PRD gate | Status | Evidence today | What still blocks release |
| --- | --- | --- | --- |
| Workflow completion | **Blocked** | Representative W1–W5 installed-Chromium cases pass | Execute all 25 scenarios in `tests/scenarios/v0.2.json` three times each and meet 68/75 overall with no workflow below 12/15 |
| Permission enforcement | **Partial** | Static contracts reject cookie/debugger/native-messaging expansion; W2/W4/W5 enforce bounded resources | Add adversarial tests for revoked grants, changed resources, hostile page instructions, and unauthorized tool requests |
| Recovery | **Partial** | W3, W4, and W5 worker interruption cases reconcile without blind replay | Cover every designated pre-dispatch, post-dispatch, and pre-checkpoint crash boundary in the release matrix |
| Duplicate writes | **Partial** | W3 recovery does not replay the field write; W4 save count remains one; W5 slow download receives one request | Complete the full recovery matrix and retain destination-side event evidence for each write case |
| Result integrity | **Partial** | Current representative workflows attach source/verification evidence before completion | Run integrity assertions across every completed release scenario, including partial/blocked paths |
| Privacy | **Blocked** | Provider secrets are session-only and current logs/history exclude the configured secret by design | Add seeded-canary leakage tests across model payloads, logs, history, exports, errors, and download manifests |
| Provider support | **Blocked** | Deterministic OpenAI-compatible test server exercises the adapter and connection path | Certify every provider we advertise for v0.2. Anthropic is not implemented; live OpenAI/LM Studio/Ollama deployments are not certified by CI |
| Accessibility | **Blocked** | Semantic controls, visible focus, reduced motion, narrow sidebar styling, and non-color status exist | Perform documented keyboard and screen-reader review of all primary flows and resolve critical defects |
| Package integrity | **Partial** | Exact Playwright version, syntax/contract checks, and installed unpacked-extension smoke are green | Add deterministic dependency lock/package evidence, release packaging check, rollback proof, and reconcile the PRD's build/typecheck/lint gate with the dependency-light JavaScript architecture |

## Current release blockers

`V02-B01` — 25-scenario catalog exists, but the required 75 model-assisted runs have not been executed and scored.

`V02-B02` — No seeded privacy/canary exfiltration suite exists yet.

`V02-B03` — The advertised-provider gate is incomplete. The current automated environment certifies a deterministic OpenAI-compatible endpoint contract, not external OpenAI, LM Studio, Ollama, or Anthropic services.

`V02-B04` — Anthropic adapter support required by the PRD provider matrix is not implemented.

`V02-B05` — Manual keyboard and screen-reader release review has not been recorded.

`V02-B06` — Previous-stable Chrome coverage is not recorded; current CI installs one pinned Playwright Chromium build.

`V02-B07` — A committed deterministic dependency lock/package candidate is not present.

`V02-B08` — Chrome Web Store permission/disclosure review is outside the current automated proof and remains a public-distribution gate.

## Evidence rules

A release blocker may move to passed only when the repository points to reproducible evidence. Do not convert `representative` scenario coverage into a scored release run. Failed runs remain in the denominator. Do not replace an external-provider certification with a mock result. Do not call v0.2 complete while this document says `NOT READY FOR v0.2 RELEASE`.

When the final release candidate is ready, record the exact candidate commit, workflow run IDs, browser versions, provider/model versions, scenario results, accessibility review, and package artifact hashes here before tagging or store submission.
