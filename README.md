# BrowserCrew

**Give your browser a job. Choose your AI. Stay in control.**

A Chrome extension for reading selected pages, gathering facts with source quotes, and preparing a form after you review exact changes. Built with the real [NeoBrutal-Soft](https://github.com/NeoBrutalism-shop/NeoBrutal-Soft) design system.

**Status: v0.1 development foundation.** Deterministic tests and a real model demonstration are separate gates. No cloud/local LLM qualification or Chrome Web Store release is implied.

## Try it

1. Download the latest successful **BrowserCrew-v0.1.0** artifact from [Extension quality runs](https://github.com/MrGPT007/BrowserCrew/actions/workflows/quality.yml).
2. Extract the artifact, then extract **BrowserCrew-v0.1.0.zip**.
3. In Chrome, open **chrome://extensions**, turn on **Developer mode**, choose **Load unpacked**, and select the extracted **extension** folder.
4. Pin BrowserCrew and click its toolbar icon to open the side panel.
5. Open **Your AI**. Choose a service or a model running on this computer. Enter the server address, model name and service key when required. Select **Test and save connection**.
6. Open ordinary web pages, choose **New task**, describe the result, select up to five tabs and start. Chrome asks for site access only when needed.

For a form task, select one tab and provide the exact details to fill. Keep that form tab active when approving. Filling can trigger a website's autosave; BrowserCrew does not press Submit.

Cloud service billing is separate from consumer ChatGPT/Claude subscriptions. A local model must already be running and support tools. The extension itself runs on your computer and has no BrowserCrew backend.

## Develop

Requires Node 22+ and desktop Chrome. No runtime npm dependencies or build server are needed by the installed extension.

```sh
npm ci
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
```

Load **dist/extension** after building. Source can also be loaded directly from **apps/extension**. Build checksums are in **dist/SHA256SUMS**.

## Included

- Native side panel and responsive workspace with light/dark themes and press-down controls.
- User-selected local or cloud compatible AI connection and tool-use probe.
- Up to five scoped tabs; page facts with exact source quotes.
- Exact form-change review, stale-target checks and immediate value verification.
- Pause, take over, stop, durable history and conservative crash recovery.
- Receipt export, spreadsheet-safe CSV facts and local task deletion.

Navigation/clicks, submissions, saved-record edits, invoice downloads, screenshots, native Anthropic, MCP, skills, project memory, specialists and scheduling are later work. BrowserCrew cannot control every website or browser page.

## Read before extending

- [PRD implementation map](docs/PRD.md) and [UI copy guide](docs/UI-COPY-RULEBOOK.md)
- [Architecture decision](docs/adr/001-feasibility.md)
- [Permissions](docs/PERMISSIONS.md), [threat model](docs/THREAT-MODEL.md), [provider matrix](docs/PROVIDERS.md)
- [Test plan](docs/TEST-PLAN.md) and [feasibility status](docs/FEASIBILITY.md)
- [Coding-agent rules](AGENTS.md)

Vendored design source: NeoBrutal-Soft commit **dfed77bd159ac5c38081f7a4ca5c2229b61ffb8a**. Tokens, base, button and input styles are copied without modification. The upstream repository did not expose a LICENSE file in the inspected tree; this project makes no new license grant for those assets. Licensing remains a pre-distribution decision from the PRD.
