# BrowserCrew Product Requirements Document

Version 0.1 · 11 September 2026 · Development planning baseline

Status: Proposed requirements ready for feasibility work. No implementation, repository, provider certification, or benchmark result is implied by this document. Requirements and numerical gates below are proposed product decisions, not measured performance.

## 1 Product decision

Build a Chrome extension that accepts a browser task in ordinary language, uses a user-selected local or cloud model to execute permitted actions, and returns evidence of what was completed. Start with a dependable single-agent workflow. Add reusable skills, MCP tools, and coordinated specialists in subsequent releases without changing the core task and permission contracts.

The product serves people who repeatedly move information between websites, research options, extract records, and prepare web forms. Its core value is verified work that can resume after interruption.

Product promise: **Give your browser a job. Choose your AI. Stay in control.**

The MVP runs in the user's existing Chrome profile and uses its normal signed-in website sessions. It does not export those sessions to model providers. It pauses when authentication or a user-only interaction is required.

## 2 Name and positioning

Recommended working name: **BrowserCrew**. It describes the environment and accommodates both one assistant and a coordinated team of agents. Suggested repository slug: `browsercrew`. Suggested short description: “A browser assistant with your choice of AI, reusable workflows, and verified results.”

Alternatives are **TabCrew**, for a shorter tab-focused identity, and **BrowseRelay**, for an emphasis on handoffs and continuity. These are creative candidates only. A preliminary web search did not establish availability. Domain, extension-store, repository, package, and trademark checks remain required before committing to a public brand. Do not imply affiliation with Chrome, OpenAI, or Anthropic.

Use BrowserCrew as a replaceable display name; stable protocol and data identifiers must not depend on branding. Naming is not a blocker for the prototype.

## 3 Users and first jobs

Primary user: an individual operator, founder, researcher, or assistant who works in several web applications and wants repetitive tasks completed with fewer manual steps. Secondary user: a technical user who wants local inference, custom endpoints, and inspectable workflows.

The following five workflows define initial validation. Use controlled fixture websites first and consenting accounts on supported live websites second.

| ID | User job | Required result | Boundary |
| --- | --- | --- | --- |
| W1 | Compare five supplier pages against specified criteria | Comparison table, source URLs, missing values identified | No supplier contact |
| W2 | Extract a paginated directory into CSV | Rows follow a declared schema and duplicates are explained | User-provided target and bounded page count |
| W3 | Fill a business inquiry form using provided details | Correct preview of populated fields | Submission requires an applicable grant |
| W4 | Update one record in a web application | Before and after values and verified saved record | Confirm account, record identity, and change scope |
| W5 | Collect selected invoices from an account portal | Download results and manifest linking files to records | Browser-supported downloads; no unrestricted disk access |

Users can give other tasks, but the interface must identify unsupported operations and partial outcomes. Public release claims must name the tested workflows and environment.

## 4 Goals and exclusions

### Goals

1. Complete the supported jobs with observable success checks.
2. Support one cloud provider and one local server in the feasibility milestone, expanding to the MVP adapter matrix below.
3. Preserve exact task progress across service-worker suspension and browser restarts.
4. Keep action permissions and data-sharing permissions under user control.
5. Make specialist agents, memory, skills, and tools interoperable through versioned contracts.
6. Give users useful results without requiring knowledge of agent terminology.

### Exclusions from MVP

No unrestricted operating-system control, arbitrary shell execution, CAPTCHA bypass, credential extraction, autonomous payments, mass outbound messaging, downloadable executable skills, cloud browser hosting, team accounts, marketplace, demonstration recording, or unbounded agent creation. No guarantee of controlling every Chrome page or website.

No promise that ChatGPT or Claude consumer subscriptions can fund this extension's model calls. Implement such a route only after validating official support for this exact third-party use. API access and supported subscription access are separate connection types. OpenAI documents separate billing for ChatGPT and its API [S5].

## 5 Release scope

