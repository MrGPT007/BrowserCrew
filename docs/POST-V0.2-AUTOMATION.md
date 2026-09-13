# BrowserCrew post-v0.2 automation architecture

Status: feature-track design and contract implementation. This branch is intentionally separate from the v0.2 release candidate.

## Product model

BrowserCrew automation is built from three layers:

1. **Skills** — “A saved way to do a browser job.” A skill is versioned, declarative data with inputs, allowed sites/actions, ordered semantic steps, completion checks, budgets, and recovery rules.
2. **Watch me do it** — the user performs a workflow once. BrowserCrew observes only approved tabs/sites, records semantic actions, removes secrets, and produces a **draft skill** for review.
3. **Run on a schedule** — the user chooses an approved exact skill version and decides when it should run. Schedules never bypass the normal policy/task engine.

The dependency direction is deliberate: Watch Me -> draft Skill -> user review/approval -> optional Schedule.

## Watch me do it

### User flow

1. Click **Watch me do it**.
2. BrowserCrew says which tab/site it will watch and what it will never record.
3. The user performs the job normally.
4. BrowserCrew shows **Watching** with Pause and Stop.
5. On Stop, BrowserCrew produces a plain-language draft such as:
   - Open the Orders page.
   - Choose **Pending**.
   - Enter **{{input.customerEmail}}**.
   - Choose **Preview**.
   - Verify **Ready to review** is visible.
6. The user can rename inputs, remove/redact steps, add completion checks, and review requested sites/actions.
7. Only an explicitly approved version can execute or be scheduled.

### Recording boundary

Record intent-level events, not a fragile raw macro. Prefer role, label, accessible name, stable id/test id, selected resource identity, and observable postconditions. Raw screen coordinates are not a supported replay target.

Never persist password values, payment-card/CVC values, auth tokens, API keys, cookies, authorization headers, hidden fields, or script text. Typed demonstration values become runtime inputs. Sensitive inputs become secret runtime inputs with no persisted default.

Leaving an approved tab/origin pauses recording and requires scope review. Page-authored instructions are untrusted content and cannot alter the workflow policy.

## Skills

Skills are data, never executable code. The v1 contract rejects executable-code fields and remote-script references. A skill describes what BrowserCrew should do; the existing policy layer still decides what BrowserCrew is allowed to do at each step.

An approved skill pins:

- stable id + semantic version;
- input schema;
- allowed origins/resources;
- action classes and data destinations;
- provider requirements;
- semantic steps and target fingerprints;
- waits/conditions;
- approval-required writes;
- completion criteria and verification;
- budgets;
- recovery/no-replay policy; and
- provenance.

Skill permissions are requirements, not grants. A replay still needs the active task/user authorization to cover the skill's requested scope.

## Run on a schedule

Use Manifest V3 `chrome.alarms` after v0.2. Add the `alarms` permission only in the feature release that ships scheduling and update Web Store permission disclosures at that time.

Schedule definitions are the durable source of truth. Chrome alarm state is derived and reconciled whenever the service worker starts.

### Recurrence

- Once
- Every day
- Every week
- Interval
- Custom calendar/cron-style editing can be layered on these validated primitives later.

Calendar schedules are one-shot alarms recalculated after every fire using the user's IANA timezone. This avoids fixed 24-hour/7-day drift across daylight-saving changes. True interval schedules may use `periodInMinutes`.

Chrome alarms do not wake a sleeping/offline device. Missed-run behavior is explicit: **Skip**, **Run once when available**, or **Ask me**.

### Dispatch boundary

A scheduled run is a normal BrowserCrew execution and must re-check:

- exact approved skill version;
- current grants and expiry/revocation;
- provider availability;
- current resource identity/freshness;
- action/data budgets;
- overlapping active runs; and
- completion verification.

A schedule cannot convert a draft/unreviewed Watch Me recording into an executable job.

### Fail-closed schedule dispatcher

`src/schedule-dispatcher.js` is the pre-activation bridge from a validated schedule to the exact approved Skill executor. It is intentionally not imported or booted by the production service worker while v0.2 remains active.

The dispatcher does not guess the active tab. A future activation layer must resolve the saved starting resource explicitly and return a fresh tab/resource binding inside the Skill's approved origin/resource scope. If BrowserCrew cannot re-find that resource, dispatch is blocked.

A scheduled run requires a schedule-scoped grant pinned to the exact Skill id/version. Skill requirements never manufacture authority. The saved grant must still cover every required origin, action class, resource, provider capability, and data destination, and it must still be unexpired and unrevoked.

Provider selection is also revalidated. The named provider must still match the schedule, be available, and expose every capability required by the exact Skill version. Runtime secrets are not stored in the schedule dispatcher.

Unattended inputs are fail-closed. Secret inputs are never persisted or guessed. A non-secret input may run unattended only when the approved Skill already contains a reviewed default that still validates against that exact version.

The dispatcher performs an initial readiness pass and then re-resolves provider, grant, and starting resource immediately before execution. This closes the gap where authority, provider state, or the selected browser resource changes after preflight. Any blocker is raised before the exact-version Skill executor creates a run receipt.

## Current implementation on feature branch

- `src/skills-contract.js` — declarative Skill validation, approval, semantic waits/verification, metadata, compatibility, and input materialization.
- `src/skills-runtime.js` / `src/skills-runner.js` — immutable exact-version execution, durable Skill receipts, runtime grants, semantic target re-resolution, completion verification, and no-blind-write-retry recovery.
- `src/watch-me-contract.js` / `src/watch-me-runtime.js` — scoped semantic demonstration recording, secret-safe input parameterization, completion evidence, restart recovery, and draft-Skill creation.
- `src/schedules-contract.js` — version-pinned schedule validation, dispatch guards, concurrency/missed-run rules, alarm naming/reconciliation, and timezone-aware next-run calculation.
- `src/schedules-runtime.js` — durable schedule storage/receipts, restart reconciliation, missed-run review, bounded queue-one behavior, alarm lifecycle contract, and exact run linkage. Production boot is intentionally disabled.
- `src/schedule-setup-ui.js` — prepare/edit/delete UX with exact Skill/provider/scope/budget/history details while activation controls remain locked.
- `src/schedule-dispatcher.js` — fail-closed readiness/execution bridge for exact approved Skills. It is not wired into production boot yet.
- installed-extension coverage proves Watch Me, Skill lifecycle/version/Test/Run, missed-run review, prepared schedules, scheduler restart behavior, and scheduled normal-task Stop/Pause on current Chrome and pinned Chrome 152.

## Remaining activation boundary

Before a post-v0.2 scheduling release can turn this on, BrowserCrew still needs the intentionally deferred activation slice:

1. persist/review a concrete schedule starting-resource binding and durable schedule grant instead of guessing current browser state;
2. implement production resolvers for the named provider, exact grant, and saved resource binding;
3. wire `createScheduleSkillDispatcher(...)` into scheduler boot;
4. add `alarms` to the post-v0.2 manifest and update Web Store permission disclosures;
5. enable Run now / Pause schedule controls against the live scheduler; and
6. run the complete current + previous-stable release matrix again on the activation candidate.

None of those activation steps should be backported into the v0.2 Web Store candidate.
