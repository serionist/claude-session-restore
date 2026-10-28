---
subject: "Open restored sessions in a terminal on macOS and Linux (PR #12)"
base: main (d07d606)
head: b4a8385
date: 2026-10-28
round: 1
tier: standard (one fresh reviewer, which ran the generated scripts under dash, bash and bash --posix on Ubuntu 22.04 and mutated the code on a copy; findings checked by the main session)
verdict: needs-fixes
---

# Review: Open restored sessions in a terminal on macOS and Linux (PR #12)

One fresh reviewer read the branch against `REVIEW.md`, every lens, the plan and issue #11. It ran the gate (14
checks), read CI's run on the head (the Linux and macOS legs ran the shell tests), ran `LOOKUP`, `PROCESSES`,
`DETACH` and a session's script for real under dash, bash and `bash --posix`, and removed each change in turn on a copy
of the plugin to see which test fails.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F1 | blocker | `lib.ts`, `lib.test.ts`, `register.test.tsx` | Six `biome-ignore` comments for `noTemplateCurlyInString`: an ignore added, which REVIEW.md makes a blocker without the maintainer's yes | fixed: the strings are template literals with `\${...}`, the same text; no ignore left |
| F2 | major | `lib.ts` `LOOKUP`, `PROCESSES`; `isInterrupted` | Two machines sharing one records folder (an NFS home, a container mounting `~/.claude`) judged each other's sessions by their own pids: a running session on one was offered on the other | fixed: every start off Windows is `<machine>|<start>` (the boot and the pid namespace on Linux, the boot session on macOS); another machine's record is judged by its heartbeat; `lib.test.ts` "several machines sharing one records folder" |
| F3 | major | `register.test.tsx` | The no-display rule had no test: the test named for it set `DISPLAY` | fixed: a Linux world with no display, no SSH |
| F4 | minor | `register.tsx` `available` | A Linux terminal named in the option skipped the display check: over SSH it died unseen, and its session counted as restored for good | fixed: a named Linux terminal needs a display; a test; the plan's R6 corrected |
| F5 | minor | `register.test.tsx` | Untested branches: tmux before SSH, `LC_TERMINAL`, a named terminal not installed | fixed: a test each |
| F6 | minor | `AGENTS.md`, `docs/design.md`, `lib.ts` | Docs still said the lookup and reopening were Windows-only, named only `shell`, and left `posixQuote` out of Never; a blank line split design.md's table | fixed |
| F7 | minor | `tools/try-restore.sh` | Stored as 100644, so the by-hand test's first command failed on a fresh clone | fixed: 100755 |

Refuted: a folder starting with `-` (the root is absolute); `posixQuote` edge cases (a folder with `'`, `$(...)`,
backticks, `#(...)`, `;`, `%`, `\`, a newline and non-ASCII, and flags empty, `-`, `=opus`, a trailing `\`, a JSON with
a newline, all came back exact under three shells); tmux reading the script's path (several arguments are run
directly); `${x##*) }` with `) ` inside a process name; the wrong ancestor; `DETACH` and its fallback (4 and 5 ms);
`base64` wrapping, `find -mtime`, `read` and `shift`; macOS `ps` (CI's leg matched the listing and the lookup);
`try-restore.sh`'s JSON grep and `ls -t`; `CLAUDE_CONFIG_DIR` quoting.

Improvements:

1. An empty listing taken for none: taken, else every running session would look gone.
2. The parent pid from `/proc` on Linux, for containers without `ps`: taken; on Linux the lookup reads /proc alone.
3. `nohup` where `setsid -f` fails (busybox has no `-f`): taken.
4. `runSh` and the launch in `/`, and a failed terminal search as a reason: taken.
5. The claude to run checked before a window opens: taken, else that session's command is printed; a test.
6. `try-restore.sh check` looking only where a command could have run, not deep in `$HOME`, whose Desktop and
   Documents macOS guards with a prompt: taken.
7. REVIEW.md question 5 naming `posixQuote`, sh, tmux and AppleScript: taken; stricter only.
8. One `isUnix(ctx)` for the three copies of the system test: taken.

Not covered: the iTerm2 AppleScript, never compiled (no runner has iTerm2); a window actually opening, a real claude's
`/proc/<pid>/cmdline`, and macOS's process name for the native installer, all left to the maintainer's test by hand
(`docs/testing-by-hand.md`).

## Checks

After the fixes: the lookup, the listing (two time zones), the detached start and the parse under dash and bash rerun
on Ubuntu 22.04 (WSL): the lookup found its `claude` through /proc alone, the start `<boot>/pid:[ns]|<tick>` matched
the listing's, the start returned in 4 ms. `node tools/gate.ts full` passed its 14 checks: 61 plugin tests, 73 tool
tests, the plugin's types.
