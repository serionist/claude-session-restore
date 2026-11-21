---
subject: "Add /sessions, session names and opening Claude at Windows logon"
base: main (dec13ec)
head: 9ad11e2
date: 2026-11-21
round: 1
tier: standard (one fresh reviewer; findings checked against the code by the main session, F1 reproduced by a test)
verdict: needs-fixes
---

# Review: Add /sessions, session names and opening Claude at Windows logon

One fresh reviewer read the diff, the touched files, the API types and every lens; the author fixed each finding.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F1 | major | `register.tsx` `track` | With `autostart` `all`, `SESSION_RESTORE_AUTOSTART` stayed in the logon session's process, and a reload of the plugin (an option changed, an update) ran `track` again: sessions closed since were reopened without a click. Reproduced with two `session.start`s. | fixed: d3fb1e5, unset once read; test "a reload of the logon session restores nothing closed since (F1)" |
| F2 | minor | `README.md`, `plugin.json` | Said the option takes effect at the next session's start; changing it reloads the plugin at once. | fixed: d3fb1e5 |
| F3 | minor | `README.md` Uninstall | Uninstalling left the Startup file, and a claude kept opening at each logon; nothing said so. | fixed: d3fb1e5, Uninstall says to set `off` first or delete the file |
| F4 | minor | `lib.ts` `isRunning` | `/sessions 3` twice within seconds could reopen a session still starting: `restored` did not count as running. | fixed: d3fb1e5, `restored` within `STALE_MS` runs, `lastSeen` stamped; tests in `lib.test.ts` and "(F4)" |
| F5 | minor | `lib.ts` `AUTOSTART_SCRIPT` | The variable was set before starting `wt`, so a Windows Terminal started at logon could hand it to tabs opened later. Unverified on real Windows Terminal. | fixed: d3fb1e5, set only inside the tab's own PowerShell; N2's test holds it |
| F6 | minor | `docs/design.md` | The `## Offering and restoring` heading was lost. | fixed: d3fb1e5 |
| F7 | minor | tests | No test of two starts, of nothing written off Windows, of `isRunning` without a listing. | fixed: d3fb1e5 |

Refuted: record text reaching a shell through `name` or `title` (`labelOf` reaches only the UI and command output);
injection through the `.cmd` (fixed words and base64, the removal path through `psString`); restored sessions
restoring again (`SESSION_ENV` clears the variable); the logon session leaving records (none before a prompt); reading
the transcript each heartbeat (once per turn); anything off Windows (`placeAutostart` runs on Windows only); old
versions reading `name` (an added optional field); `/sessions` reopening a live session when the lookup fails (the
heartbeat decides); a race between the logon restore and a click (`oneAtATime`).

Not covered: plan and intent (no issue, no plan: the change went straight to a PR at its author's request); Windows 10,
Windows PowerShell 5.1 and older Windows Terminal versions, tried by no one.

Improvements:

- Each `command.register` with its own `.catch`, so a refused command doesn't stop tracking: taken.
- `SESSION_ENV` uses `AUTOSTART_ENV`: taken.
- `stillCutOff` renamed `stillReopenable`, now that it serves `/sessions` too: taken.
- The transcript's path from the classic events' `transcript_path` rather than derived: left, the derived path covers
  the usual case and the record keeps its name otherwise; worth an issue.
- The Startup file may flash a Windows Terminal window on Windows 11: left, it has to open one anyway.

## Round 2

**Where:** d3fb1e5, the fixes since 9ad11e2, one fresh reviewer. **Verdict:** clean once its three minors were fixed
in this session (no blocker or major, so no further round).

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| N1 | minor | `register.tsx` `track` | `$.env.set` may answer `{ deny }` under managed settings; ignored, the variable stays and F1 comes back on a reload. | fixed: the next commit, a refused unset restores nothing and says why; test "(N1)" |
| N2 | minor | `lib.test.ts`, `tools/launcher.test.ts` | No test held F5, and no real PowerShell parsed `AUTOSTART_SCRIPT`. | fixed: no line of the script sets `$env:`, the tab's string does; `launcher.test.ts` parses it in each PowerShell |
| N3 | minor | `register.tsx` `stillReopenable` | A session restored a moment ago whose tab closed at once was refused as "still running". | fixed: the reply says "still running, or reopened less than 5 minutes ago" |

F1 to F7 confirmed fixed, each with the line and test named above. Refuted: module init order in `lib.ts`; the test
world's `env.get`/`env.set` handlers; `lastSeen` on `restored` changing pruning (by file time), `MAX_AGE_MS` or
`isInterrupted` (open records only).

Improvement: read and unset the variable at the start of `track`, before the process lookup's seconds: taken.

## Checks

- `node tools/gate.ts full` on Node 24.22.3, Windows 11: passed, 81 plugin tests and 73 tool tests; gitleaks not
  installed, so not scanned; the plugin's API types skipped (no session loaded the mod), `claude plugin validate` on
  Claude Code 2.1.330 reports no new type error.
- The logon script's tab command run in Windows PowerShell against a stand-in `claude.cmd` in a folder named
  `pasta com espaço`: the tab saw `SESSION_RESTORE_AUTOSTART=1`, the outer process did not; the `wt` line built was
  `-w claude-restore new-tab -d "C:\Users\<user>" powershell.exe -NoProfile -EncodedCommand ...`.
- Not tried: a real logon, a real restore from the band, `/sessions` and a `/rename` in a live session.
