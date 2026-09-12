# BrowserCrew v0.2 Accessibility Audit

Status: **ENGINEERING AUDIT IN PROGRESS**

Human assistive-technology signoff: **OUTSTANDING**

This document separates executable accessibility engineering evidence from the manual assistive-technology review required by the v0.2 release plan. A green automated suite is **NOT a substitute for manual screen-reader review**.

## Automated engineering audit

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

The automated audit remains part of the mandatory installed-extension matrix. It is regression protection for semantics and keyboard behavior, not a claim that every assistive-technology/browser combination behaves identically.

## 200% zoom and narrow-width review

Automation verifies that BrowserCrew does not disable browser zoom and that the primary side-panel layout avoids page-level horizontal overflow at 360 CSS pixels in light and dark mode. The final human review must also inspect the primary flows at **200%** browser zoom for clipped text, obscured controls, lost content, and unusable approval surfaces.

## Manual keyboard review checklist

Run the packaged final release candidate, not a development rebuild. Record browser version, OS, candidate SHA, date, reviewer, defects, and fixes.

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

## Manual screen-reader review checklist

At minimum, record one Windows/Chrome review with **NVDA** where available. A second pass with VoiceOver/Safari or VoiceOver/Chrome on macOS is recommended; JAWS may be recorded when available. Do not check an item merely because the Chromium AX tree looked correct.

- [ ] NVDA announces the BrowserCrew section tabs with selected state and understandable names.
- [ ] NVDA announces custom radio groups with group/option names and checked state as selection changes.
- [ ] NVDA announces form labels, helper relationships where needed, and approval controls without requiring visual inference.
- [ ] NVDA announces Chat response status, error status, and Stop completion at useful times without excessive duplicate speech.
- [ ] NVDA announces C5 waiting/approved/stopped/limit states and the bounded transfer review content.
- [ ] NVDA announces the saved-connection transfer dialog title and controls; focus does not escape behind the modal.
- [ ] NVDA announces the Ctrl+K command bar as a dialog with a searchable command control and changing active option.
- [ ] NVDA can understand result/evidence sections and the difference between informational status, warning, and approval-required states without relying on color.
- [ ] VoiceOver or JAWS follow-up completed, or the release evidence explicitly records why that additional AT/browser combination was unavailable.

## Evidence required before V02-B05 can pass

Record the exact final candidate SHA, merged-main CI run, accessibility artifact ID/digest, browser version, OS, manual keyboard reviewer, screen reader/version, defects found, fixes, and retest result in `docs/RELEASE-EVIDENCE-v0.2.md`.

Until that record exists, the Accessibility gate remains **Blocked** and V02-B05 remains open.