# BrowserCrew v0.2 Chrome Web Store media evidence

Status: **Engineering media readiness only — not submitted and not approved.**

This document records reproducible store-media evidence without treating generated assets as Chrome Web Store submission or approval.

## Exact-candidate product screenshot

`scripts/store-media-smoke.mjs` launches the installed Manifest V3 extension in Chromium, configures a deterministic local LM Studio-compatible endpoint through the real **Connect AI** surface, opens three local supplier fixtures, prepares the real **Workspace → Compare pages** UI with those user-selected pages, and captures the visible extension viewport.

The generated file is:

`artifacts/store-media/browsercrew-workspace-1280x800.png`

The executable check validates:

- PNG signature and IHDR structure;
- exact dimensions of **1280×800**;
- a non-trivial rendered file size;
- use of the installed extension rather than a hand-built product screenshot;
- use of the shipped Connect AI and Workspace interaction surfaces; and
- an evidence receipt tied to the exact candidate SHA.

## Reviewed extension/store icon

BrowserCrew uses the existing product `B` mark and NeoBrutal Soft visual language for its extension icon set. The committed icon files are:

- `src/assets/icons/browsercrew-16.png`
- `src/assets/icons/browsercrew-32.png`
- `src/assets/icons/browsercrew-48.png`
- `src/assets/icons/browsercrew-128.png`

The required 128×128 icon is `src/assets/icons/browsercrew-128.png`. Its reviewed SHA-256 is:

`8bcec8327cb641996bddf9a0f5817c7e5014c3dd272ab74a25d40491d9023eb7`

`scripts/store-assets-smoke.mjs` verifies each icon's exact dimensions and reviewed SHA-256. `manifest.json` maps the same files as both extension icons and toolbar action icons, while `scripts/package-release.mjs` requires all four files inside the deterministic release ZIP. The 128×128 file is copied into the exact-candidate `store-media-evidence` artifact as `browsercrew-icon-128.png`.

## Exact-candidate small promotional tile

The 440×280 Chrome Web Store small promotional tile is rendered by `scripts/store-assets-smoke.mjs` from the reviewed BrowserCrew brand lockup rather than kept as an untraceable hand-edited binary. The composition uses the existing product `B` mark, **BrowserCrew**, **Your browser workbench**, and the NeoBrutal Soft palette already shipped by the extension.

The generated file is:

`artifacts/store-media/browsercrew-small-promo-440x280.png`

The executable proof validates the exact **440×280** PNG dimensions, a non-trivial file size, the expected brand copy in the rendering source, and records the generated file's SHA-256 in `report.json` on the exact candidate SHA.

## Evidence artifact

The CI workflow runs `npm run store-media-smoke`, which performs the installed-extension screenshot proof and then the icon/promotional-asset proof. It uploads the complete `artifacts/store-media` directory separately as `store-media-evidence` with `if-no-files-found: error`.

The evidence artifact therefore contains:

- `browsercrew-workspace-1280x800.png`;
- `browsercrew-icon-128.png`;
- `browsercrew-small-promo-440x280.png`; and
- sanitized `report.json` tied to the exact candidate SHA.

## External boundary

Engineering media readiness does not close `V02-B08`. The final candidate still needs the reviewed privacy-policy/support URLs entered in the Developer Dashboard, the required assets uploaded there, accurate Privacy Practices/listing declarations, the exact final package upload, the Chrome Web Store item ID, and review/publication evidence. Issue #50 remains the tracking blocker.
