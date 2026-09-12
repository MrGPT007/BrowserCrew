# BrowserCrew v0.2 Chrome Web Store media evidence

Status: **Engineering media readiness only — not submitted and not approved.**

This document records reproducible store-media evidence without treating a generated screenshot as Chrome Web Store submission or approval.

## Exact-candidate screenshot

`scripts/store-media-smoke.mjs` launches the installed Manifest V3 extension in Chromium, configures a deterministic local LM Studio-compatible endpoint through the real **Connect AI** surface, opens three local supplier fixtures, prepares the real **Workspace → Compare pages** UI with those user-selected pages, and captures the visible extension viewport.

The generated file is:

`artifacts/store-media/browsercrew-workspace-1280x800.png`

The executable check validates:

- PNG signature and IHDR structure;
- exact dimensions of **1280×800**;
- a non-trivial rendered file size;
- use of the installed extension rather than a hand-built marketing mock;
- use of the shipped Connect AI and Workspace interaction surfaces; and
- an evidence receipt tied to the exact candidate SHA.

The CI workflow uploads the screenshot and sanitized `report.json` separately as `store-media-evidence` with `if-no-files-found: error`.

## Remaining required media

The 1280×800 product screenshot can move to `generated_by_ci` after this executable evidence passes. The following required assets remain missing and must not be marked ready prematurely:

- **128×128 PNG extension/store icon** included in the submitted extension ZIP.
- **440×280 small promotional tile** for the Chrome Web Store listing.

Optional media such as a 1400×560 marquee image or a product video does not block this engineering slice unless the chosen Dashboard flow later requires it.

## External boundary

Generated store media does not close `V02-B08`. The final candidate still needs a public privacy-policy/support URL, the remaining required media, accurate Developer Dashboard declarations, exact package upload, and Chrome Web Store review/publication evidence. Issue #50 remains the tracking blocker.
