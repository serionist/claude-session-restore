---
subject: "The plugin and the harness, before the first public commit"
base: none (the repo had no commit)
head: the staged tree of the first commit
date: 2026-10-28
round: 1
tier: standard (one fresh reviewer over the whole repo; findings checked against the code by the main session)
verdict: needs-fixes
---

# Review: the plugin and the harness, before the first public commit

A path review of the whole repo as it stood before its first commit: the plugin as it ran on the maintainer's machine
since 2026-10-08, and the harness ported from the maintainer's other repos. One fresh reviewer read everything and
ran nothing of the plugin; its probes imported `lib.ts` and asked PowerShell's own parser about the generated scripts.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F1 | blocker | `lib.ts` `psQuote` | PowerShell takes U+2018 to U+201B for quotes too, and `psQuote` doubled only `'`: a folder named `D:\repos\x’$(calc)’` ran `calc` while the launcher built Windows Terminal's arguments, and a flag or a claude path holding `’` did the same inside the tab. A folder like `Soma’s notes` could never be restored. | fixed: record text reaches PowerShell only as base64 (`psString`, `runArgvScript`); `lib.test.ts` "a tab runs claude through a script that carries ...", `launcher.test.ts` in Windows PowerShell and PowerShell 7 |
| F2 | blocker | `lib.ts` the console fallback, `tabCommand` for `cmd` | cmd read record text unquoted: without Windows Terminal a folder `D:\R&D` became `start ... /D D:\R&D powershell.exe ...`, `&` ending `start` and running the rest; with `shell=cmd`, `--add-dir D:\R&D` broke out the same way. | fixed: no record text reaches cmd; `cmd` and `none` run the tab's PowerShell, console windows start through `Start-Process`; `lib.test.ts` "each shell keeps ...", "without Windows Terminal ..." |
| F3 | major | `register.tsx` `sync` | The record kept `$.session.cwd()`, which a shell `cd` in a tool moves, so the restore opened a folder `claude --resume` could not find the session from. | fixed: the record keeps `$.session.root()` |
| F4 | major | `register.tsx` `identify` | Windows PowerShell writes to a pipe in the console's code page: `C:\Users\Sóma\claude.exe` came back `C:\Users\S�ma\claude.exe`, and every restore for that user failed. | fixed: every script starts with UTF-8 output (`runPowerShell`) |
| F5 | major | `register.tsx` the band and the pane | The buttons drop what `restore()` returns: on macOS and Linux Restore does nothing visible, and on Windows a failed launch or a skipped folder is silent. | open: issue |
| F6 | major | `register.tsx` `restore`, `dismiss` | They act on the list as last scanned: a second session's band, or a session resumed by hand since, restores a session that is running again, two claude processes on one transcript. | open: issue |
| F7 | major | `lib.ts` the console fallback | `cmd /c start` likely left the restored console holding the launcher's output pipe, so the call waited 30 seconds, said it failed, and left the sessions offered while they ran. Not reproduced. | fixed, by reading: `Start-Process` uses ShellExecute, which hands over no handles; the fallback was not run live |
| F8 | minor | `register.tsx` `sync`, `session.end` | A heartbeat's `sync` that started before `/exit` or `/clear` can save the record `open` again after `session.end` closed it; the dead session is then offered. | open: issue |
| F9 | minor | `lib.ts` `launchScript` | The whole launcher went on one command line, about 1,500 characters a session: some 21 sessions or more passed CreateProcess's 32,767 and Restore all failed. | fixed: the plan goes in a file, and `wtLines` splits Windows Terminal's calls under 30,000 characters; `lib.test.ts` "many sessions take several Windows Terminal calls" |
| F10 | minor | `tools/gate.ts` `cliScope` | Before the first push there is no `origin/main`, and the gate failed telling you to fetch it. | fixed: it checks all of HEAD's history and says so |
| F11 | minor | `README.md`, `plugin/README.md` | The 14-day prune runs on Windows only; `/restore <id prefix>`, a one-way door in `AGENTS.md`, was in neither README. | fixed |
| F12 | minor | `lib.ts` `tabCommand` | A flag holding `"` (an inline `--settings` JSON) lost its quotes: Windows PowerShell does not escape them for a native program. | fixed: `runArgvScript` escapes them where PowerShell passes arguments the old way; `launcher.test.ts` |

Refuted: JavaScript's ASCII `\w` in the ported attribution patterns (only stricter); the first push with no
`origin/main` in `pre-push` (handled); `;` in folders (`wtEscape`, tested); the workflows' security (`pull_request`
only, PR text through the environment, read-only tokens); a missing record folder (`$.fs.write` creates it); the
`--marketplace` flag in the README (it exists); `pickResumeFlags` taking a prompt after `--add-dir` (claude parses the
same way); POSIX quoting in `manualCommand`; half-written records (caught).

