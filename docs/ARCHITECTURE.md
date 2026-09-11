# BrowserCrew architecture — v0.1 feasibility

## Current flow

`Side panel → background task engine/policy checks → Chrome scripting observation → provider adapter → verifier → local receipt`

The model never calls Chrome APIs directly. `src/background.js` is the trusted dispatch boundary for browser access, provider access, durable task state, and verification.

## Trust boundaries

- **Side panel:** user input only. It does not hold privileged browser behavior.
- **Background worker:** validates page, provider, and task state before dispatch.
- **Page DOM:** untrusted. The observation function strips scripts/styles/templates/iframes and password inputs before bounded text extraction.
- **Provider response:** untrusted. BrowserCrew parses one JSON object and validates/normalizes values before completing a task.
- **Stored history:** excludes API keys and raw full-page HTML.

## Task state

The first slice persists `planning`, `running`, `paused`, `completed`, `failed`, and `cancelled`. Every task has a checkpoint and journal. On browser/worker startup, tasks left in `planning` or `running` are paused with `WORKER_RESTARTED`; the worker does not replay the prior action.

## Known v0.1 compromises

The PRD's long-term module boundaries remain the target. This feasibility implementation intentionally keeps the engine, policy, provider, and storage helpers in one small background module so browser behavior can be proven before abstracting packages. The next refactor should split these once write reconciliation is covered by tests.
