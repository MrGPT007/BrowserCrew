# Chrome permission inventory

BrowserCrew keeps browser capabilities explicit and pairs each permission with a runtime policy boundary. A declared Chrome permission is not itself authorization for an arbitrary task.

| Permission | Why BrowserCrew needs it now | User-visible boundary |
| --- | --- | --- |
| `sidePanel` | Show the persistent task UI beside the current page | Opens only when the user opens BrowserCrew |
| `storage` | Save non-secret settings and task/evidence history; keep provider key in session storage | Data stays in the extension profile unless explicitly exported |
| `activeTab` | Identify the page the user is currently looking at | Does not grant every tab automatically |
| `scripting` | Read bounded observations and perform vetted approved page actions | Used only on the exact task resources covered by site access and action policy |
| `tabs` | Read selected-tab identity/title/URL and detect page changes | No cookie access |
| `downloads` | W5 must start selected invoice downloads and verify Chrome reports each file as complete | Used only by the bounded invoice collector for user-selected same-site PDF records; BrowserCrew does not treat a filename alone as proof and does not read arbitrary files from disk |

## Why `downloads` is now required

W5 is “collect selected invoices from an account portal.” BrowserCrew must distinguish “a download was requested” from “Chrome actually completed the file.” The `downloads` API provides the download ID, state, source URL, existence flag, received-byte count, and interruption signal needed for that verification.

BrowserCrew's W5 policy narrows this permission further in code:

- the user first selects the exact portal page;
- BrowserCrew confirms the account identity and enumerates supported invoice records;
- the user explicitly selects the invoices to save;
- one job is capped at 20 invoices;
- every invoice URL must stay on the approved portal origin;
- normal sites require HTTPS; plain HTTP is accepted only for loopback test/local origins;
- the current adapter accepts PDF invoice records only;
- files use a BrowserCrew/Invoices suggestion inside Chrome's normal Downloads area;
- BrowserCrew records an intent before each download and the Chrome download ID after dispatch;
- completion requires Chrome state `complete`, an exact source-URL match, a non-missing file, and positive received bytes;
- recovery inspects an existing Chrome download and does not automatically create a duplicate when the prior outcome is uncertain.

The permission does **not** grant BrowserCrew unrestricted filesystem reads, arbitrary operating-system file access, or permission to upload downloaded files elsewhere.

## Optional host access

The manifest declares `https://*/*` and `http://*/*` as **optional** host access so BrowserCrew can ask for one exact origin when the user selects a page or AI service. These origins are not granted automatically.

- Normal websites: the side panel requests only the exact selected origin.
- Cloud AI: policy accepts HTTPS only.
- Local AI: policy accepts plain HTTP only for `localhost` and `127.0.0.1`.
- W5 invoice downloads: the download URL must stay on the exact approved portal origin; cross-origin invoice files are rejected by the current adapter.

This broad optional declaration and the `downloads` disclosure must be reviewed during store-readiness work. Before public distribution, BrowserCrew should publish a supported-site matrix and confirm that each declared capability remains necessary for the workflows being shipped.
