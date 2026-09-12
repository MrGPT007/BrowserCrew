# Supported Workflow Matrix

BrowserCrew currently has five **controlled adapter contracts** with installed-extension Chromium regression evidence. This is not a claim that arbitrary websites are supported. A live site is supported only after its required resource identity, fields/actions, permission boundary, and verification evidence are known and tested.

| Workflow | What the certified adapter does | Current hard boundary | Completion evidence |
| --- | --- | --- | --- |
| W1 · Compare suppliers | Compare 2–5 selected open supplier pages against up to 8 criteria; report missing values and source links | Read-only; selected tabs; no supplier contact | Captured page values traced to each selected source URL |
| W2 · Extract directory | Follow same-origin pagination from one selected start page; up to 10 pages, 12 columns, and 200 rows observed per page; deduplicate with explanations; export CSV/JSON | Same-origin pages only; user-declared schema/page limit; no arbitrary crawl | Per-page source evidence, row provenance, duplicate report, safe CSV/JSON |
| W3 · Prepare inquiry form | Map user-provided details to supported fields, show Before → After preview, require one scoped approval, then fill approved fields | Does **not** submit the form; values must come from supplied user details | Post-fill field observation; controlled fixture confirms zero submissions |
| W4 · Update one record | Identify one supported record, preview exact field changes, bind approval to record + values, press the bounded Save action once, verify result | One identified record; supported editable fields; one bounded Save control | Record identity + resulting field values + independent page save receipt |
| W5 · Collect invoices | Confirm account, enumerate supported invoice records, let user select up to 20, download same-origin PDFs through Chrome, export manifest | Same-origin PDFs only; exact selected invoice IDs; no unrestricted filesystem read | Chrome complete state + exact source URL + file existence + positive bytes; manifest provenance |

## General page read slice

The original read-only feasibility slice remains available for a selected `http`/`https` page: BrowserCrew reads a bounded text snapshot and asks the configured OpenAI-compatible model path for structured facts, then verifies returned values against captured source text. This is a feasibility capability, not an unlimited browser-agent compatibility claim.

## Unsupported or not yet certified

BrowserCrew does not currently certify arbitrary websites, cross-origin invoice CDNs, CAPTCHA handling, autonomous purchases/payments, destructive actions, account-security changes, mass messaging, unrestricted form submission, cookie access, arbitrary JavaScript execution, shell/OS control, arbitrary uploads, or unrestricted filesystem access.

A page that does not expose the contract required by a workflow must fail as unsupported or require user assistance; BrowserCrew must not guess selectors/actions and silently widen authority.

## Provider wording

The UI contains OpenAI, LM Studio, and Ollama connection presets through an OpenAI-compatible request path. See `docs/PROVIDER-MATRIX.md` before describing any external provider as certified. Anthropic is required by the PRD MVP target but is not implemented yet.

## Release wording

The five rows above are representative controlled-workflow certifications. v0.2 release readiness additionally requires the 25-scenario/75-run, privacy, permission, provider, accessibility, browser, and package gates tracked in `docs/RELEASE-EVIDENCE-v0.2.md`.
