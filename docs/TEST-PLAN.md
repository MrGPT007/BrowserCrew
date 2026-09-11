# Verification plan

Run `npm ci && npm run check`, install Playwright Chromium with `npx playwright install --with-deps chromium`, then run `npm run test:e2e`.

Unit tests cover scope enforcement, provider URL policy, malformed tools, exact evidence, CSV injection, endpoint redirects, credential-safe error handling, stop during inference, concurrent starts, approval ordering, duplicate approval, crash recovery, storage failure and budgets.

The browser suite first loads the production package and checks no fixture host access is granted. A separate test-only copy adds **only** the local fixture origin to host_permissions to emulate the browser's permission grant. Production code is unchanged. It exercises actual MV3 workers, IndexedDB, provider HTTP transport, Chrome tab/scripting APIs, isolated-world observations and form edits. Model responses come from a scripted local HTTP server, not an LLM.

Browser artifacts include light/dark, 320/390/768 widths, RTL/forced-colors/reduced-motion captures, research results and a machine-readable evidence record. Layout overflow assertions are automatic; screenshot capture alone is not visual review.

Outstanding release gates: real model trials with a supported cloud endpoint and LM Studio/Ollama on Windows; 25 scenarios/75 model-assisted runs; live current/previous Chrome validation; screen-reader and nontechnical copy review; broader adversarial and crash-checkpoint coverage; all other MVP workflows.

Do not treat deterministic fixture success as provider certification or full v0.1 feasibility completion.
