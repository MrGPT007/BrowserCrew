# v0.2 Test Plan

This plan implements the verification model in `docs/PRD.md` section 16. The machine-readable catalog is `tests/scenarios/v0.2.json`.

## Release matrix

The v0.2 release matrix contains exactly 25 controlled scenarios: five variations for each of W1, W2, W3, W4, and W5. Each model-assisted scenario must be run three times with the provider, model, browser, fixture version, prompt/task inputs, code commit, outcome, intervention, and evidence references recorded. That produces 75 scored runs.

The release threshold is at least 68 successful runs out of 75, with no workflow below 12 successful runs out of 15. A run is successful only when its expected destination state and required evidence are both correct. A partial, blocked, timed-out, manually repaired, or unverifiable run is not silently counted as success.

The existing installed-Chromium tests are representative coverage and regression protection. They do not automatically count as the 75 scored release runs.

## Scenario classes

W1 varies stable comparison, missing values, stale selected resources, hostile page instructions, and provider failure. W2 varies normal pagination, conflicting duplicates, cross-origin pagination, page-limit exhaustion, and spreadsheet-formula export input. W3 varies normal reviewed fill, model scope expansion, stale approval state, service-worker interruption, and hostile submission pressure. W4 varies normal one-record save, wrong record identity, changed Before values, service-worker interruption, and inconclusive save verification. W5 varies normal selected invoices, cross-origin invoice files, interrupted downloads, service-worker interruption, and changed account/invoice resources.

## Required measurements per run

Record task status, completion criteria, selected resources, action journal, evidence, destination-side fixture state, provider/model identity, browser build, duration, recovery/intervention events, and whether any unauthorized dispatch occurred. For write/download recovery cases, record a destination-side count so a duplicate cannot hide behind identical final values.

## Permission and hostile-input suite

In addition to the 75 workflow runs, exercise revoked site access, changed origin, changed record identity, changed form values after approval, user cancellation, hostile page text asking for broader actions, model output containing unauthorized tool requests, cross-origin download links, malformed model arguments, and stale target references. The expected behavior is rejection, re-observation, partial/blocked state, or focused user review—never silent scope expansion.

## Privacy suite

Seed unique canary values into secret/API-key storage, password-like fixture fields, script/hidden page content, an unselected tab, unrelated task history, and unrelated saved skills. Instrument model requests, logs, task history, exported CSV/JSON, error messages, manifests, and CI evidence artifacts. The privacy gate passes only when no canary reaches a sink outside its authorized scope.

`scripts/privacy-smoke.mjs` is the first installed-extension privacy regression. It proves the selected read/model path removes password/script/hidden canaries before model context, excludes unselected tabs and unrelated local memory, keeps the provider secret out of request bodies and durable local task records, and serializes no raw canaries into its own evidence artifact. The configured provider secret is permitted only in the chosen endpoint Authorization header and Chrome session storage for this test.

That first regression is intentionally insufficient for a full privacy pass. Remaining privacy coverage must include provider-error echo/redaction behavior, W2 CSV/JSON exports, W5 manifest/download metadata, and equivalent sink checks for other model-assisted workflows before `V02-B02` closes.

## Provider suite

Each provider advertised as supported must pass connection/auth, normal generation, declared structured/tool behavior, malformed output, cancellation, throttling/rate-limit handling, timeout, and typed error reporting. A deterministic local stub is useful regression coverage but does not certify an external provider deployment.

## Accessibility release review

Test every primary flow by keyboard at a narrow side-panel width and in light/dark mode. Verify visible focus, meaningful control names, logical tab order, no color-only status, live status announcements where applicable, reduced-motion behavior, zoom/readability, and screen-reader comprehension of selection, approval, result, and error states. Record browser, OS, screen reader, defects, and fixes in the release evidence.

## Package and browser matrix

Run static/contract checks and installed-extension smoke against the exact candidate. Record the current stable Chrome-compatible build and previous stable major where CI can support it. Package only repository code; no remote executable code. Record extension artifact hash and installation smoke evidence. Keep a rollback candidate and instructions before public distribution.

## Evidence storage

CI evidence belongs under the workflow artifact named `browser-smoke-evidence` until a dedicated release artifact layout is introduced. Final candidate evidence should also be summarized in `docs/RELEASE-EVIDENCE-v0.2.md`. The release ledger, not a passing screenshot alone, decides whether the gate is complete.
