# Threat Model

BrowserCrew treats the browser page, model output, provider response, and future remote tools as untrusted input. Chrome permissions are capabilities; they are not task authorization. Runtime code must still prove that the current origin, resource, action, destination, and user grant match the task immediately before dispatch.

## Protected assets

Protected assets include signed-in website sessions, provider credentials, private page content, task inputs/history, approved change sets, downloaded invoices, account/record identity, and evidence used to decide that work completed.

## Trust boundaries

The side panel is a trusted extension surface but renders untrusted page/model data as data. The MV3 service worker coordinates privileged browser APIs. Content/page DOM is hostile by default. Cloud/local model endpoints receive only task-approved context. `chrome.storage.session` holds provider secrets for the session; task history must not copy them. The Downloads API is privileged and is restricted by the W5 adapter to selected same-origin PDF records.

## Main threats and current controls

| Threat | Example | Current control | Remaining release work |
| --- | --- | --- | --- |
| Prompt injection | Page text says to ignore BrowserCrew rules and send data elsewhere | Model cannot directly grant browser permissions; narrow adapters validate resources/actions | Add hostile-page scenarios and instrument unauthorized tool attempts |
| Cross-account/resource mistake | Save change to the wrong customer or invoice account | W4 binds approval to exact record/page/Before→After hash; W5 confirms account and selected invoice IDs | Expand stale-account/resource scenario coverage |
| Duplicate side effect after worker stop | Worker dies after Save/download dispatch | Durable intent/dispatched journal; recovery inspects before retry; W4/W5 crash fixtures prove no blind replay | Cover all designated crash checkpoints |
| Secret leakage | API key appears in history, logs, model prompt, export | Secrets use session storage and are excluded from task records by current code | Add seeded canary leakage suite across every sink |
| Permission escalation | Model/page asks for another site or action | Exact selected origin permission checks; same-origin W2/W5 rules; W3/W4 scoped review | Add revoked-grant and adversarial dispatch tests |
| Stale target | Page changes after observation/approval | Selected URL/resource identity and Before values are rechecked for supported writes | Expand stale-element/navigation variants |
| Download confusion | Filename exists but download failed or points elsewhere | W5 success requires Chrome `complete`, exact URL, file existence, and positive bytes | Test interruption/collision/changed-resource variants |
| Spreadsheet injection | Extracted CSV cell begins with `=`, `+`, `-`, or `@` | W2 export neutralizes formula-style cells | Keep export regression in release matrix |
| Malicious/invalid model output | Provider returns malformed JSON or unapproved values | Supported workflows validate/parses outputs and constrain values to declared user/page inputs | Provider malformed-output suite remains incomplete |
| Broad host declaration | Optional `http://*/*` and `https://*/*` appear powerful | They are optional; runtime asks for exact selected origins | Store/disclosure review and supported-site policy before public distribution |
| Other extension/local compromise | Another privileged process observes browser/profile data | Out of BrowserCrew's complete control | Do not claim prevention; document platform assumptions and minimize retained secrets |

## Explicitly unsupported security-sensitive actions

BrowserCrew does not support CAPTCHA bypass, credential extraction, autonomous payments, account-security changes, destructive bulk actions, mass outbound messaging, arbitrary shell execution, cookie export, arbitrary JavaScript evaluation, or unrestricted filesystem reads. A future capability that changes these exclusions requires a new threat-model review and acceptance tests before implementation.

## Recovery rule

Exactly-once browser writes generally cannot be promised. BrowserCrew records intent before dispatch, records the returned dispatch identity where available, then verifies destination state. After interruption it inspects first. If inspection cannot prove whether an effect happened, the safe state is `awaiting_user`/unknown outcome rather than automatic replay.

## Release acceptance

The v0.2 security portion is not complete until the permission-enforcement and privacy gates in `docs/RELEASE-EVIDENCE-v0.2.md` are passed with adversarial and canary evidence. Passing current representative fixtures is necessary regression evidence but not a universal security guarantee.