| Release | Included capabilities | Exit condition |
| --- | --- | --- |
| v0.1 feasibility | Side panel, task engine, one cloud adapter, one local adapter, DOM actions, optional debugger experiment, persistence, controlled fixtures | Demonstrate W1 and W3 plus crash recovery without duplicate submission |
| v0.2 MVP | All five workflows, provider matrix, tab coordination, screenshot fallback, permission grants, receipts, local task history, CSV and JSON export | Meets the release gates in section 16 |
| v0.3 workflows | Versioned declarative skills, project memory, remote MCP client, connection permissions, safe import and export | Repeat parameterized skills and recover an interrupted MCP session |
| v0.4 local companion | Native messaging bridge, approved local stdio MCP servers, OS-backed secret storage, heavier execution support | Authenticate bridge, restrict capabilities, survive companion disconnect |
| v0.5 specialists | Coordinator, independent specialist tasks, reviewer role, role-based models, tab and account conflict controls | Demonstrated quality or latency benefit within the same budget |
| v0.6 automation | Demonstration-to-skill drafts, schedules, workflow regression tests | User-reviewed skills repeat with new inputs; missed schedules handled explicitly |
| v1.0 public platform | Hardened installer and store release, supported-site documentation, migration and support process | Public acceptance and distribution gates pass |

Team collaboration, marketplace, optional hosted browsers, and cross-device synchronization follow demonstrated demand. Release numbers express sequence, not promised dates. Estimate delivery after v0.1 establishes technical risks.

## 6 User experience

### Onboarding

1. Explain what the assistant can read and change in plain language.
2. Let the user choose local AI or a cloud connection. Do not require a BrowserCrew account for MVP.
3. Ask for the endpoint, model, and authentication only when needed. Provide connection presets with editable advanced fields.
4. Run connection and capability tests. Report actionable failures without exposing secrets.
5. Request browser access when the user selects a site for work.
6. Run a small demonstration on a bundled fixture page.

### Task flow

The user enters a goal, selects tabs or starting URLs, supplies inputs, chooses an autonomy mode, and optionally sets a budget. The assistant creates a concise plan and defines what counts as done. Read-only work within the user's grant starts immediately. Missing material inputs generate one focused question.

While running, show current step, site, progress, cost estimate, and Pause, Take over, and Stop. A closed side panel does not erase the task. On completion, show verified results, unresolved items, changed records, downloaded files, and supporting evidence.

### Autonomy modes

| Mode | Behavior |
| --- | --- |
| Guide me | Explain proposed actions; user performs changes |
| Prepare for review | Read, research, and populate supported forms; obtain a scoped grant before committing changes |
| Run within my rules | Perform actions covered by existing site, resource, action, and budget grants; ask only when scope expands |

Default to Prepare for review. Persist grants only when the user selects persistence. A grant for one recipient, record, or transaction must not authorize unrelated actions. Reuse valid grants without repeatedly interrupting the same task.

Required screens: connection setup, new task, active task, review change, results, task history, settings. Later releases add skills, memory management, MCP connections, and schedules. Support empty, loading, running, paused, blocked, failed, cancelled, partially completed, and completed states. Support light and dark themes, keyboard operation, visible focus, reduced motion, and readable layouts at a 320 CSS pixel sidebar width. Do not use color alone for status.

## 7 MVP functional requirements

P0 means mandatory for MVP. P1 means the named later release, not an optional hidden MVP dependency.

