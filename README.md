# BrowserCrew

**Give your browser a job. Choose your AI. Stay in control.**

BrowserCrew is a Chrome Manifest V3 browser-work assistant that runs bounded tasks against pages you explicitly select, using a local or cloud AI connection you choose. The repository is now a **v0.2 release candidate**, not a finished v0.2 release: all five named workflows have representative installed-Chromium evidence, while the full PRD release gates are still being completed.

## What works today

- NeoBrutal Soft side-panel UI with light/dark themes, visible status text, keyboard focus, reduced motion, and tactile **compress, never float** controls.
- Current-tab selection and exact-origin Chrome permission requests.
- OpenAI-compatible AI connection path with OpenAI API, LM Studio, and Ollama presets. See `docs/PROVIDER-MATRIX.md` before treating a preset as a certified external provider.
- Session-only provider-secret storage; secrets are not copied into task history.
- Durable local task/history records and recovery-aware action journals.
- Read-only source verification, reviewed writes, bounded pagination/export, and verified Chrome downloads.

### Certified representative workflows

| Workflow | Current controlled capability |
| --- | --- |
| **W1** | Compare 2–5 selected supplier pages against requested criteria, preserve source URLs, and identify missing values |
| **W2** | Extract a same-origin paginated directory into declared columns, explain duplicates, and export safe CSV/JSON with provenance |
| **W3** | Preview and fill a supported business inquiry form from user-provided details; **does not submit the form** |
| **W4** | Update one identified record after exact Before → After review, press the bounded Save action once, and verify saved state |
| **W5** | Confirm an invoice account, download only selected same-origin PDF invoices through Chrome, verify completed downloads, and export a manifest |

These are controlled adapter contracts, not a promise to automate every website. See `docs/SUPPORTED-WORKFLOWS.md` for exact limits and unsupported operations.

## v0.2 release status

The combined W1–W5 installed-extension suite is green on the latest merged implementation baseline, including worker-interruption recovery for W3, W4, and W5. However, the PRD requires more than representative smoke tests. **v0.2 is not release-complete yet.**

`docs/RELEASE-EVIDENCE-v0.2.md` is the source of truth for remaining gates. Current blockers include execution of the full 25-scenario / 75-run matrix, adversarial permission tests, seeded privacy tests, advertised-provider certification including the missing Anthropic adapter, manual accessibility review, previous-stable Chrome evidence, and deterministic release packaging/lock evidence.

## Install for development

1. Clone or download the repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select this repository root.
5. Click BrowserCrew's toolbar action to open the side panel.

No production build step is currently required. For exact local test commands and fixture setup, use `docs/INSTALL.md`.

## Local AI examples

For LM Studio, start its local server, choose **LM Studio**, keep `http://127.0.0.1:1234/v1` unless you changed the port, enter the exact loaded model name, and choose **Test this AI connection**.

For Ollama, the preset uses `http://127.0.0.1:11434/v1`. Enter an installed model and test the connection.

Plain HTTP is accepted only for explicit loopback local endpoints (`localhost` or `127.0.0.1`). Cloud endpoints require HTTPS. BrowserCrew does not scan your network for model servers.

## Safety boundaries

BrowserCrew does not read cookies, export credentials, run arbitrary page JavaScript, execute shell commands, bypass CAPTCHAs, make autonomous payments, perform account-security changes, or expose unrestricted filesystem access. W3 fills approved fields but does not submit. W4 has one narrowly scoped supported Save contract. W5 uses Chrome's Downloads API only for user-selected supported invoice records and never treats a filename alone as proof.

If a page, record, action, or download does not match the supported contract, BrowserCrew should block, return a partial result, or ask for user review rather than silently widening scope.

## Design and copy system

The UI follows **NeoBrutal Soft v0.7**, pinned for this implementation to `NeoBrutalism-shop/NeoBrutal-Soft` commit `dfed77bd159ac5c38081f7a4ca5c2229b61ffb8a`. Raised controls move toward their shadow on hover and seat into the surface on press; they never float upward.

UI copy follows the Grandma-Proof UI Copy Rulebook: controls explain what happens, important consequences, and the recommended/default path in normal language. Status never relies on color alone.

## Release and engineering docs

- `docs/PRD.md` — canonical product requirements and release gates.
- `docs/ARCHITECTURE.md` — current runtime/trust boundaries.
- `docs/PERMISSIONS.md` — declared Chrome permissions and runtime limits.
- `docs/SUPPORTED-WORKFLOWS.md` — exact W1–W5 certified adapter boundaries.
- `docs/PROVIDER-MATRIX.md` — implemented connection paths versus actual provider certification.
- `docs/TEST-PLAN-v0.2.md` — 25-scenario release test design.
- `tests/scenarios/v0.2.json` — machine-readable release scenario catalog.
- `docs/THREAT-MODEL.md` — security assets, threats, controls, and remaining tests.
- `docs/RELEASE-EVIDENCE-v0.2.md` — current pass/partial/blocked release ledger.
- `docs/INSTALL.md` and `docs/ROLLBACK.md` — local install/test and rollback procedure.
- `docs/FEASIBILITY.md` — v0.1 feasibility certification history.
- `AGENTS.md` — coding-agent constraints.

## Roadmap

Finish the v0.2 release gates before widening the runtime. The next product milestone after those gates is v0.3: versioned declarative skills, project memory, and a permissioned remote MCP client. Specialist/swarm execution remains later work, not hidden v0.2 scope.
