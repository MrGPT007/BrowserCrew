# Permission inventory and data flow

| Permission | Purpose | When used |
| --- | --- | --- |
| sidePanel | Native Chrome task UI | Extension toolbar action |
| storage | Trusted session keys and explicit preferences | Setup and theme/connection use |
| scripting | Bundled isolated-world DOM reads and field writes | Authorized selected tabs only |
| tabs | Show tab titles/addresses for selection; validate current tab and active form | User chooses pages and before actions |
| Optional HTTP(S) host access | Reach the selected AI server and pages | Requested from user gesture for exact origins |

No permanent all-site host permission, automatic content script, externally_connectable channel, debugger, cookies, downloads, nativeMessaging or remote code.

The manifest declares broad *optional* patterns because users may select arbitrary normal websites and explicit local servers. Runtime requests are origin-specific. Chrome origin grants are broader than task grants: the policy checks selected tab IDs and current origin again on every dispatch. A grant does not authorize all tabs on that origin.

The trusted panel alone can message the worker. Sender extension ID and exact panel URL are checked. Websites have no postMessage bridge into privileged commands. The AI receives only narrow tool definitions.

Credentials are stored in chrome.storage.session with TRUSTED_CONTEXTS access. They are endpoint-bound and excluded from task storage, exports, page scripts and model messages. Provider fetch rejects redirects and uses a 20-second timeout. HTTPS is mandatory for cloud; local is loopback-only and never falls back to cloud.

Page text is inherently untrusted. Hidden elements, password/secret/payment fields and input text are excluded from page text; selected ordinary text fields are separately described for forms. Common key-like patterns are redacted. These filters are not a universal secret detector: users must select only pages they may share with the chosen AI.

Saved tasks include goals, snapshots, proposals, source quotes and form outcomes. They remain on this computer in IndexedDB for up to 30 days; deletion removes the whole task and its dependent evidence. No telemetry or BrowserCrew server exists. Retention cleanup runs on worker initialization. Existing cloud disclosures cannot be retracted by local deletion.