| ID | Priority | Requirement | Acceptance criterion |
| --- | --- | --- | --- |
| TASK-01 | P0 | Capture goal, inputs, sites, output schema, autonomy, and budgets | Saved task contains explicit completion criteria and selected scope |
| TASK-02 | P0 | Plan and execute bounded steps | Every step has a status and task reference; exhaustion pauses with a reason |
| CTRL-01 | P0 | Pause, stop, and take over | No new action is dispatched after cancellation is recorded; an in-flight action is reconciled and reported |
| BRW-01 | P0 | Observe and operate supported pages | Handles navigation, read, click, type, select, scroll, and condition-based waiting in fixtures |
| BRW-02 | P0 | Use stable target references | Stale references fail safely or cause fresh observation; no blind click at old coordinates |
| BRW-03 | P0 | Coordinate selected tabs | A write lock prevents competing actions; focus changes by the user are detected |
| BRW-04 | P0 | Handle downloads and user-selected uploads | Track download status; never treat a filename alone as proof of successful download |
| AI-01 | P0 | Normalize provider interactions | Cloud and local paths pass common text, tool-call, error, cancellation, and usage tests |
| AI-02 | P0 | Test model capabilities | Setup reports tool, schema, and vision capabilities from tests; incompatible tasks cannot silently proceed |
| AI-03 | P0 | Bound inference costs | Token and step limits are enforced; money estimates identify price source and uncertainty |
| PERM-01 | P0 | Enforce scoped grants outside the model | Unauthorized tool requests are rejected by code even if a model requests them |
| DATA-01 | P0 | Restrict data sent to AI | Only approved task context reaches approved endpoints; local-only jobs never use cloud fallback |
| REC-01 | P0 | Journal actions and resume | Crash tests at pre-action and post-action boundaries do not duplicate uncertain writes |
| VER-01 | P0 | Verify outcomes | Completed state requires evidence matching task criteria; otherwise partial or blocked |
| MEM-01 | P0 | Persist task state and explicit preferences | User can inspect, export, and delete these records; credentials are excluded |
| EXP-01 | P0 | Export results | CSV and JSON retain schema and source references; spreadsheet formula injection is neutralized in CSV |
| SKL-01 | P1 v0.3 | Execute validated declarative skills | Schema validation, permissions, version selection, and success checks precede execution |
| MCP-01 | P1 v0.3 | Connect remote MCP tools | Tool schemas, identity, auth, budgets, and permissions are enforced before dispatch |
| AGT-01 | P1 v0.5 | Spawn bounded specialist configurations | Child scopes are subsets of parent scopes; cap and shared budget cannot be exceeded |

## 8 Provider contracts

MVP targets: an OpenAI API adapter, an Anthropic API adapter, and an OpenAI-compatible endpoint adapter validated against one LM Studio setup and one Ollama setup. Compatibility means the tested subset, not all provider-specific features. Endpoint behavior and browser access must be confirmed during the feasibility milestone. Pin tested versions in the repository.

The common adapter exposes model discovery where available, capability probing, streaming generation, normalized tool calls, cancellation, usage, and typed errors. Manual model entry remains available. Tool arguments are parsed and validated before execution; malformed output gets at most one repair attempt for that inference step.

MVP uses one selected model per task. A user may resume on another permitted provider after failure. Automatic routing and different models per role arrive with specialists. Changing provider never transfers private context without the relevant data grant.

For cloud connections, require HTTPS. Permit explicit loopback HTTP for a local model server; remote private-network HTTP is outside default scope. Do not expose endpoint credentials to content scripts. Local discovery must use explicit presets or user-entered endpoints rather than scanning the network.

Subscription connection cards remain unavailable until a documented official integration exists and has passed a proof of concept. Do not extract browser cookies or reuse provider CLI credentials as an assumed subscription API.

## 9 Technical architecture

Recommended implementation baseline: TypeScript, Manifest V3, a React side panel, a Vite-based build, and IndexedDB for task and evidence records. These are proposed choices; pin exact versions during scaffold work. Choose the smallest build setup that passes extension loading and packaged-worker tests.

| Module | Responsibility | Trust boundary |
| --- | --- | --- |
| Side panel | Task input, permissions, status, review, settings | User input; render external content as data |
| Background service worker | Event handling, execution coordination, connections | Validates all incoming messages |
| Task engine | Plan state, budgets, journal, recovery, verification | Cannot bypass the policy layer |
| Policy layer | Origin, resource, action, data, and budget checks | Final authorization before every dispatch |
| Browser adapter | DOM and accessibility observations, supported actions, debugger fallback | Revalidates tab, document, and target |
| Content scripts | Narrow page observations and vetted actions | Treat page DOM and events as untrusted |
| Provider adapters | Model requests and response normalization | Secrets available only in trusted extension contexts |
| Storage | Task state, evidence, preferences, versioned migrations | Never store raw model credentials as memories |
| MCP adapter | Tool discovery and invocation in v0.3 | Descriptions and results are untrusted data |
| Companion bridge | Native messaging in v0.4 | Explicit extension identity and capability checks |

