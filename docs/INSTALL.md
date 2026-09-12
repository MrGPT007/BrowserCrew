# Install and Local Test Guide

BrowserCrew is currently a development/release-candidate Chrome Manifest V3 extension. It is not a Chrome Web Store release yet.

## Load the production source as an unpacked extension

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the repository root containing `manifest.json`.
5. Pin BrowserCrew if desired, then click its toolbar action to open the side panel.

The current extension is dependency-light and does not require a production build step. The Playwright dependency is for automated browser testing only.

## Run repository checks

Use Node 24, matching CI.

```bash
npm install --ignore-scripts
npm run check
```

Installed-extension smoke suites require Playwright Chromium:

```bash
npx playwright install --with-deps chromium
npm run browser-smoke
npm run directory-smoke
npm run record-smoke
npm run invoice-smoke
```

CI remains the canonical reproducible environment until the release-candidate dependency lock/package gate is closed. Do not call a local pass release evidence unless the exact commit, Node/browser versions, and outputs are recorded.

## Serve controlled fixtures

```bash
python -m http.server 4173 --directory tests/fixtures
```

The repository fixtures cover the read slice, W1 supplier comparison, W2 directory extraction, W3 form preparation, W4 record update, and W5 invoice portal behavior. Automated tests may use their own local fixture server rather than port 4173.

## AI connection examples

BrowserCrew currently exposes an OpenAI-compatible request path with presets for OpenAI API, LM Studio, and Ollama. These are configuration presets, not a statement that each external provider has passed the v0.2 provider certification gate. See `docs/PROVIDER-MATRIX.md`.

For local servers, plain HTTP is accepted only on `localhost` and `127.0.0.1`. Cloud endpoints must use HTTPS. BrowserCrew asks for endpoint/site origin access through Chrome rather than scanning the network.

## Before public distribution

Do not package or advertise v0.2 as complete until `docs/RELEASE-EVIDENCE-v0.2.md` changes its release decision based on evidence. Store/disclosure review, deterministic dependency/package evidence, provider certification, privacy tests, accessibility review, and the full release scenario matrix remain explicit gates.
