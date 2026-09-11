# Chrome permission inventory — v0.1 feasibility

| Permission | Why BrowserCrew needs it now | User-visible boundary |
| --- | --- | --- |
| `sidePanel` | Show the persistent task UI beside the current page | Opens only when the user opens BrowserCrew |
| `storage` | Save non-secret settings and task/evidence history; keep provider key in session storage | Data stays in the extension profile unless explicitly exported later |
| `activeTab` | Identify the page the user is currently looking at | Does not grant every tab automatically |
| `scripting` | Read a bounded text snapshot from an approved selected page | Used only after site access is granted |
| `tabs` | Read selected-tab identity/title/URL and detect page changes | No cookie access |

## Optional host access

The manifest declares `https://*/*` and `http://*/*` as **optional** host access so BrowserCrew can ask for one exact origin when the user selects a page or AI service. These origins are not granted automatically.

- Normal websites: the side panel requests only the exact selected origin.
- Cloud AI: policy accepts HTTPS only.
- Local AI: policy accepts plain HTTP only for `localhost` and `127.0.0.1`.

This broad optional declaration must be reviewed during store-readiness work. If Chrome Web Store disclosure or user trust is unacceptable, replace it with a narrower supported-site matrix before public distribution.
