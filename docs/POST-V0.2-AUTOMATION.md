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

### Prepared execution binding

A prepared schedule may review an **exact starting page** without activating background scheduling. `src/schedule-prepared-metadata.js` stores only the canonical http/https URL, its origin, required resource IDs, review time, and a `prepared_only` authority plan copied from the exact approved Skill version.

The exact reviewed start page is deliberately stricter than an allowed origin. Query parameters, URL fragments, embedded usernames/passwords, Chrome tab IDs, tokens, secrets, and executable grant fields are rejected. A future run must re-resolve a fresh browser resource to this exact reviewed URL rather than choosing an arbitrary page on the same site.

The authority plan is requirements data, not permission. It cannot contain `scope`, expiry, revocation state, grant IDs, secrets, tokens, or an active flag. `grantRefs` stays empty while a schedule is prepared. Reviewing or changing a starting page never creates authority and never turns the schedule on.

`src/schedule-binding-ui.js` makes this distinction visible on every prepared schedule card. Legacy prepared records remain readable but say that their starting page is not ready for future activation. The user must enter an explicit canonical URL; BrowserCrew never guesses the active tab. The dedicated `setPreparedBinding` runtime path regenerates the plan from the exact approved Skill. Ordinary schedule edits cannot inject replacement binding metadata and preserve only a previously trusted binding that still matches the exact Skill.

### Durable schedule permission

`src/schedule-grants-contract.js` and `src/schedule-grants-runtime.js` add an explicit, revocable authority lifecycle without activating scheduling. Permission is never created by saving a schedule or reviewing its starting page. The user must separately choose **Approve future permission** after the exact Skill, named AI connection, starting page, and prepared scope have been reviewed.

A schedule grant is pinned to one exact schedule ID, one exact Skill id/version, and one exact provider reference. It copies only the reviewed origin/resource/action/provider-capability/data-destination scope, has an explicit expiration, and rejects secrets, runtime inputs, headers, cookies, provider credentials, and Chrome tab IDs. One schedule cannot reuse another schedule's authority.

While an active grant is referenced, ordinary edits cannot silently move that authority to a different Skill version or AI connection, and starting-page changes are blocked. The user must revoke the current permission first, review the changed schedule, and explicitly approve a replacement. Revocation removes the executable reference from the schedule but preserves the revoked grant receipt for audit. Deleting a prepared schedule revokes any remaining active grant before the schedule record is removed.

This permission remains pre-activation data: approving or revoking it creates no alarm and no schedule-run receipt, and the schedule stays disabled. Future activation must still revalidate expiry/revocation, exact provider identity, exact Skill version, scope, and the freshly re-resolved resource immediately before dispatch.

### Fail-closed schedule dispatcher

`src/schedule-dispatcher.js` is the pre-activation bridge from a validated schedule to the exact approved Skill executor. It is intentionally not imported or booted by the production service worker while v0.2 remains active.

The dispatcher does not guess the active tab. A future activation layer must resolve the saved starting resource explicitly and return a fresh tab/resource binding inside the Skill's approved origin/resource scope. If BrowserCrew cannot re-find that exact reviewed start page, dispatch is blocked.

A scheduled run requires an **active schedule grant** that is referenced by the exact schedule ID and pinned to the exact AI connection and Skill id/version. One schedule cannot reuse another schedule's authority merely because the Skill requirements look the same. Skill requirements and the prepared authority plan never manufacture authority. The active schedule grant must still cover every required origin, action class, resource, provider capability, and data destination, and it must still be unexpired and unrevoked.

Provider selection is also revalidated. The named provider must still match the schedule, be available, and expose every capability required by the exact Skill version. Runtime secrets are not stored in the schedule dispatcher.

Unattended inputs are fail-closed. Secret inputs are never persisted or guessed. A non-secret input may run unattended only when the approved Skill already contains a reviewed default that still validates against that exact version.

The dispatcher performs an initial readiness pass and then re-resolves provider, grant, and starting resource immediately before execution. This closes the gap where authority, provider state, or the selected browser resource changes after preflight. Any blocker is raised before the exact-version Skill executor creates a run receipt.

## Current implementation on feature branch

- `src/skills-contract.js` — declarative Skill validation, approval, semantic waits/verification, metadata, compatibility, and input materialization.
- `src/skills-runtime.js` / `src/skills-runner.js` — immutable exact-version execution, durable Skill receipts, runtime grants, semantic target re-resolution, completion verification, and no-blind-write-retry recovery.
- `src/watch-me-contract.js` / `src/watch-me-runtime.js` — scoped semantic demonstration recording, secret-safe input parameterization, completion evidence, restart recovery, and draft-Skill creation.
- `src/schedules-contract.js` — version-pinned schedule validation, dispatch guards, concurrency/missed-run rules, alarm naming/reconciliation, and timezone-aware next-run calculation.
- `src/schedules-runtime.js` — durable schedule storage/receipts, restart reconciliation, missed-run review, bounded queue-one behavior, alarm lifecycle contract, exact run linkage, prepared starting-page review, protected edits under durable authority, and revoke-before-delete. Production boot is intentionally disabled.
- `src/schedule-setup-ui.js` — prepare/edit/delete UX with exact Skill/provider/scope/budget/history details while activation controls remain locked.
- `src/schedule-prepared-metadata.js` / `src/schedule-binding-ui.js` — canonical starting-page review plus an inert, exact-Skill authority plan with no tab ID and no grant.
- `src/schedule-grants-contract.js` / `src/schedule-grants-runtime.js` / `src/schedule-grants-ui.js` — explicit expiring schedule permission approval/revocation pinned to exact schedule, provider, Skill and scope while schedules remain disabled.
- `src/schedule-dispatcher.js` — fail-closed readiness/execution bridge for exact approved Skills. It is not wired into production boot yet.
- installed-extension coverage proves Watch Me, Skill lifecycle/version/Test/Run, missed-run review, prepared schedules, starting-page binding, durable grant replacement/revocation, scheduler restart behavior, and scheduled normal-task Stop/Pause on current Chrome and pinned Chrome 152.

## Remaining activation boundary

Before a post-v0.2 scheduling release can turn this on, BrowserCrew still needs the intentionally deferred activation slice:

1. implement production resolvers for the named provider, exact active grant, and saved starting-resource binding;
2. wire `createScheduleSkillDispatcher(...)` into scheduler boot;
3. add `alarms` to the post-v0.2 manifest and update Web Store permission disclosures;
4. enable Run now / Pause schedule controls against the live scheduler; and
5. run the complete current + previous-stable release matrix again on the activation candidate.

None of those activation steps should be backported into the v0.2 Web Store candidate.