Improvements:

- Run each tab's command as `-EncodedCommand`: taken.
- Pass the records to the launcher as data: taken, as a plan file.
- Cap the process lookup's retries, which start a PowerShell every minute for a session's whole life when the lookup
  can't succeed: later, issue.
- Read the messages for a title only when the turn count changed: later, issue.

Not covered: a live restore through the plugin's band (the live run below drove the plugin's launcher and Windows
Terminal directly); the console fallback without Windows Terminal, live; the Claude Code versions between 2.1.294 and
2.1.305, whose types were not read.

## Round 2

**Where:** the fixes to F1 to F4, F7 and F9 to F12, on the same staged tree; one fresh reviewer, who ran the
launcher's and the gate's tests and asked PowerShell's parser about the generated scripts, and read Windows
Terminal's and PowerShell's sources for how they read a `new-tab` line and `Start-Process`. **Verdict:** clean; every
fix confirmed, with five new minors, fixed in this round.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F13 | minor | `launchScript`, the console fallback | `Start-Process` reads `-WorkingDirectory` as a wildcard pattern: without Windows Terminal, a session in `D:\work\[old] api` matched nothing, the launcher stopped, and the consoles it had opened were offered again. | fixed: `WildcardPattern.Escape`; `lib.test.ts` "the launcher reads its plan ..." |
| F14 | minor | `tabArgv` for `cmd` | Where the claude path was not found (npm's claude runs as node.exe), a bare `claude` in PowerShell took npm's `claude.ps1`, which a Restricted execution policy refuses; before F2's fix, cmd took `claude.cmd`. | fixed: the tab script runs the program on PATH (`-CommandType Application`), never a `.ps1`, and a bare `claude` gets no flags, which `claude.cmd` would hand to cmd; `lib.test.ts` "flags come back only with ..." |
| F15 | minor | `tabArgv` for `cmd` | `cmd /k` carried the base64 command, past cmd's 8,191 characters once the flags held some 1,850 (an inline `--mcp-config`). | fixed: the tab is PowerShell, which starts cmd after claude; cmd reads no command line; `lib.test.ts` "each shell keeps its tab open ..." |
| F16 | minor | `register.tsx`, `gate.ts` | The record's root, the plan and the launcher's run had no test, nor the gate's first-push branch. | fixed: `register.test.tsx` (the root, the plan, the launcher's UTF-8 line, the record marked restored; it fails with `cwd()`), `gate.test.ts` "before the first push ...", `launcher.test.ts` "Windows PowerShell writes UTF-8 ..." |
| F17 | minor | `docs/design.md`, this record's F7 row | The macOS and Linux bullet sat under the wrong heading, and F7's status cited a run that did not use the fallback. | fixed |

Refuted: Windows Terminal expanding `%PATH%` in `-d` (it copies the value); `--title` or `-d` values starting with `-`;
`;` and `\;` round trips; wt's rejoin of the tab's command (every part is inert); `-ArgumentList` with one string;
`Get-Content -Encoding UTF8` with or without a BOM; `ConvertFrom-Json` shapes; one tab past a line's length (some
8,700 characters of flags); a 2,048-character ShellExecute cap (the live run passed 2,200); two restores sharing
`launch.json` (within a second of each other; F6's issue covers the rest).

Improvements: set the folder in the tab script, taken; one `psString` per argument instead of a JSON round trip,
taken; `UTF8_OUTPUT` in `lib.ts` with a test, taken; the launcher's error as plain text, taken; a live run of 15 or
more sessions, left: it opens that many tabs, and the line's length is tested; the plan named after the session,
left: F6's issue.

## Live run

On Windows 11 (10.0.26300), Windows Terminal 1.24.12741, Windows PowerShell 5.1.26100 for both the launcher and the
tab: the plugin's `launchScript` read a plan written beside it and opened one Windows Terminal tab in a folder named
`R&D x’$(calc)’; 100%`, running the plugin's tab script with Node in place of claude, so what arrived could be read
back. The launcher returned in about one second with exit 0; the program got
`--resume live-test-0000 --add-dir D:\R&D --settings {"a": 1} x’$(calc)’ %PATH%` whole and ran in that folder; no
calculator started. Not shown: claude itself resuming a real session, which needs a session cut off for real; the
console fallback. The run was before round 2: round 2's tab script (the folder set first, the program looked up)
ran in `tools/launcher.test.ts`, in both PowerShells, not through Windows Terminal.

## Checks

`node tools/gate.ts full` after round 2: 14 checks, the plugin's types against those Claude Code 2.1.294 wrote, the
plugin's 21 tests on Claude Code 2.1.305, the tools' 72 tests (the launcher's 6 in Windows PowerShell 5.1.26100 and
PowerShell 7.6.9 on this machine).