Chrome's side-panel API provides the proposed persistent UI surface [S1]. The debugger API exposes selected DevTools capabilities and requires a declared permission; it does not provide unrestricted Chrome access [S2]. Prototype DOM-first operation and advanced debugger operation separately, then document which supported workflows require the advanced permission. Do not hide Chrome's control indicators.

Service-worker lifetime is not a durability mechanism. Save state at transition boundaries and expect termination [S3]. Register event listeners at worker initialization. Resume only after checking current tabs, document identities, grants, and potentially committed actions.

The companion is not required for the initial extension. Native messaging is the proposed path for later process-based local tools [S4]. It must not become a generic unauthenticated localhost shell service. A companion alone does not make browser jobs run when Chrome is closed; a separate browser execution environment would be needed for that feature.

### Browser tool surface

Expose narrow typed tools: `tabs.list`, `tabs.open`, `page.observe`, `page.read`, `page.click`, `page.type`, `page.select`, `page.scroll`, `page.waitFor`, `page.capture`, `downloads.inspect`, and `task.requestInput`. Add a specific commit action wrapper for forms and application writes, with verification metadata.

The public model-facing tool surface must not contain arbitrary `eval`, unrestricted script execution, cookie export, or unrestricted filesystem reads. Trusted bundled adapter code may use necessary browser APIs within the same policy boundaries.

Observation references include tab ID, document identity, origin, observation timestamp, and target reference. Before acting, check the current document and expected target. If page state changed materially, observe again. Screenshots inherit the page's privacy restrictions and must be cropped or redacted when required; if safe redaction is uncertain, request a different observation or user assistance.

## 10 Task state and recovery

Task states: `draft`, `planning`, `running`, `awaiting_approval`, `awaiting_user`, `paused`, `recovering`, `completed`, `partially_completed`, `failed`, and `cancelled`.

Only the execution engine changes durable task state. The model proposes actions. The policy layer authorizes them. The browser or MCP adapter executes them. Verifiers supply observations. The engine decides whether completion criteria are satisfied.

Each write follows this sequence:

1. Validate parameters, resource identity, grant, budget, and current page state.
2. Persist an action intent with a unique ID and available deduplication information.
3. Dispatch the action once and record its returned status.
4. Observe the affected resource and evaluate the expected postcondition.
5. Persist evidence and advance the checkpoint.

If the process stops after dispatch but before confirmation, mark the action `outcome_unknown`. On recovery, inspect the resource before any retry. Browser interactions do not generally support exactly-once guarantees; when reconciliation is inconclusive, ask for user review. Use API idempotency keys only where the destination actually supports them.

Read-only transient failures may retry at most twice with backoff. Write retries require evidence that the previous attempt did not commit. Repeated unchanged observations or repeating action patterns trigger a loop stop. Default prototype limits are 50 actions, 10 minutes, and two recovery attempts per step; make these editable within configured product limits. Cost caps use provider token limits and bounded in-flight requests, with a disclosed possible final-request estimation margin.

Pause stops new dispatches after the current action is reconciled. Stop cancels available model and tool requests and records unresolved effects. Take over additionally releases browser control and marks task state stale until a fresh observation. None of these buttons promises reversal of actions already accepted by a website.

## 11 Data contracts

All persisted entities carry an ID, schema version, creation time, and update time. Store UTC timestamps and explicit references instead of duplicating secrets or full pages.

| Entity | Required fields beyond common metadata |
| --- | --- |
| Task | goal, inputs, completionCriteria, status, selectedResources, providerRef, grants, budgets, checkpointRef |
| Step | taskId, purpose, dependencies, status, attemptCount, actionRefs, evidenceRefs |
| Action | taskId, stepId, toolName, redactedArgs, resourceIdentity, grantRef, status, dedupeKeyIfSupported, outcome |
| Observation | taskId, origin, documentRef, observedAt, contentRef, redactionState, trustClass |
| Evidence | taskId, claim, sourceUrl, observedAt, resourceRef, observationRefs, verificationMethod |
| Grant | origins, resourceScope, actionClasses, dataDestinations, expiresAt, remainingBudget, revocationState |
| Provider | adapterType, endpoint, modelId, capabilities, credentialRef, lastTestedAt |
| Memory | type, projectId, value, provenance, confidence, expiresAt, userConfirmed, sensitivity |
| Skill | version, inputsSchema, outputSchema, instructions, tools, permissions, successChecks, testRefs |
| Agent | parentTaskId, assignment, providerRef, permittedTools, grantSubset, budgetSlice, status |

