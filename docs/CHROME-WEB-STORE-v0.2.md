# BrowserCrew v0.2 — Chrome Web Store submission pack

Status: **Engineering readiness only — not submitted and not approved.**

This document turns the current BrowserCrew v0.2 behavior into the copy and evidence needed for the Chrome Web Store Developer Dashboard. It must stay consistent with `manifest.json`, `docs/PRIVACY-POLICY-v0.2.md`, `docs/PERMISSIONS.md`, and `store/chrome-web-store-v0.2.json`.

## Single purpose

**BrowserCrew lets users run user-approved AI-assisted tasks on browser pages they choose, using AI services they configure, while keeping page access and browser actions under explicit user control.**

The supported workflows—compare selected pages, extract a bounded directory, prepare approved form fields without submitting, update one approved record, collect selected invoices, use Chat, and invoke bounded tools/MCP—are all parts of that one focus area: user-controlled AI assistance for the browser task currently being performed.

BrowserCrew does not replace search, inject advertising, alter the new-tab page, change browser settings, or bundle unrelated consumer utilities.

## Store listing copy

### Name

BrowserCrew

### Category

Productivity

### Short description

Run user-approved AI tasks on the browser pages you choose, using cloud or local models you configure.

### Detailed description

BrowserCrew is a side-panel assistant for browser work you choose to delegate to AI while keeping the browser action itself under your control.

Choose the page or pages involved in the task, choose the AI connection you want to use, and let BrowserCrew perform a bounded workflow with explicit resource identity, site access, verification, and recovery checks.

Current v0.2 workflows include:

- compare facts across selected pages;
- extract a bounded same-site directory and export verified CSV/JSON results;
- prepare and fill approved form values without automatically submitting the form;
- update one selected record only after showing the exact Before → After change;
- collect user-selected invoice PDFs from an approved portal and verify Chrome completed each download;
- use Chat with bounded page-read tools and local document attachments; and
- connect supported remote MCP tools when you explicitly configure and invoke them.

Bring your own AI connection. BrowserCrew supports OpenAI-compatible endpoints, the native Anthropic Messages path, LM Studio, and Ollama. Cloud AI connections require HTTPS. Local AI can use loopback endpoints on your computer.

BrowserCrew does not get blanket website access at installation. Website and service origins are optional permissions requested at runtime when a selected task needs them. Provider credentials are kept in Chrome session storage instead of durable local storage.

BrowserCrew is designed to report verified outcomes rather than treating a model claim as proof. Controlled writes use approval and stale-state checks, uncertain writes are not blindly replayed, and privacy tests exclude password fields, hidden/script text, unrelated history, and unselected-tab content from model context and durable evidence.

## Privacy Practices — purpose field

Use the exact Single purpose statement above.

## Privacy Practices — permission justifications

### `sidePanel`

Shows BrowserCrew's persistent task workspace beside the page the user is working on. The panel opens only when the user invokes BrowserCrew.

### `storage`

Stores non-secret connection settings, bounded task state, local History, and machine-verifiable task evidence. AI provider credentials use `chrome.storage.session` instead of durable local storage.

### `activeTab`

Binds a task to the page the user is currently viewing before BrowserCrew requests any additional site access. It does not authorize unrelated tabs.

### `scripting`

Reads bounded visible-page observations and performs explicitly approved page actions required by the selected task. Runtime policy checks exact selected resource identity, site access, stale state, and approvals before controlled actions.

### `tabs`

Reads selected-tab identity, title, and URL and detects navigation so BrowserCrew can reject stale/changed resources. BrowserCrew does not use this permission to collect general Chrome browsing history.

### `downloads`

Starts user-selected invoice downloads and verifies Chrome reports the exact intended file as complete. The invoice workflow is bounded to selected same-site invoice records and does not provide arbitrary filesystem read access.

### Optional HTTP/HTTPS host access

The broad HTTP/HTTPS patterns are declared only under `optional_host_permissions`; BrowserCrew asks Chrome for an exact origin at runtime when a user selects/configures a website, AI endpoint, or MCP endpoint that needs access. Cloud AI endpoints must use HTTPS; supported local AI may use loopback HTTP.

## Privacy Practices — user-data disclosure worksheet

The final Developer Dashboard form must be answered from the actual candidate behavior, not marketing intent. For v0.2, disclose the following handled categories conservatively:

| Data category | v0.2 answer | Why it is handled | Main destinations |
| --- | --- | --- | --- |
| Website content | Yes | Visible content/title/URL and supported page fields from resources selected for the task | User-configured AI provider when needed; explicit MCP tool when invoked |
| Personal communications | Yes | Chat prompts, task instructions, and user-entered task details | User-configured AI provider; explicit MCP tool when invoked |
| Authentication information | Yes | Provider API credentials supplied by the user | Exact user-configured AI provider; kept in Chrome session storage locally |
| Personally identifiable information | Yes, when user supplies it | Approved form values, attachments, or task details can contain names/emails/phones | User-configured AI provider when required; selected website for an approved write |
| Financial/payment information | Yes, when invoice/document workflow contains it | User-selected invoice/document records can contain financial data | Local workflow/download path in current v0.2; no BrowserCrew backend |
| User activity | Yes | Task status, approvals, selected resource identity, recovery and completion evidence | Local extension storage/evidence in current v0.2 |
| Location | No intended collection | BrowserCrew does not request geolocation | None |
| General browsing history | No intended collection | `tabs` is used for selected resource identity and change detection, not history collection | None |
| Advertising identifiers | No | BrowserCrew has no advertising/retargeting feature | None |

