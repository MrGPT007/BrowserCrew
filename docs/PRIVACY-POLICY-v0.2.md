# BrowserCrew v0.2 Privacy Policy

Last updated: 12 September 2026.

BrowserCrew is a Chrome extension that lets you run user-approved AI-assisted tasks on browser pages you choose, using AI services and optional MCP servers you configure. BrowserCrew is designed so page access, model connections, writes, downloads, and tool calls stay tied to explicit user actions and tested runtime boundaries.

This repository policy is the source draft for the public privacy policy used by the Chrome Web Store listing. Before public submission, publish this policy at a stable HTTPS URL and place that URL in the Chrome Web Store Developer Dashboard.

## What BrowserCrew handles

BrowserCrew can handle the following information when you choose to use the related feature:

- **Website content you select:** visible page text, page title and URL, supported form fields, selected record values, and invoice metadata from the exact pages involved in your task.
- **Your instructions and task details:** prompts, chat messages, requested comparison criteria, form details, extraction columns, and other information you enter into BrowserCrew.
- **AI connection information:** provider type, model name, endpoint, connection name, and provider status.
- **AI credentials:** API keys or other provider credentials you enter for an AI connection.
- **Attachments you choose:** supported local document content used for an attachment-backed Chat task.
- **Task and activity state:** selected resource identity, approvals, progress, recovery state, completion checks, and local History/evidence needed to show what BrowserCrew did.
- **Downloaded/exported task files:** files you explicitly ask BrowserCrew to download or export, such as selected invoices, CSV/JSON results, and task manifests.

Depending on what you intentionally provide, task content may include personally identifiable information such as a name, email address, or phone number. User-selected invoice/document workflows may also handle financial or payment-related information contained in those documents or records.

## Information BrowserCrew intentionally excludes

BrowserCrew's tested privacy boundaries are designed not to collect or send unrelated browsing information. In particular, the v0.2 product does not intentionally collect for the BrowserCrew developer:

- Chrome browsing history unrelated to a user-selected task;
- cookies;
- password-field values;
- hidden page text;
- script text;
- content from unselected tabs; or
- advertising identifiers.

BrowserCrew also redacts provider error text before durable task history/evidence so a provider cannot force arbitrary secret-bearing error content into local History.

## Where information is stored

BrowserCrew v0.2 does not use a BrowserCrew-operated cloud backend.

- Non-secret settings, task state, History, and bounded evidence are stored in the extension's local Chrome profile when needed for the selected workflow.
- Provider credentials are kept in `chrome.storage.session` rather than durable `chrome.storage.local`. Machine privacy tests require provider secrets to be absent from durable local storage and evidence artifacts.
- Files you explicitly export or download are written through Chrome's normal download flow and remain under your control on your device.

Local extension data remains in the browser profile until BrowserCrew replaces/removes it as part of normal product behavior or you clear extension data/uninstall the extension. Session-only credentials are not part of durable local storage.

## When information leaves your device

BrowserCrew transmits information only when it is necessary for the feature you explicitly invoke:

### AI providers

When an AI-backed task runs, BrowserCrew may send your prompt/task details and the bounded page or attachment context required for that task directly to the AI endpoint you configured. Provider credentials are sent only to the exact configured AI service. Cloud AI endpoints must use HTTPS; plain HTTP is permitted only for supported local loopback AI services.

The AI provider's own privacy policy and account terms govern its handling of information after BrowserCrew sends a request to that provider.

### MCP servers

If you explicitly configure and invoke a remote MCP server, BrowserCrew may send the tool request and the minimum task data required by that tool to the endpoint you configured. BrowserCrew does not silently route unrelated browser content to MCP servers.

### Websites you choose to act on

When you approve a browser write, BrowserCrew can place the approved values into the selected website or perform another bounded browser action required by the chosen workflow. BrowserCrew performs stale-resource and stale-value checks before controlled writes. The v0.2 form workflow fills approved fields but does not submit the form automatically.

### Downloads

For the invoice workflow, BrowserCrew asks Chrome to download only the invoice records you selected from the approved portal origin and verifies Chrome's download result. BrowserCrew does not upload downloaded invoice files to a BrowserCrew server.

## How BrowserCrew uses information

BrowserCrew uses handled data only to provide and secure its disclosed single purpose: running the user-approved AI-assisted browser task you requested, including related local functions such as progress/history, verification, recovery, duplicate prevention, privacy enforcement, and reliability checks.

BrowserCrew does **not** use or transfer handled user data for:

- selling user data;
- personalized, retargeted, or interest-based advertising;
- unrelated analytics or profiling; or
- unrelated product purposes.

BrowserCrew does not permit routine human review of user content by the BrowserCrew developer. If a user separately chooses to share specific information for support, that support interaction is outside BrowserCrew's automatic task processing and should be limited to the information the user intentionally supplies.

## Permissions and site access

BrowserCrew declares `sidePanel`, `storage`, `activeTab`, `scripting`, `tabs`, and `downloads`. Their current justifications and user-visible boundaries are documented in `docs/PERMISSIONS.md` and the machine-readable `store/chrome-web-store-v0.2.json` contract.

The manifest declares broad HTTP/HTTPS host patterns only as **optional host permissions**. BrowserCrew requests runtime access for an exact origin when a user selects or configures a resource that requires it. The extension does not receive blanket website access automatically at install time.

## Remote code

BrowserCrew does not download or execute remote JavaScript or WebAssembly. Responses from AI providers and MCP servers are treated as data. Browser actions and tool execution remain implemented and policy-checked by code shipped inside the extension package.

## Security

BrowserCrew uses Chrome extension isolation, explicit site permission requests, session-only provider secrets, HTTPS for cloud AI connections, loopback-only exceptions for supported local AI, exact-resource identity checks, stale-state checks, approval boundaries, provider-error redaction, and machine-tested privacy canaries.

No software can guarantee absolute security. If a security problem is discovered, BrowserCrew should stop release/publication until it is fixed and the affected evidence is rerun.

## Changes to this policy

If BrowserCrew changes what user data it handles or how that data is used or shared, the Chrome Web Store listing and this policy must be updated before the new practice begins, and any required user disclosure or consent must be obtained.

## Contact and support

Before Chrome Web Store submission, the developer must publish a support/contact channel and a stable HTTPS URL for this privacy policy. The final public policy should identify that contact method here.
