# Install and Local Test Guide

BrowserCrew is currently a development/release-candidate Chrome Manifest V3 extension. It is not a Chrome Web Store release yet.

## Install the repository checkout for development

1. Clone or download this repository.
2. Use Node 24, matching CI.
3. Install the exact committed dependency set with `npm ci --ignore-scripts`.
4. Open `chrome://extensions` in Chrome.
5. Turn on **Developer mode**.
6. Choose **Load unpacked** and select the repository root containing `manifest.json`.
7. Pin BrowserCrew if desired, then click its toolbar action to open the side panel.

BrowserCrew has no production compilation step. PDF attachment reading uses the locked `pdfjs-dist` runtime. Playwright is a development-only browser-test dependency and must not ship in the release candidate.

## Build the v0.2 candidate package

Run:

```bash
npm ci --ignore-scripts
npm run check
npm run package-release
```

The packager creates these generated files under `dist/`:

- `browsercrew-v0.2-candidate.zip` — the extension candidate.
- `browsercrew-v0.2-candidate.zip.sha256` — the SHA-256 receipt for that ZIP.
- `package-manifest.json` — the packaged file list, source-tree SHA-256, ZIP SHA-256, manifest version, and file count.

The candidate contains BrowserCrew runtime files plus the exact PDF.js runtime files needed for local PDF attachment parsing. It must not contain Playwright, tests, docs, repository scripts, CI artifacts, Git metadata, or source maps.

## Verify the packaged candidate locally

After installing Playwright Chromium, run the package smoke test:

```bash
npx playwright install --with-deps chromium
npm run package-smoke
```

`package-smoke` extracts the generated ZIP to a clean temporary directory, verifies its file list against `package-manifest.json`, loads that extracted directory as the Manifest V3 extension, opens the side panel, and verifies that packaged PDF.js can parse a supported PDF. This is deliberately different from loading the repository source tree.

For a manual package check, independently verify the SHA-256 value in `dist/browsercrew-v0.2-candidate.zip.sha256`, extract the ZIP to a new empty folder, then use **Load unpacked** on that extracted folder. Do not add or edit files inside an evidence candidate after its hash is recorded.

## Run repository checks

Static and contract checks:

```bash
npm ci --ignore-scripts
npm run check
```

The installed-extension regression matrix requires Playwright Chromium. CI remains the canonical full matrix; individual suites can also be run locally when investigating a capability.

```bash
npx playwright install --with-deps chromium
npm run browser-smoke
npm run directory-smoke
npm run record-smoke
npm run invoice-smoke
npm run privacy-smoke
npm run privacy-sinks-smoke
npm run chat-smoke
npm run connections-smoke
npm run attachments-smoke
npm run tools-smoke
npm run mcp-smoke
npm run c5-smoke
npm run workspace-stop-smoke
```

A local pass is not release evidence unless the exact commit, Node/browser versions, package hashes, and outputs are recorded. GitHub Actions is the canonical reproducible environment for the v0.2 release ledger.

## Serve controlled fixtures

```bash
python -m http.server 4173 --directory tests/fixtures
```

The repository fixtures cover the read slice, W1 supplier comparison, W2 directory extraction, W3 form preparation, W4 record update, and W5 invoice portal behavior. Automated tests may use their own local fixture server rather than port 4173.

## AI connection examples

BrowserCrew currently exposes an OpenAI-compatible request path with presets for OpenAI API, LM Studio, and Ollama. These are configuration presets, not a statement that each external provider has passed the v0.2 provider certification gate. See `docs/PROVIDER-MATRIX.md`.

For local servers, plain HTTP is accepted only on `localhost` and `127.0.0.1`. Cloud endpoints must use HTTPS. BrowserCrew asks for endpoint/site origin access through Chrome rather than scanning the network.

## Before public distribution

Do not advertise v0.2 as complete until `docs/RELEASE-EVIDENCE-v0.2.md` changes its release decision based on evidence. The release ZIP created by this guide is a candidate artifact, not a public-release declaration. Provider certification, accessibility review, previous-stable Chrome coverage, the full release scenario matrix, and Chrome Web Store permission/disclosure review remain separate gates.