Schemas live in a shared contracts package and are validated at UI, storage, provider, and tool boundaries. Add migration tests before changing a shipped schema. Unknown incompatible versions must be rejected without destroying stored data.

## 12 Memory and skills

MVP memory consists of resumable task state and explicit preferences. v0.3 adds project knowledge and workflow lessons. Begin with structured records and full-text retrieval; add embeddings only when a benchmark demonstrates better retrieval. Retrieval does not replace the authoritative action journal.

Memory must be scoped by project and task purpose. Users can inspect provenance, correct facts, pin preferences, set expiry, export, and delete records. Page-derived observations remain untrusted until explicitly confirmed or corroborated. A website cannot grant permissions or rewrite user preferences by placing instructions in its content.

Default proposal: keep task metadata until deletion, auto-expire raw page snapshots after seven days, and retain redacted receipts for 30 days. Let users shorten retention or disable persistent content capture. Deletion removes dependent local evidence and retrieval-index entries. Explain that deleting local records cannot retract content already sent to a cloud provider.

Skills are versioned declarative bundles with parameter schemas, allowed tools, instructions, success checks, and regression fixtures. They may sequence vetted bundled actions. Importing a skill never grants its requested permissions. Changed permissions or tool definitions invalidate previous approval where relevant.

A model-created skill starts as a draft, runs against controlled data, and requires user acceptance before general reuse. Downloadable JavaScript and arbitrary remote executable skill code are excluded; Manifest V3 remote-code constraints inform this design [S6]. Demonstration recording in v0.6 must visibly start and stop and exclude passwords and unrelated browsing.

## 13 MCP and specialist agents

v0.3 implements an MCP client for a pinned and negotiated protocol version using Streamable HTTP. v0.4 adds stdio servers through the companion. The referenced MCP transport specification describes these distinct transports [S7]. Legacy transport support is not automatic scope.

A connection records endpoint identity, auth method, tool schemas and versions, data scope, and per-tool grants. Use the applicable official authorization flow; keep credentials bound to their intended server and audience. Validate redirects and block access to unintended local services. Do not forward arbitrary provider tokens to MCP servers. Treat remote tool descriptions as untrusted input. A successful connection test does not authorize all tools.

Test authentication expiry, malformed schemas, changed tools, interrupted streams, duplicate messages, cancellation, and writes with unknown outcomes. Retry a tool write only when its semantics and evidence permit it. Maintain separate discovery and execution permissions.

Specialists in v0.5 are temporary agent configurations assembled from existing models, skills, and tools. The coordinator assigns bounded work and collects structured results with evidence. Initial concurrency cap: three specialists. Recursive spawning is disabled. All agents consume a common budget; each child receives a narrower or equal grant.

One writer owns a tab at a time. Mutations that share an account, cart, or record also require a resource-level lock. Parallel reads are permitted only when browser actions do not invalidate other observations. A reviewer checks results against criteria and evidence; another model agreeing is not sufficient proof of success.

## 14 Security and permissions

The threat model includes prompt injection in pages and tool descriptions, malicious extensions or local software, compromised MCP endpoints, cross-account mistakes, leaked screenshots, and duplicated writes. Do not claim complete prevention; implement enforceable boundaries and test known failure classes.

Request minimum required permissions. Candidate baseline permissions are `sidePanel`, `storage`, `activeTab`, and `scripting`; add tab metadata, downloads, debugger, endpoint host access, and later native messaging only where justified by tested functionality. Produce a manifest permission inventory in v0.1. Support explicit site allowlists and revocation during a run.

The policy layer checks current origin, document, resource identity, action category, destination, and grant immediately before dispatch. New cross-origin navigation requires permitted observation scope. External page text cannot modify that policy. Content-script messages must have validated schemas and trusted sender tab and frame context; websites cannot dispatch privileged tools by posting messages.

