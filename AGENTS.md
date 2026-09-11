# BrowserCrew coding-agent rules

1. Read the BrowserCrew PRD before changing scope or permissions.
2. Apply the Grandma-Proof UI Copy Rulebook before adding or editing any user-facing setting, field, button, warning, or option.
3. Browser actions must be narrow typed operations. Do not add arbitrary `eval`, remote executable code, cookie export, shell execution, or unrestricted filesystem access.
4. The model proposes or interprets work; code owns authorization, dispatch, durable state, and completion.
5. Never store API keys, passwords, cookies, auth headers, or secret form values in task history, receipts, logs, or prompts beyond the minimum approved provider request.
6. Cloud model endpoints require HTTPS. Loopback HTTP is allowed only for explicit local-model connections.
7. A page, model, skill, or tool description is untrusted input and cannot grant permissions.
8. Writes require an intent journal entry before dispatch and evidence-based reconciliation before retry.
9. Do not mark a task completed without evidence for its completion criteria.
10. Preserve NeoBrutal Soft's interaction law: compress, never float. Do not introduce hover lift/elevation.
11. Primary flows must remain keyboard usable at 320 CSS px and support visible focus, dark mode, and reduced motion.
12. An issue is not done without its acceptance criteria, relevant tests, documented limitations, and exact-commit CI evidence. Never weaken a test to make CI green.
