# BrowserCrew — implementation map for the supplied PRD

Source: **BrowserCrew-PRD-v0.1(2).md**, version 0.1, 11 September 2026, supplied by the user. The original attachment remains the canonical planning baseline. This file is an implementation map, not a replacement or a claim that all requirements are implemented. The workspace became unavailable before the exact attachment could be transferred to GitHub; copying that source verbatim is a documented follow-up.

Product promise: **Give your browser a job. Choose your AI. Stay in control.**

## Product and release boundaries

A Chrome extension accepts ordinary-language browser tasks, uses a user-selected local or cloud model, performs only authorized actions, and returns evidence. Start with one dependable agent. The extension uses the user's existing Chrome profile; it does not export cookies or sign-in sessions. User-only authentication remains manual.

| Release | Scope from the supplied PRD | Current implementation |
| --- | --- | --- |
| v0.1 feasibility | Side panel, task engine, cloud/local adapter, DOM actions, persistence, W1/W3 and crash safety | Initial W1 read and W3 form-preparation slices; real model trials outstanding |
| v0.2 MVP | Five workflows, provider matrix, tab coordination, screenshots, permissions, receipts, history, CSV/JSON | Not complete |
| v0.3 workflows | Declarative skills, project memory, remote MCP | Planned |
| v0.4 companion | Native messaging, approved stdio MCP, OS secret store | Planned |
| v0.5 specialists | Bounded coordinator and specialist agents; shared budget and tab/resource locks | Planned; no spawning in v0.1 |
| v0.6 automation | Demonstration-to-skill drafts, schedules, regression tests | Planned |
| v1.0 platform | Store distribution, hardening, migration/support process | Not a current release claim |

## Five validation workflows

- W1: compare five supplier pages with criteria, source URLs and missing values; do not contact suppliers.
- W2: extract a bounded paginated directory into CSV, with schema and duplicate handling.
- W3: prepare a business inquiry form from user-provided details; preview exact values before an applicable grant.
- W4: update one identified record, capture before/after, and verify the saved record.
- W5: collect selected invoices with browser download status and a record-to-file manifest.

This implementation supports W1's observed facts and W3's reviewed field population. W3 submission is not implemented. W2, W4 and W5 remain out of scope.

## Required contracts and acceptance map

| PRD requirement | Foundation state |
| --- | --- |
| TASK-01 | Goal, completion criteria, selected tabs, provider and step budget saved |
| TASK-02 | Bounded single-agent tool loop; action status and events saved |
| CTRL-01 | Pause/stop/takeover; model cancellation; reconcile in-flight form results |
| BRW-01 | DOM read and safe text-field filling; other actions unimplemented |
| BRW-02 | Isolated-world element references, document identity, field fingerprints |
| BRW-03 | Selected tabs, origin checks, one global writer; active-tab check before fill |
| BRW-04 | Browser downloads/uploads not implemented |
| AI-01 | OpenAI-compatible nonstreaming tool protocol; actual provider qualification pending |
| AI-02 | Real connection probe for one tool call; no vision/streaming certification |
| AI-03 | Step/time caps; reported-token budget; no guaranteed dollar cap |
| PERM-01 | Scope and action checks outside the model; explicit batch approval |
| DATA-01 | Bound provider destination, loopback-only local mode, no cloud fallback |
| REC-01 | IndexedDB checkpoints, durable intent, unknown-outcome blocking |
| VER-01 | Exact source text matching and immediate field checks; semantic/server-save checks incomplete |
| MEM-01 | Local task state and explicit connection/theme preferences; inspect/export/delete |
| EXP-01 | Receipt and fact exports; CSV formula hardening |
| SKL-01 / MCP-01 / AGT-01 | Later releases; no hidden or placeholder execution |

## Hard boundaries

No arbitrary JavaScript tool, eval, shell, cookie extraction, CAPTCHA bypass, password-field operation, autonomous purchase, mass messaging, unbounded agents, remote executable skill, or unrestricted file access. No claim of controlling every page.

Cloud destinations require HTTPS. Local HTTP is explicit loopback only. No LAN scanning. Session-only model credentials never enter page scripts, task memories, raw error messages or prompts. ChatGPT/Claude consumer subscriptions are not assumed to fund extension calls.

## Recovery and verification

Persist the write intent before dispatch. A terminated or uncertain write becomes outcome_unknown. Never automatically repeat it. Re-observe after resuming a read task; invalidate review after changed document/field state. Controls stop new actions; they do not reverse website effects.

A completed state in this feasibility implementation means the declared mechanical checks passed. Exact quote matching is not proof that a page is truthful or that the AI fully satisfied arbitrary natural-language criteria. Field equality is not proof of a saved server record.

## Release gates from the supplied baseline

The full MVP requires 25 controlled scenarios (five per workflow), three model-assisted runs each, at least 68/75 successes and at least 12/15 per workflow. It also requires zero unauthorized dispatches in the defined suite; safe crash reconciliation; zero duplicate commits; evidence for every criterion; zero seeded secret leakage to unauthorized sinks; declared provider tests; accessibility review; and exact-commit package, build, type, lint, unit, integration and smoke evidence.

The current deterministic tests do **not** satisfy the 75-run model-assisted benchmark. No live cloud/local or Windows validation is claimed. See TEST-PLAN.md and FEASIBILITY.md.

## Architecture decisions

Module boundaries follow the PRD. See adr/001-feasibility.md for the explicit native-module framework deviation, provider subset and 30-day feasibility retention. These choices do not broaden authority. Preserve the attached canonical requirements before expanding the implementation.
