# Releasing

Users get a new version of the plugin only when `plugin/.claude-plugin/plugin.json`'s version changes: Claude Code
compares it when it updates a marketplace. The marketplace serves `main`, so a version is out the moment its release
PR merges. The tag and the GitHub release record it.

## Versions

SemVer, one literal version in `plugin.json`. In `0.x` a minor may break a one-way door, under the CHANGELOG's
Breaking with how to move over; a patch never does.

## Steps

1. **The release PR,** from `main`, titled `Release X.Y.Z`:
   - `CHANGELOG.md`: rename `## Unreleased` to `## X.Y.Z (YYYY-MM-DD)`, dated the day it merges, and start a new empty
     `## Unreleased` above it;
   - `plugin.json`: `"version": "X.Y.Z"`;
   - `node tools/gate.ts full` passes; its version check reads the dated section.
2. **Try it** from the branch before the merge: `claude plugin marketplace add <the clone's folder>`, then install or
   update `session-restore` from it, and restore a session by hand (`finish-work`, Try it in a real session).
3. **Merge** on the maintainer's word.
4. **Tag** the merge commit at once: `git tag vX.Y.Z <sha>` and `git push origin vX.Y.Z`. `release.yml` checks that
   the tag is on `main`, that it equals `plugin.json`'s version and that the CHANGELOG has its dated section, then
   publishes the GitHub release with that section as its notes.

A release that went wrong is fixed forward with the next patch: a version once on `main` may already be installed.
