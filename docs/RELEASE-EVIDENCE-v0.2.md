# v0.2 Release Evidence

Status: **NOT READY FOR v0.2 RELEASE**

Evidence baseline date: 12 September 2026.

This document is the release ledger for the v0.2 MVP gates in `docs/PRD.md` section 16. It separates what BrowserCrew has actually demonstrated from what is still missing. A green representative workflow smoke test is not treated as the 25-scenario / 75-run release matrix.

## Current certified baseline

`main` now includes the controlled W1–W5 workflows plus seeded privacy coverage, first-class Chat, named AI connections, local document attachments, bounded built-in Chat tools, remote MCP, bounded C5 compare/specialist handoff, and true Workspace Stop/Pause semantics. The latest merged release-hardening baseline is PR #29, certified at exact head `154ce0175f7c828538c6d1f3d8b6aa4fc3f75de7` in Actions run `34683666475` and squash-merged to `main` as `71180399495b37bdab0853dbbb3fabe61316a02b`.

V02-B02 privacy sink closure was then proven on PR #31 candidate head `ae6db27ef3978ef306f5043a7b33c35f66b32bea`. The successful exact-head retry of Actions run `34696981584` passed static checks and the complete installed-extension Chromium matrix: v0.1/W1+W3, W2, W4, W5, baseline privacy, v0.2 privacy sinks, C1 Chat, named connections, attachments, C3 tools, C4 MCP, C5, and REL-01. The successful browser job was `103562856804`. Its evidence artifact is `10299102917`, digest `sha256:395986617d3c88c15860b110d4ec8f763c8edaeb395713c8b30fcd91792b9592`.

Those runs prove representative controlled cases and the specific privacy sinks described below. They do not by themselves satisfy every v0.2 release gate.

## Gate ledger

| PRD gate | Status | Evidence today | What still blocks release |
| --- | --- | --- | --- |
| Workflow completion | **Blocked** | Representative W1–W5 installed-Chromium cases pass | Execute all 25 scenarios in `tests/scenarios/v0.2.json` three times each and meet 68/75 overall with no workflow below 12/15 |
| Permission enforcement | **Partial** | Static contracts reject cookie/debugger/native-messaging expansion; W2/W4/W5 and C3/C4 enforce bounded resources and explicit write review | Add the remaining adversarial release-matrix cases for revoked grants, changed resources, hostile page instructions, and unauthorized requests |
| Recovery | **Partial** | W3, W4, W5, C4 uncertain-write recovery, C5 Stop, and REL-01 interruption behavior have installed-browser proof | Cover every designated pre-dispatch, post-dispatch, and pre-checkpoint crash boundary in the release matrix |
| Duplicate writes | **Partial** | W3 recovery does not replay the field write; W4 save count remains one; W5 slow download receives one request; C4 uncertain writes are not replayed | Complete the full recovery matrix and retain destination-side event evidence for each write case |
| Result integrity | **Partial** | Current representative workflows attach source/verification evidence before completion; W2 exports retain schema/provenance and W5 manifests bind verified downloads to records | Run integrity assertions across every completed release scenario, including partial/blocked paths |
| Privacy | **Passed** | Baseline `scripts/privacy-smoke.mjs` plus `scripts/privacy-sinks-smoke.mjs` prove selected-page/model isolation, session-only provider credentials, W2 CSV/JSON sink safety, W5 durable/download/manifest sink safety, hostile provider-error redaction, History/local-storage safety, and canary-free evidence artifacts. C1 attachments, C3 tools, C4 MCP, and C5 retain their own raw-context/durable-redaction checks in the same mandatory matrix. | No privacy blocker remains for the current v0.2 controlled release scope; rerun this gate on the final release candidate |
| Provider support | **Blocked** | Deterministic OpenAI-compatible test servers exercise adapters, named connections, model switching, tools, MCP, and handoff paths | Certify every provider we advertise for v0.2. Anthropic is not implemented; live OpenAI/LM Studio/Ollama deployments are not certified by CI |
| Accessibility | **Blocked** | Semantic controls, visible focus, reduced motion, narrow sidebar styling, and non-color status exist | Perform documented keyboard and screen-reader review of all primary flows and resolve critical defects |
| Package integrity | **Partial** | Exact Playwright version, syntax/contract checks, and installed unpacked-extension smoke are green | Add deterministic dependency lock/package evidence, release packaging check, rollback proof, and reconcile the PRD's build/typecheck/lint gate with the dependency-light JavaScript architecture |

## Current release blockers

`V02-B01` — 25-scenario catalog exists, but the required 75 model-assisted runs have not been executed and scored.

`V02-B02` — **Resolved on PR #31 candidate head `ae6db27ef3978ef306f5043a7b33c35f66b32bea`.** Exact-head installed-Chromium evidence now covers provider-secret/session isolation, password/script/hidden/unselected context, unrelated durable context, W2 CSV/JSON exports, W5 durable task/download metadata/manifest, hostile provider-error echo redaction, History/local storage, and the privacy evidence artifact. Run `34696981584`, successful browser job `103562856804`, artifact `10299102917`.

`V02-B03` — The advertised-provider gate is incomplete. The current automated environment certifies deterministic OpenAI-compatible endpoint contracts, not external OpenAI, LM Studio, Ollama, or Anthropic services.

`V02-B04` — Anthropic adapter support required by the PRD provider matrix is not implemented.

`V02-B05` — Manual keyboard and screen-reader release review has not been recorded.

`V02-B06` — Previous-stable Chrome coverage is not recorded; current CI installs one pinned Playwright Chromium build.

`V02-B07` — A committed deterministic dependency lock/package candidate is not present.

`V02-B08` — Chrome Web Store permission/disclosure review is outside the current automated proof and remains a public-distribution gate.

## Evidence rules

A release blocker may move to passed only when the repository points to reproducible evidence. Do not convert `representative` scenario coverage into a scored release run. Failed runs remain in the denominator. Do not replace an external-provider certification with a mock result. Do not call v0.2 complete while this document says `NOT READY FOR v0.2 RELEASE`.

When the final release candidate is ready, record the exact candidate commit, workflow run IDs, browser versions, provider/model versions, scenario results, accessibility review, and package artifact hashes here before tagging or store submission.
