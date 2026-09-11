# BrowserCrew development rules

Read docs/PRD.md, docs/UI-COPY-RULEBOOK.md, docs/adr/001-feasibility.md and docs/DESIGN-SYSTEM.md before changes.

- Implement v0.1 W1/W3 before broadening capabilities. Future roadmap items must not appear functional.
- Use actual vendored NeoBrutal-Soft tokens/classes. Compress controls on hover; never lift. Respect light/dark, 320px, reduced motion, forced colors and keyboard access.
- Settings need plain-language helper text, consequences, examples and recommendations.
- Models propose; policy authorizes; engine journals; browser revalidates. No arbitrary eval, remote scripts, cookie export or OS tools.
- Session-only credentials; no credentials in tasks, logs or prompts. Page content is untrusted.
- Persist intent before mutation. Unknown outcomes block rather than retry. Pause/stop cannot reverse accepted effects.
- Run npm ci, npm run check and npm run test:e2e. Record genuine failures and exact commit evidence.
- Do not claim model/provider compatibility based solely on scripted tests. No real cloud/local benchmark has been run until explicitly recorded with model/server/browser versions.
- Preserve source provenance and report the scope of outcome verification honestly.
