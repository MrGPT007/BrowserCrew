# Rollback Procedure

BrowserCrew is not yet a public store release. Until a tagged public version exists, rollback means returning to an exact previously accepted Git commit or previously accepted package candidate and then rerunning the evidence appropriate to that version.

## Development rollback

1. Stop testing the candidate that introduced the regression.
2. Identify the last exact commit whose required CI jobs passed.
3. Revert the failing change in Git rather than editing a distributed copy by hand.
4. Install the exact dependency lock for that commit with `npm ci --ignore-scripts`.
5. Run the same static and installed-extension suites that guarded the affected capability.
6. Load the reverted repository root as the unpacked extension and verify the relevant controlled fixture.
7. Record the rollback commit and reason in the PR/release evidence.

Never fix an uncertain write/download by rerunning the user action blindly. Task recovery rules still apply after code rollback: inspect destination state first and require user review when the prior outcome cannot be proved.

## Candidate-package rollback

Every accepted candidate must retain all four pieces of identity together:

- exact source commit SHA;
- `browsercrew-v0.2-candidate.zip`;
- `browsercrew-v0.2-candidate.zip.sha256`;
- `package-manifest.json` containing the packaged file list and source-tree/package hashes.

To return from a bad candidate to the previous accepted candidate:

1. Stop using the bad candidate and preserve its hash/evidence for diagnosis.
2. Retrieve the previous accepted ZIP and its recorded SHA-256 receipt. Do not rebuild it from a moving branch and call that the same artifact.
3. Verify the ZIP SHA-256 against the retained receipt before installation.
4. Extract the previous ZIP into a new empty directory. Do not overlay it on the bad candidate directory.
5. In `chrome://extensions`, remove or reload the development candidate as appropriate, then use **Load unpacked** on the clean extracted previous package.
6. Open BrowserCrew and rerun the capability check that motivated rollback. For release evidence, run the package smoke plus the release gates required for that candidate.
7. Record the previous package hash, source commit, rollback reason, and verification result.

The package-integrity automation proves that the current candidate can be generated deterministically from one source tree and loaded from its extracted ZIP. It does not by itself claim that arbitrary future storage-schema migrations are reversible.

## Current known-good baseline

The latest merged release-hardening baseline before the package-integrity candidate is `main` commit `f778086d0c3266c47e3a4e656500207e6da1dc15`, which includes PR #31 privacy closure. Its exact PR head `f3d67da2107cace3569ba766ecb409a125b30f55` passed static checks and the full installed-extension matrix in Actions run `34697517491` after an unchanged browser-job retry.

This is a known-good source baseline, not yet a permanent packaged rollback artifact. V02-B07 remains open until a deterministic package candidate and its install evidence are certified on an exact PR head.

## Public/store rollback later

Before public distribution, retain the previously accepted extension package, source commit, package hash, migration expectations, and store version metadata. If a release must be withdrawn, stop rollout where the distribution channel permits it, restore the last supported package/version, communicate any state-migration limitation, and keep evidence needed to understand tasks that were in flight.

Storage migrations must be backward/forward behavior-tested before a public rollback promise is made. No current document claims that arbitrary future schema migrations are reversible.
