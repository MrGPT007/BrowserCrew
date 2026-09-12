# Rollback Procedure

BrowserCrew is not yet a public store release, so the current rollback unit is a known-good Git commit plus the unpacked-extension installation.

## Development rollback

1. Stop testing the candidate that introduced the regression.
2. Identify the last exact commit whose required CI jobs passed.
3. Revert the failing change in Git rather than editing a distributed copy by hand.
4. Run the same static and installed-extension suites that guarded the affected capability.
5. Load the reverted repository root as the unpacked extension and verify the relevant controlled fixture.
6. Record the rollback commit and reason in the PR/release evidence.

Never fix an uncertain write/download by rerunning the user action blindly. Task recovery rules still apply after code rollback: inspect destination state first and require user review when the prior outcome cannot be proved.

## Current known-good baseline

The W1–W5 combined installed-Chromium suite passed for PR #10 head `46d4facb81feba544b48b8217ca1d9e0f00480a6` in GitHub Actions run `34668876723`; that code was squash-merged to `main` as `ae58670026b29eea95cf1f6d75065253eb9c774d`.

This is a development baseline, not a permanent release rollback target. A final v0.2 release must replace this section with the exact tagged candidate and artifact hash.

## Future packaged/store rollback

Before public distribution, retain the previously accepted extension package, source commit, migration expectations, and store version metadata. If a release must be withdrawn, stop rollout where the distribution channel permits it, restore the last supported package/version, communicate any state-migration limitation, and keep evidence needed to understand tasks that were in flight.

Storage migrations must be backward/forward behavior-tested before a public rollback promise is made. No current document claims that arbitrary future schema migrations are reversible.
