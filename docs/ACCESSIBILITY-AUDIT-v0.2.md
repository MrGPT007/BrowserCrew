# BrowserCrew v0.2 Accessibility Audit

Status: **MACHINE ENGINEERING GATE**

Human assistive-technology review: **OPTIONAL FUTURE FOLLOW-UP**

For the current v0.2 release scope, BrowserCrew treats deterministic machine accessibility coverage as the acceptance gate. Manual NVDA, VoiceOver, or JAWS review remains useful future product validation, but it is not a release blocker unless the project deliberately restores that requirement later.

## Machine accessibility gate

The installed-extension `accessibility-smoke` suite runs BrowserCrew in Chromium at a 360px side-panel viewport and verifies:

- visible primary controls have meaningful accessible names;
- the top-level tablist supports roving focus and arrow-key activation;
- custom button-based radio groups expose one Tab stop and support Arrow keys, Home, and End;
- the Ctrl+K command bar exposes a named dialog plus combobox/listbox active-descendant semantics;
- modal surfaces keep focus inside while open, make the background inert, support the documented Escape path, and restore focus to the invoking control;
- saved-connection transfer review follows the same modal focus contract;
- Chat, C5, and connection-test asynchronous states are polite atomic status regions rather than color-only state;
- reduced-motion preference collapses interaction transitions;
- light and dark themes retain the narrow-width baseline;
- the viewport does not disable user zoom;
- Chromium's accessibility tree exposes critical dialog/combobox roles and names.

This automated audit is part of the mandatory installed-extension matrix. V02-B05 passes only when the static accessibility contracts, this installed-Chromium suite, and all pre-existing BrowserCrew quality gates are green on one unchanged exact head.

## Zoom and narrow-width coverage

Automation verifies that BrowserCrew does not disable browser zoom and that the primary side-panel layout avoids page-level horizontal overflow at 360 CSS pixels in light and dark mode. The suite also checks reduced-motion behavior. These machine assertions are the current release requirement.

## Optional future manual review checklist

The following checklist is retained for a later product-quality pass. It is not required to close V02-B05 for the current release scope.

### Keyboard and zoom

- [ ] Navigate every top-level section using Tab plus the tablist Arrow keys, Home, and End.
- [ ] Complete W1–W5 primary review/start/stop paths without a mouse.
- [ ] Send and stop a Chat response without a mouse.
- [ ] Open Ctrl+K, move through commands, run a command, Escape, and confirm focus returns to the opener.
- [ ] Change custom radio selections with Arrow keys and confirm only one option is in the Tab order.
- [ ] Open the saved-connection transfer review, cycle focus in both directions, Escape, and confirm focus returns to the connection picker.
- [ ] Review C3 tool approval/status, C4 MCP approval/status, and C5 compare/handoff approval/status by keyboard.
- [ ] Confirm every focused interactive control has a visible focus indicator in light and dark themes.
- [ ] Confirm no critical action depends only on hover, pointer precision, or color.
- [ ] At 200% browser zoom, confirm primary content, approvals, errors, and Stop controls remain readable and operable.

### Assistive technology

- [ ] NVDA announces BrowserCrew section tabs with selected state and understandable names.
- [ ] NVDA announces custom radio groups with group/option names and checked state as selection changes.
- [ ] NVDA announces form labels, approval controls, Chat status, errors, and Stop completion at useful times.
- [ ] NVDA announces C5 waiting/approved/stopped/limit states and the bounded transfer review content.
- [ ] NVDA announces the saved-connection transfer dialog title and controls; focus does not escape behind the modal.
- [ ] NVDA announces the Ctrl+K command bar as a dialog with a searchable command control and changing active option.
- [ ] VoiceOver or JAWS follow-up completed if the project later chooses to require another AT/browser combination.

## Evidence required before V02-B05 can pass

Record the exact candidate SHA, successful full quality run, accessibility step result, browser evidence artifact ID/digest, and merged-main verification in `docs/RELEASE-EVIDENCE-v0.2.md`.

A future manual accessibility pass may add defects or stronger requirements, but its absence does not block the current V02-B05 machine-tested gate.