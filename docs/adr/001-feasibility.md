# ADR 001 — A small, inspectable feasibility extension

Status: accepted for the v0.1 foundation, 2026-09-11.

The attached BrowserCrew PRD proposes TypeScript, React, Vite and IndexedDB, and explicitly permits the smallest setup that passes extension loading. This first implementation uses native JavaScript modules, semantic HTML, the real NeoBrutal-Soft CSS, and IndexedDB. There are no production npm dependencies, transpilation, remote scripts, or background server. Node copies the extension files into a distributable directory; Playwright is an exact-version development dependency.

This is a deliberate, documented deviation from the proposed framework baseline, not a change to the product contracts. Modules retain the PRD boundaries: contracts, policy, engine, browser, provider and storage. Revisit TypeScript/React before v0.2 as the UI and adapter count grow; preserve the behavioral tests during migration.

Background service-worker termination is expected. Checkpoints survive; unfinished writes become outcome_unknown and require human reconciliation. Closing the panel does not delete a task. A terminated worker never automatically repeats a write.

v0.1 implements a research slice (W1) and form preparation (W3). Form submission, W2/W4/W5, navigation/click automation, screenshots, debugger access, MCP, skills, shared project memory, specialists, scheduling and subscription-funded connections remain unimplemented. Form input can trigger website autosave and this is disclosed before approval.

AI uses the OpenAI-compatible chat completions tool interface. Cloud connections require HTTPS; local connections require an explicit loopback address. No cloud fallback exists. Credentials live in chrome.storage.session restricted to trusted extension contexts.

Task text and observations stay in local IndexedDB until deletion or automatic expiry after 30 days. This simpler feasibility retention differs from the PRD proposal of 7-day raw observations and 30-day receipts; the UI states the actual 30-day rule. A shipped retention migration is required before v0.2.