BrowserCrew v0.2 has **no BrowserCrew-operated backend**. Network transfers go directly to a user-configured AI/MCP endpoint or to a website the user explicitly acts on.

## Limited Use certification notes

The disclosure should certify that handled data is used only for BrowserCrew's disclosed single purpose and related operation/security/reliability functions. BrowserCrew does not sell user data, use it for personalized advertising or retargeting, or use it for unrelated profiling.

## Remote hosted code

Answer **No**. BrowserCrew does not fetch and execute remote JavaScript or WebAssembly. Model/MCP responses are data; browser/tool actions are implemented by code packaged with the extension.

## Public privacy policy and support

Use these reviewed public HTTPS URLs for the v0.2 listing:

- Privacy policy: https://github.com/MrGPT007/BrowserCrew/blob/main/docs/PRIVACY-POLICY-v0.2.md
- Support: https://github.com/MrGPT007/BrowserCrew/issues

The public privacy policy identifies the issue tracker as BrowserCrew's current support channel and warns users not to post credentials or private task data in public issues. These URLs must remain consistent with `store/chrome-web-store-v0.2.json` and must be entered unchanged in the Chrome Web Store Developer Dashboard unless a separately reviewed stable HTTPS replacement is committed first.

## Required store assets

B08 remains externally blocked until every required store asset and Dashboard/publication requirement is ready. The first required screenshot is now reproducible from the exact candidate instead of being a hand-made mockup.

- 128×128 PNG extension/store icon in the extension ZIP — **required, missing**.
- 1280×800 Workspace screenshot — **generated by exact-candidate CI** at `artifacts/store-media/browsercrew-workspace-1280x800.png`; `scripts/store-media-smoke.mjs` installs the real extension, connects through Connect AI, prepares a real three-page Workspace comparison state, captures the viewport, and verifies the PNG dimensions.
- 440×280 small promotional tile — **required, missing**.
- 1400×560 marquee image — optional.
- Product video — optional unless required by the Dashboard flow chosen at submission time.

The CI screenshot is uploaded separately as `store-media-evidence`, with a sanitized report tied to the exact candidate SHA. Use real BrowserCrew UI for screenshots. Do not create screenshots that imply capabilities, providers, permissions, or automatic actions that the shipped extension does not provide.

## Submission checklist

Repository/engineering checks:

- [x] `manifest.json` and `package.json` identify the same v0.2 package version.
- [x] `npm run store-readiness-check` is mandatory on the exact release candidate.
- [x] `npm run store-media-check` is mandatory and verifies executable screenshot-generation contracts.
- [x] Exact-candidate CI generates and validates the required 1280×800 product screenshot.
- [x] Public HTTPS privacy-policy and support URLs are defined in the store contract and statically checked.
- [ ] `npm run check` passes on the final candidate selected for external submission.
- [ ] Full current-stable installed-extension matrix passes on the final candidate.
- [ ] Pinned Chrome 152 matrix passes on the final candidate.
- [ ] Independent 75-attempt release matrix passes on the final candidate.
- [ ] B03 live-provider receipts, if used as release certification, all name the same final candidate SHA.
- [ ] Final candidate ZIP/package evidence is generated from that same SHA.

Developer account and listing:

- [ ] Chrome Web Store publisher account is active.
- [ ] 2-step verification is enabled for the publishing account.
- [ ] Store listing name, category, language, short description, and detailed description are entered.
- [ ] Reviewed support URL is entered in the Developer Dashboard.
- [ ] Reviewed privacy-policy URL is entered in the Developer Dashboard.
- [ ] Privacy Practices single-purpose and permission justifications match this document.
- [ ] Privacy Practices user-data selections match actual v0.2 behavior and the public privacy policy.
- [ ] Required icon, screenshot, and small promotional tile are uploaded.
- [ ] Final candidate ZIP is uploaded with a version greater than any previously published package version.
- [ ] Visibility/distribution settings are intentionally selected.
- [ ] Submission is sent for review.

External proof required to close V02-B08:

- [ ] Record the exact submitted candidate SHA and package digest.
- [ ] Record the Chrome Web Store item ID/publisher evidence without exposing secrets.
- [ ] Record submission/review status and date.
- [ ] Resolve any reviewer findings without weakening BrowserCrew's existing safety/privacy/quality gates.
- [ ] Record approval/publication evidence before changing B08 to Passed.

## Release boundary

Repository readiness does **not** mean Chrome Web Store approval. Keep `V02-B08` blocked until the exact release candidate has actually been submitted and the relevant review/publication requirement is satisfied.
