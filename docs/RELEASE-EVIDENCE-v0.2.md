# v0.2 Release Evidence

Status: **NOT READY FOR v0.2 RELEASE**

Evidence baseline date: 12 September 2026.

This document is the release ledger for the v0.2 MVP gates in `docs/PRD.md` section 16. It separates what BrowserCrew has actually demonstrated from what is still missing. A green representative workflow smoke test is not treated as the 25-scenario / 75-run release matrix.

## Current certified baseline

`main` includes the controlled W1–W5 workflows plus seeded privacy coverage, first-class Chat, named AI connections, local document attachments, bounded built-in Chat tools, remote MCP, bounded C5 compare/specialist handoff, true Workspace Stop/Pause semantics, package/rollback proof, and the native Anthropic Messages adapter merged by PR #35 at `main` SHA `5819d6a631384caffd8749782e4401775cf66a02`.

V02-B02 privacy sink closure was proven on PR #31 candidate head `ae6db27ef3978ef306f5043a7b33c35f66b32bea`. The successful exact-head retry of Actions run `34696981584` passed static checks and the complete installed-extension Chromium matrix: v0.1/W1+W3, W2, W4, W5, baseline privacy, v0.2 privacy sinks, C1 Chat, named connections, attachments, C3 tools, C4 MCP, C5, and REL-01. The successful browser job was `103562856804`. Its evidence artifact is `10299102917`, digest `sha256:395986617d3c88c15860b110d4ec8f763c8edaeb395713c8b30fcd91792b9592`.

V02-B07 package integrity was proven on PR #33 candidate head `f673eb9454ea5d3f4879324b30bd7a30e0742d24` in Actions run `34699275822`. The candidate uses the committed npm lock with `npm ci --ignore-scripts`, builds a deterministic `browsercrew-v0.2-candidate.zip`, audits the manifest/runtime file boundary, loads the extracted ZIP as an installed MV3 extension, exercises the packaged PDF.js runtime, and performs a clean rollback to the previous known-good source while preserving the same extension identity and local BrowserCrew state. The certified package source-tree digest is `sha256:44258cf77c651e31597d7d486cf98ed9e5c812ac3615dbf6185af24be3b5f174`; the candidate ZIP digest is `sha256:e87dcaff80dca8515ac95f44e7213e86b13d92afd45b4d26e20e5baf35066bdb`.

The first browser attempt for run `34699275822`, job `103568091148`, passed package creation, package installation, rollback, W1–W5, both privacy suites, Chat, connections, attachments, tools, and MCP, then failed at C5 because the asynchronous connected-model selector had not populated the `conn-b` option before the test attempted selection; REL-01 was therefore skipped in that attempt. A rerun on the **same exact head** passed the full matrix, including C5 and REL-01, in browser job `103570478651`. The successful browser evidence artifact is `10299887560`, digest `sha256:09992e09750818dbac8663eadc5c6f130ac319f127577a15ac178533f9c5f45f`. The successful release-package evidence artifact is `10300032262`, digest `sha256:84e6a7541389120c4e0b51f8ca22e562af9182a9784c6d1c3cfb7bda4fb52d1a`.

V02-B04 Anthropic adapter closure was proven on PR #35 exact head `69e53db8758753a67cddeb5e6c7bd82007c3f7be` in Actions run `34703657309`. Static checks and the full installed-extension matrix passed, including package/rollback, W1–W5, both privacy suites, C1 Chat, named connections, attachments, C3 tools, the native Anthropic protocol suite, C4 MCP, C5, and REL-01. Browser job `103579726654` succeeded. The candidate browser evidence artifact is `10301626217`, digest `sha256:a43ce4a3217c5ea4b9d419ab64a74b2ea10d93b3f78175c61b57b415f473b538`; release-package evidence artifact `10301556456`, digest `sha256:5298121094c7430ca7c61da7e90dfc391f9ef69e5a8f94df7aea95ee3968dc58`.

PR #35 merged as `5819d6a631384caffd8749782e4401775cf66a02`. Merged-main Actions run `34703927607` then passed the same full matrix on that exact merge commit, browser job `103580453967`. Merged-main browser evidence artifact `10300847000` has digest `sha256:55cab162b547e58cd3bbd15c2b84f74be8831334785a288b1c8d001af8dbc3f8`; release-package evidence artifact `10300687356` has digest `sha256:1deb8d1b6d1ce28479c4823494adc6309c7e33645fe9465e698b7cf46c3c9481`. This closes the Anthropic **engineering adapter** blocker only; deterministic protocol evidence does not certify a live Anthropic account/model deployment and therefore does not close V02-B03.

Those runs prove representative controlled cases and the specific privacy/package/provider-adapter sinks described below. They do not by themselves satisfy every v0.2 release gate.

## Gate ledger

