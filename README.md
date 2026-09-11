# BrowserCrew

**Give your browser a job. Choose your AI. Stay in control.**

BrowserCrew is a Chrome Manifest V3 extension that runs browser tasks against pages you explicitly select, using a cloud or local AI connection you choose. The first vertical slice is intentionally read-only: select the current tab, ask for the product name and price, let BrowserCrew read a bounded text snapshot, and receive a result with source evidence saved to local history.

## What works in this first build

- Chrome side panel with NeoBrutal Soft UI and light/dark themes.
- Clear connection indicators for the selected AI and page.
- Current-tab selection with per-site permission request.
- OpenAI API, LM Studio, and Ollama presets using an OpenAI-compatible chat-completions path.
- Session-only API-key storage; keys are not written to task history.
- Read-only page observation through `chrome.scripting` with bounded text capture.
- Model extraction into a validated JSON result.
- Simple source-text verification and evidence receipt.
- Durable local job history and safe worker-restart reconciliation.
- Pause and Stop controls that prevent new steps from starting after state is recorded.

## Load it in Chrome

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose this repository folder.
5. Pin BrowserCrew, then click its toolbar icon. The side panel opens.

No build step is required for v0.1 feasibility.

## Try the controlled fixture

From the repository root, serve the fixture with any static server, for example:

```bash
python -m http.server 4173 --directory tests/fixtures
```

Open `http://localhost:4173/product.html`, open BrowserCrew, choose **Use the page I’m looking at**, set up an AI under **Choose AI**, test the connection, then run the default job.

Expected fixture result:

```json
{
  "productName": "Northstar Desk Lamp",
  "price": "$49.00"
}
```

## Local AI examples

### LM Studio

1. Start LM Studio's local server.
2. In BrowserCrew choose **LM Studio**.
3. Keep the preset `http://127.0.0.1:1234/v1` unless you changed LM Studio's port.
4. Enter the exact loaded model name.
5. Click **Test this AI connection**.

### Ollama

The preset uses `http://127.0.0.1:11434/v1`, Ollama's OpenAI-compatible path. Enter a model installed on your machine, then run the connection test.

## Safety boundaries in this slice

BrowserCrew cannot submit forms, purchase, delete, message, read cookies, export credentials, execute arbitrary page JavaScript, or access the filesystem. It reads only a selected `http`/`https` page after Chrome grants that origin. Cloud AI requires HTTPS; plain HTTP is accepted only for `localhost` and `127.0.0.1`.

## Design system

The UI follows **NeoBrutal Soft v0.7** from `NeoBrutalism-shop/NeoBrutal-Soft`, pinned for this implementation to commit `dfed77bd159ac5c38081f7a4ca5c2229b61ffb8a`. The physical interaction rule is **compress, never float**: raised controls move toward their shadow on hover and seat into the surface on press.

UI copy follows the Grandma-Proof UI Copy Rulebook: labels explain what a choice does, the result of choosing it, and a recommended/default path in normal language.

## Project docs

- `docs/ARCHITECTURE.md` — current trust boundaries and flow.
- `docs/PERMISSIONS.md` — exact Chrome permissions and why each exists.
- `docs/FEASIBILITY.md` — what this slice proves, what remains unverified.
- `AGENTS.md` — coding-agent constraints.

## Status

This is the **v0.1 feasibility vertical slice**, not the full MVP. The next slice is controlled form preparation/commit on the bundled fixture with a scoped grant and crash reconciliation before any broader write surface is added.
