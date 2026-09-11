# v0.1 feasibility report

Date: 2026-09-11

## Status

**v0.1 workflow feasibility is certified on controlled fixtures in installed Chromium.**

BrowserCrew now demonstrates the two v0.1 PRD workflows plus the controlled-write recovery boundary in a real Manifest V3 extension runtime. Certification is produced by the repository `quality` workflow, not by static source inspection alone.

## Implemented scope

- Direct-load Manifest V3 extension shell and side panel.
- NeoBrutal Soft interaction and accessibility rules.
- OpenAI-compatible provider path with OpenAI, LM Studio, and Ollama presets.
- Session-only provider secret handling.
- Per-origin selected-site access model in the production extension.
- Bounded DOM-text observation.
- General read-only fact extraction with page-text verification and source evidence.
- **W1 supplier comparison:** choose 2–5 open pages, compare up to 8 criteria, verify returned values against each captured page, mark missing values, preserve source links, support partial completion and Stop.
- **W3 form preparation:** inspect supported form fields, map only user-provided details, show exact Before → After preview, bind one approval to one SHA-256 change set, fill approved fields only, and verify the resulting page state.
- No automatic form submission in W3.
- Durable task journal/history and local memory inspection.
- Controlled-write intent journaling before dispatch.
- Recovery that reconciles an uncertain controlled write instead of replaying it.
- Five controlled supplier fixtures and one controlled form fixture.

## Automated verification

The `quality` workflow has two required layers:

1. **Static and contract checks**
   - `node --check` for extension/runtime modules and the browser-smoke script.
   - Manifest V3 and permission checks.
   - Guardrails against cookie access, debugger/native-messaging/download privileges, and programmatic form submission primitives in the controlled writer.
   - Required W1/W3 runtime contracts, fixtures, approval hashing, write journaling, recovery hooks, source evidence, missing-value cases, and UI wiring.

2. **Installed-extension Chromium smoke checks**
   - Playwright loads the unpacked production extension in a persistent Chromium profile.
   - The side panel and MV3 service worker load successfully.
   - A deterministic local OpenAI-compatible provider completes the connection path.
   - W1 compares all five controlled supplier pages for price, minimum order, lead time, and shipping; the result contains five source-linked rows, literal verified values, and explicit missing cells.
   - W3 previews and fills approved name/email/message values while the controlled fixture records normal input events and **zero submissions**.
   - The completed W3 task remains inspectable after the side panel is closed and reopened.
   - A second W3 write is interrupted by terminating the MV3 service worker during the uncertain-write window; recovery reaches a safe state and the test proves the write is **not replayed** and the form remains unsubmitted.

The first full green installed-extension evidence run was GitHub Actions run `34641335077` on branch head `f6850dcaf7e83783264f48e204ace001a79812e8`. The browser-smoke job uploaded `report.json` and a final side-panel screenshot as the `browser-smoke-evidence` artifact.

## What this certification does not claim

- It does **not** certify Chrome Web Store review or policy approval.
- It does **not** certify every arbitrary public website; v0.1 proof uses repository-controlled localhost fixtures so results are deterministic.
- It does **not** certify a real OpenAI, LM Studio, or Ollama deployment over the network; the installed-extension smoke test uses a deterministic local OpenAI-compatible stub. Provider adapters and the connection path are exercised, but external-service availability remains environment-dependent.
- The automated smoke run pre-grants only the two localhost test origins in a temporary test copy of the manifest so CI is not blocked by browser permission dialogs. The production manifest remains unchanged and still uses optional host permissions. A dedicated UI-level allow/deny permission-prompt test remains useful follow-up coverage.
- v0.1 does not expose a multi-agent runtime, arbitrary MCP/tool-server execution, or automatic irreversible submission actions.

## v0.1 exit decision

The PRD's core feasibility gate is met for controlled evidence: W1 works across five pages with source-linked verified data, W3 requires scoped approval and never submits automatically, task history persists across panel closure, and an uncertain controlled write is reconciled without duplicate replay.

The next development milestone should build on these certified primitives rather than widening privileges: add the next bounded workflow and extend browser coverage alongside it.