| PRD gate | Status | Evidence today | What still blocks release |
| --- | --- | --- | --- |
| Workflow completion | **Blocked** | Representative W1–W5 installed-Chromium cases pass | Execute all 25 scenarios in `tests/scenarios/v0.2.json` three times each and meet 68/75 overall with no workflow below 12/15 |
| Permission enforcement | **Partial** | Static contracts reject cookie/debugger/native-messaging expansion; W2/W4/W5 and C3/C4 enforce bounded resources and explicit write review | Add the remaining adversarial release-matrix cases for revoked grants, changed resources, hostile page instructions, and unauthorized requests |
| Recovery | **Partial** | W3, W4, W5, C4 uncertain-write recovery, C5 Stop, REL-01 interruption behavior, and release-package rollback have installed-browser proof | Cover every designated pre-dispatch, post-dispatch, and pre-checkpoint crash boundary in the release matrix |
| Duplicate writes | **Partial** | W3 recovery does not replay the field write; W4 save count remains one; W5 slow download receives one request; C4 uncertain writes are not replayed | Complete the full recovery matrix and retain destination-side event evidence for each write case |
| Result integrity | **Partial** | Current representative workflows attach source/verification evidence before completion; W2 exports retain schema/provenance and W5 manifests bind verified downloads to records | Run integrity assertions across every completed release scenario, including partial/blocked paths |
| Privacy | **Passed** | Baseline `scripts/privacy-smoke.mjs` plus `scripts/privacy-sinks-smoke.mjs` prove selected-page/model isolation, session-only provider credentials, W2 CSV/JSON sink safety, W5 durable/download/manifest sink safety, hostile provider-error redaction, History/local-storage safety, and canary-free evidence artifacts. C1 attachments, C3 tools, C4 MCP, C5, and Anthropic retain their own raw-context/durable-redaction checks in the same mandatory matrix. | No privacy blocker remains for the current v0.2 controlled release scope; rerun this gate on the final release candidate |
| Provider support | **Blocked** | Deterministic OpenAI-compatible endpoints exercise existing adapters; merged V02-B04 proof exercises the native Anthropic Messages request/stream/tool/cancellation/error contract in installed Chromium | Certify every provider advertised for v0.2 against live external deployments. Deterministic protocol fixtures do not certify live OpenAI, LM Studio, Ollama, or Anthropic services |
| Accessibility | **Machine-gated** | V02-B05 adds static accessibility contracts plus installed-Chromium keyboard, narrow-width, reduced-motion, modal-focus, status-region, and Chromium accessibility-tree coverage. | Pass the V02-B05 machine accessibility suite together with the complete existing quality matrix on one unchanged exact head. Manual NVDA/VoiceOver/JAWS review is an optional future enhancement, not a current release blocker. |
| Package integrity | **Passed** | Committed lockfile, `npm ci`, deterministic candidate ZIP, explicit runtime-only file manifest, source-tree/ZIP SHA-256 receipts, manifest-permission audit, extracted-package MV3 load, packaged PDF.js execution, clean rollback to the prior known-good source, same-extension identity, and local-state preservation are proven on exact head `f673eb9454ea5d3f4879324b30bd7a30e0742d24` | No package-integrity blocker remains for the current v0.2 controlled release scope; rerun package/rollback proof on the final release candidate |

## Current release blockers

`V02-B01` — 25-scenario catalog exists, but the required 75 model-assisted runs have not been executed and scored.

`V02-B02` — **Resolved on PR #31 candidate head `ae6db27ef3978ef306f5043a7b33c35f66b32bea`.** Exact-head installed-Chromium evidence covers provider-secret/session isolation, password/script/hidden/unselected context, unrelated durable context, W2 CSV/JSON exports, W5 durable task/download metadata/manifest, hostile provider-error echo redaction, History/local storage, and the privacy evidence artifact. Run `34696981584`, successful browser job `103562856804`, artifact `10299102917`.

`V02-B03` — The advertised-provider gate is incomplete. The automated environment may prove deterministic protocol contracts, but it does not certify live external OpenAI, LM Studio, Ollama, or Anthropic services.

`V02-B04` — **Resolved on PR #35 candidate head `69e53db8758753a67cddeb5e6c7bd82007c3f7be`.** Exact-head run `34703657309` passed the full matrix including native Anthropic protocol coverage; merged-main run `34703927607` passed the same matrix on merge commit `5819d6a631384caffd8749782e4401775cf66a02`. Merged-main browser artifact `10300847000`; release-package artifact `10300687356`. This resolves the adapter engineering blocker, not V02-B03 live-provider certification.

`V02-B05` — Machine acceptance only for the current release scope. Close this blocker once PR #37's static accessibility contracts, installed-Chromium accessibility smoke, and complete existing quality matrix pass on one exact head and the merged main is verified. Manual assistive-technology review is retained as optional future product QA.

`V02-B06` — Previous-stable Chrome coverage is not recorded; current CI installs one pinned Playwright Chromium build.

`V02-B07` — **Resolved on PR #33 candidate head `f673eb9454ea5d3f4879324b30bd7a30e0742d24`.** Run `34699275822` proved the locked install, deterministic package build, package-content/permission audit, installed candidate, packaged PDF runtime, and clean rollback. Successful retry browser job `103570478651`; browser artifact `10299887560`; release-package artifact `10300032262`; ZIP `sha256:e87dcaff80dca8515ac95f44e7213e86b13d92afd45b4d26e20e5baf35066bdb`; source tree `sha256:44258cf77c651e31597d7d486cf98ed9e5c812ac3615dbf6185af24be3b5f174`.

`V02-B08` — Chrome Web Store permission/disclosure review is outside the current automated proof and remains a public-distribution gate.

## Evidence rules

A release blocker may move to passed only when the repository points to reproducible evidence. Do not convert `representative` scenario coverage into a scored release run. Failed runs remain in the denominator. Do not replace an external-provider certification with a mock result. Machine accessibility evidence is the current V02-B05 acceptance contract; manual AT review can be added later without blocking this release scope. Do not call v0.2 complete while this document says `NOT READY FOR v0.2 RELEASE`.

When the final release candidate is ready, record the exact candidate commit, workflow run IDs, browser versions, provider/model versions, scenario results, machine accessibility evidence, and package artifact hashes here before tagging or store submission.