MVP cloud credentials default to memory/session-only storage in trusted extension contexts. Persistent encrypted storage, if offered, uses a user-unlocked vault with the unlock key excluded from persistent storage. Do not market browser storage as an OS secure vault. The companion later uses the platform's credential facilities. Passwords, cookies, auth headers, and secret form fields must not appear in logs, memories, receipts, or model prompts.

Purchases, account security changes, destructive actions, and outbound communication require explicit scope-specific authorization and may remain unsupported initially. A bulk approval shows affected records and exact proposed changes. Changing those details invalidates the approval. No action bypasses website access controls or browser restrictions.

## 15 Quality and operational requirements

Use accessible semantic controls and test primary flows with keyboard and screen-reader navigation against WCAG 2.2 AA expectations. Show visible control state while the agent operates. Keep the UI responsive independently of model latency. Proposed targets: local acknowledgement of Pause or Stop within 250 ms at p95, and no subsequent dispatch after its durable cancellation event.

Logs contain event IDs, typed errors, timings, and redacted metadata. Raw prompts, DOM, screenshots, and credentials are excluded from telemetry by default. Product telemetry is opt-in and never required for local operation. Crash reports need a redacted preview before sharing.

Browser compatibility begins with a documented current stable Chrome build and the previous stable major in CI where supported. Windows is the first local-server validation environment; cross-platform extension behavior still needs smoke checks. Companion platform support is decided separately. No Edge, Brave, or Firefox compatibility claim until tested.

Package deterministic builds with a lockfile, dependency review, no remote executable code, extension permission documentation, and a rollback procedure. Check store policy compliance before requesting wide installation. Store approval is an external gate, not an assumed outcome.

## 16 Verification and release gates

Build 25 controlled scenarios, five variations for each initial workflow. Include dynamic content, missing data, pagination, session expiry, stale elements, and ambiguous writes. Measure model-assisted runs separately from deterministic adapter and policy tests. Run each model-assisted scenario three times with recorded provider, model, browser, prompt, fixture, and code versions.

| Gate | Proposed threshold | Measurement |
| --- | --- | --- |
| Workflow completion | At least 68 of 75 runs succeed, with no workflow below 12 of 15 | Fixture state and expected outputs; report failures individually |
| Permission enforcement | Zero unauthorized dispatches in the defined test suite | Adversarial tool requests, page injection, revoked grants, changed resources |
| Recovery | Every designated crash checkpoint reconciles or blocks safely | Terminate before dispatch, after dispatch, and before checkpoint persistence |
| Duplicate writes | Zero duplicate commits in recovery fixtures | Destination event log with unique resource/action identifiers |
| Result integrity | Every completed task has evidence for each required criterion | Trace required claims to observations and fixture state |
| Privacy | Zero seeded secret leakage to unauthorized sinks in tests | Canary fields and instrumented model, tool, export, and logging sinks |
| Provider support | All advertised adapters pass their declared capability suite | Include cancellation, throttling, malformed output, auth, and timeout cases |
| Accessibility | All primary flows keyboard usable; no unresolved critical accessibility defects | Automated checks plus manual keyboard and screen-reader review |
| Package integrity | Build, typecheck, lint, unit, integration, and packaged-extension smoke pass | CI evidence attached to exact candidate commit |

These gates describe tested conditions, not universal guarantees. Live smoke tests use authorized accounts and reversible data. Never use real purchases or unapproved messages as test fixtures. Record interventions and exclusions so success rates cannot improve by silently dropping failed runs.

## 17 Development backlog

| Order | Epic | Main deliverables | Depends on |
| --- | --- | --- | --- |
| E01 | Feasibility and contracts | MV3 permission experiment, cloud/local probes, task/tool/grant schemas, recorded limitations | None |
| E02 | Extension shell | Side panel, setup, task entry, state views, accessible controls | E01 |
| E03 | Execution and policy | Narrow tools, grants, resource checks, budgets, journal, cancellation | E01 |
| E04 | Browser adapters | DOM observation and actions, navigation, target freshness, debugger fallback experiment | E03 |
| E05 | Model adapters | OpenAI, Anthropic, tested compatible endpoints, schema repair, typed errors | E01, E03 |
| E06 | First complete workflow | W1 from task entry to cited comparison and saved receipt | E02–E05 |
| E07 | Controlled writes | W3 and W4 previews, commit checks, outcome reconciliation | E06 |
| E08 | Extraction and downloads | W2 and W5, bounded pagination, exports, download manifest | E06 |
| E09 | Recovery and release | Crash fixtures, privacy tests, accessibility QA, package and install docs | E07, E08 |
| E10 | Skills and MCP | Declarative skill runner, project memory, remote MCP client | MVP gates |
| E11 | Companion and specialists | Native bridge, local tools, bounded agents and shared locks | E10 |

