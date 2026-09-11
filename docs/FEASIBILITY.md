# v0.1 feasibility report

Date: 2026-09-11

## Implemented in this commit

- Direct-load Manifest V3 extension shell.
- Side panel interaction using NeoBrutal Soft design rules.
- OpenAI-compatible provider path with OpenAI, LM Studio, and Ollama presets.
- Session-only secret handling.
- Selected-tab site-access request.
- Bounded DOM-text observation.
- Product-name/price extraction and evidence receipt.
- Durable task journal/history.
- Worker-start recovery that pauses uncertain in-flight tasks instead of replaying them.
- Controlled read and form fixtures.

## Static verification performed

Repository JavaScript is checked with `node --check` before commit. Manifest JSON is parsed before commit. The HTML fixture and side-panel markup are inspected as source.

## Not yet certified

This environment cannot launch Chrome or contact GitHub/npm from the execution sandbox, so this commit does **not** claim packaged-extension browser QA or real provider certification. Connection behavior is implemented and must be exercised manually or in CI on the exact commit.

The arbitrary selected-site permission flow also needs a Chrome runtime check. Store-review behavior is not claimed.

## Next issue

Add automated Chrome extension smoke coverage (Playwright + installed extension) for: open side panel, select localhost fixture, deny/allow site permission, test local provider stub, run extraction, restart worker/browser context, and confirm history survives without replay.

After that passes, add the W3 form-preparation fixture with a scoped commit grant and crash reconciliation around the single write.
