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

## Current implementation on feature branch

- `src/skills-contract.js` — declarative skill validation, approval, and input materialization.
- `src/watch-me-contract.js` — scoped demonstration sessions, semantic event sanitization, secret-safe input parameterization, and draft-skill creation.
- `src/schedules-contract.js` — version-pinned schedule validation, dispatch guards, alarm naming/reconciliation, and timezone-aware next-run calculation.
- `scripts/skills-automation-check.mjs` — contract tests for secret redaction, scope changes, code-injection rejection, exact-version scheduling, stale/revoked-resource blocking, alarm reconciliation, and timezone behavior.

## Next implementation slices

1. Skills storage/library UI and exact-version runner integration with the existing task engine.
2. Watch Me content recorder with persistent visible recording indicator and service-worker recovery.
3. Skill review/editor and fixture replay test.
4. Schedule storage/service-worker alarm reconciler and run history.
5. Full installed-extension tests on current stable and previous stable Chrome.
6. Only after v0.2 is frozen/tagged: update manifest/Web Store permissions for scheduling and merge this feature track.