Recommended repository structure: `apps/extension`, `apps/companion` when needed, `packages/contracts`, `packages/engine`, `packages/policy`, `packages/browser`, `packages/providers`, `packages/mcp`, `packages/storage`, `tests/fixtures`, `tests/e2e`, and `docs/adr`. Keep future modules as documented boundaries rather than empty abstractions that slow the prototype.

The repository should contain this PRD at `docs/PRD.md`, a README with real setup instructions, `AGENTS.md` for coding-agent constraints, architecture decisions, a test plan, permission inventory, threat model, provider compatibility matrix, and release evidence. Human and coding-agent changes use the same quality gates.

Definition of done for an issue: implemented acceptance criterion, relevant tests, documented behavior and limitations, passing required CI at the exact commit, and no hidden fallback that weakens permissions or data boundaries. Mocks are suitable for tests but never count as a working provider or browser integration.

## 18 Risks and unresolved decisions

| Risk or decision | Current default | Resolution point |
| --- | --- | --- |
| Name availability | BrowserCrew is provisional | Before public branding |
| Local endpoint browser access | Explicit user endpoint and permission; verify actual transport | E01 |
| Debugger permission and store review | Separate capability spike and transparent disclosure | E01 and before distribution |
| Local model tool reliability | Capability probe and declared supported subset | E05 |
| Broad website compatibility | Five benchmark jobs and supported-site matrix | E09 |
| Subscription-funded AI | Unsupported until official third-party route is proven | Separate integration decision |
| Credential persistence | Session-only by default | Before offering persistent vault |
| License and commercial packaging | Undecided; no pricing or license promise | Before public repository release |
| Companion implementation | Native messaging boundary; language and packaging selected later | v0.4 design review |
| Schedules and sleep | Local schedules require an awake machine and available browser | v0.6 design |
| Multi-agent overhead | Single agent baseline, maximum three specialists later | v0.5 benchmarks |

## 19 First development action

Create the `browsercrew` project scaffold and implement a single vertical slice: select an authorized fixture tab, submit “extract the product name and price,” call one configured cloud model, execute validated read tools, display the result with source evidence, and persist the task. Restart the worker and demonstrate that history survives. Repeat with one local endpoint. Add a fixture form commit with a scoped grant and crash reconciliation before expanding the tool surface.

Deliver a short feasibility report with the exact tested environment, working capabilities, failures, permission inventory, and next issue. Do not begin swarm execution or a marketplace before this slice is verified.

## 20 Source notes

These official references support platform constraints. Architecture, thresholds, priorities, and defaults elsewhere in this document are recommendations. Recheck APIs, provider entitlements, and distribution policies when implementing; no exact dependency versions have been selected.

- **S1** [Chrome side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) — extension sidebar UI and permissions.
- **S2** [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) — selected DevTools protocol access, permissions, and restrictions.
- **S3** [Chrome extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) — termination behavior and state persistence guidance.
- **S4** [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) — bridge to registered native applications.
- **S5** [OpenAI billing for ChatGPT and the API](https://help.openai.com/en/articles/9039756) — API billing is separate from ChatGPT subscriptions.
- **S6** [Chrome remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) — Manifest V3 executable-code constraints.
- **S7** [MCP transport specification 2025 06 18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) — reference transport baseline for stdio and Streamable HTTP; negotiate and test the implementation's supported version.

## 21 Change control

This document is the proposed v0.1 baseline. Changes to scope, permissions, persistence, public compatibility claims, or autonomy require a recorded decision and updated acceptance criteria. Keep future roadmap items visible without presenting them as current product functionality. Maintain the implementation backlog and release evidence alongside the PRD so a new developer or coding agent can distinguish planned, implemented, verified, and blocked work.
