---
title: Open restored sessions in a terminal on macOS and Linux
issue: "#11"
status: approved
approved_by: serionist
approved_at: 2026-10-28
---

# Open restored sessions in a terminal on macOS and Linux

## Goal

Off Windows, Restore today prints a `cd <folder> && claude --resume <id>` line per session and opens nothing; a
restored session loses its launch flags; and a session that only went quiet (a laptop asleep) looks cut off for up to
a minute after waking. When this is done:

- **macOS:** Restore opens each session in a new window of Terminal.app, or of iTerm2 when the restoring session runs
  in iTerm2.
- **Inside tmux** (macOS or Linux): in a new tmux window.
- **Linux:** otherwise in a new window of the desktop's terminal, the first of a fixed list that is installed.
- **Where no terminal can open** (an SSH session outside tmux, no display, none installed, or the person's choice),
  the commands are printed as today, and the transcript says why.
- **Liveness:** each session records its claude process (pid and start), so a session still running is never
  offered, asleep or not.
- **Flags:** on Linux, the launch flags come back on restore, as on Windows.

In scope: the launch on macOS and Linux, the process lookup there, the `terminal` option, the tests, the docs, a test
the maintainer runs by hand.

Out of scope:
- Flags on macOS: `ps` joins a process's arguments with spaces, so a folder with a space can't be told from two
  arguments, and there is no `/proc` (Q4).
- Restoring into a terminal other than the one the restoring session runs in, or the list below.

## Design

### A script per session, never a command line built from text

The Windows rule holds (`docs/design.md`, Where a folder or a flag can never become a command): no record text is
ever read as code. Off Windows:

- **The script.** Restore writes `<config>/session-restore/launch/<id>.sh` for each session, with `$.fs.write`:
  ```sh
  cd '<folder>' || exit 1
  unset CLAUDECODE CLAUDE_PID CLAUDE_CODE_CHILD_SESSION ...   # SESSION_ENV, so claude keeps a transcript
  export CLAUDE_CONFIG_DIR='<the restoring session's>'      # only when it has one (P5)
  '<claude>' '--resume' '<id>' '<flag>' ...
  exec "${SHELL:-/bin/sh}" -l                                  # left out when the shell option is none
  ```
  Every word is POSIX single-quoted (`posixQuote`, the quoting `manualCommand` already uses: `'` becomes `'\''`;
  nothing else is special inside single quotes). The script is run as `/bin/sh <path>`, so it needs no executable bit.
  `<claude>` is the claude on the restoring session's PATH (`command -v claude`), else the record's path (P6). An id
  that is not `[A-Za-z0-9_-]+` is skipped, since it names the file.
- **The terminal** gets fixed words and the script's path, as its own argument to `$.process.run`, never the folder
  (P2: tmux reads `-c` as a format, where `#(...)` runs a command; the script's `cd` sets the folder anyway):

  | Where | Opened with |
  |---|---|
  | macOS, Terminal.app | `osascript -e 'on run argv' -e 'tell application "Terminal"' ... -e 'do script "exec /bin/sh " & quoted form of (item 1 of argv)' ... <script>` |
  | macOS, iTerm2 (`TERM_PROGRAM=iTerm.app` or `LC_TERMINAL=iTerm2`) | `osascript`, a new window with the default profile, `write text` with the same command, the path again through `argv` |
  | inside tmux (`TMUX` set) | `tmux new-window /bin/sh <script>` |
  | Linux, a desktop (`DISPLAY` or `WAYLAND_DISPLAY`) | the first found of `x-terminal-emulator -e`, `gnome-terminal --`, `ptyxis --new-window --`, `konsole -e`, `kitty`, `wezterm start --`, `alacritty -e`, `xterm -e`, each then `/bin/sh <script>` |
  | over SSH (`SSH_CONNECTION` or `SSH_TTY`) outside tmux, or no display | the printed commands, with why (P4) |

  AppleScript sees the path only through `argv`, and `quoted form of` single-quotes it for the shell the window runs.
  Each Linux terminal takes the program and its arguments as separate argv elements after its `-e` or `--`.
- **Started apart** (P1): the Linux desktop terminals run until their window closes (Debian's `x-terminal-emulator`
  is a wrapper that waits on purpose; Konsole, kitty, xterm, wezterm and alacritty run in the foreground), and a call
  past `$.process.run`'s time is killed, the window with it. Each starts through a fixed wrapper,
  `sh -c 'setsid -f "$@" ...' sh <terminal argv>`, which returns at once (`nohup ... &` where there is no `setsid`).
  Only a terminal missing from PATH, checked before, can then be reported. Terminal, iTerm2 and tmux return by
  themselves and report their own failures; `osascript` gets 120 seconds, since the first window may wait on the
  person allowing the app to control Terminal (R3).
- **Each session on its own** (P7): one launch per session; each is marked `restored` once its own window opened, and
  one that failed is named with its command to run.
- **The `shell` option** keeps its name and values (a one-way door). Off Windows `none` ends the window with claude;
  every other value leaves the person's login shell (`$SHELL -l`). Its description says so.
- **The new `terminal` option** (Q2): `auto` (the default: the rules above), or one of `terminal`, `iterm`, `tmux`,
  `x-terminal-emulator`, `gnome-terminal`, `ptyxis`, `konsole`, `kitty`, `wezterm`, `alacritty`, `xterm`, `print`. A
  value this system can't open (iTerm2 on Linux, tmux outside tmux, a terminal not on PATH) prints the commands and
  says why. Adding it makes it a one-way door.
- **macOS from Linux:** `uname -s`, once, at the plugin's start; the engine names no system.

### The process lookup off Windows

- **Finding the claude process** (`LOOKUP`): a fixed `sh` script walks up from its own pid with `ps -o ppid=` to the
  nearest ancestor that is claude (its path from `/proc/<pid>/exe` on Linux, `ps -o comm=` on macOS: named `claude`,
  or a file under `claude/versions/`, where the native installer keeps each version; R1), on through any claude above
  it. It prints the pid, the start (below), the path, and on Linux `/proc/<pid>/cmdline` in base64, whose arguments
  are NUL-separated and exact, through `pickResumeFlags` as on Windows.
- **The start** (P3): on Linux, the boot's id and the tick the process started at, field 22 of `/proc/<pid>/stat`:
  `ps`'s start time is derived from the wall clock, which an NTP step after a laptop wakes moves, and would make every
  running session look gone for good. On macOS, `TZ=UTC0 LC_ALL=C ps -o lstart=`, which macOS stores as it was.
- **Liveness** (`PROCESSES`): every process's `<pid> <start>` the same way, once per scan, with no subshell per process.
- **Pruning** (P8): the lookup also deletes records and scripts untouched for 14 days (`find ... -mtime +14`), the
  folders given as its arguments, never written into the script.
- **Limits:** the same `LOOKUP_TRIES`, at the same heartbeats. Where it can't succeed (`ps` missing, a sandbox), the
  5-minute heartbeat rule stays.

Alternatives not taken:

| Option | Why not |
|---|---|
| `open -a Terminal <script>.command` | Needs an executable bit `$.fs.write` can't set, and a file the system may quarantine; `do script` opens the window just as well |
| AppleScript with the command built into its source | Puts record text into code: the quoting Windows needed base64 for |
| The folder flag of each terminal (`-c`, `--working-directory`) | tmux runs `#(...)` in it (P2); the script's `cd` is enough |
| `ps`'s start time on Linux | Moves with the wall clock (P3) |
| `$TERMINAL` (no standard) or `xdg-terminal-exec` (not yet in most distributions) first | Neither is reliable today; `x-terminal-emulator` is Debian's and Ubuntu's own alternative and leads the list |
| Flags on macOS from `ps -o args` | Ambiguous: a space inside an argument looks like two (Q4) |

### Choices for the maintainer

Answered by the maintainer on 2026-10-28, with the recommendations, Q1 as amended by the plan review.

| # | Question | Answer |
|---|---|---|
| Q1 | Linux terminals: the list and its order? | `x-terminal-emulator`, `gnome-terminal`, `ptyxis` (Ubuntu 25.10, Fedora 41 and later), `konsole`, `kitty`, `wezterm`, `alacritty`, `xterm` |
| Q2 | A new `terminal` option, a one-way door from its release? | Yes, `auto` the default; a value the system lacks prints the commands and says why |
| Q3 | The process lookup and Linux flags in the same change? | Yes, with P3's start |
| Q4 | Flags on macOS? | Not now |
| Q5 | Who tries it by hand on macOS? | The maintainer, on a Mac on 2026-10-29, with `tools/try-restore.sh` (`docs/testing-by-hand.md`), and on Linux. The change merges first, at the maintainer's word; the issue stays open until the test passes, and no release ships before |

## Compatibility

- **Records:** no new field. Off Windows, `pid`, `pidStarted` and `exe` now get values, and on Linux `flags` too, in
  the formats already declared (strings and numbers). Records written before this change have none, and stay judged
  by the heartbeat rule.
- **One-way doors:** `shell` keeps its name and values, with a meaning off Windows it never had (documented); the new
  `terminal` option becomes one.
- **Behaviour:** off Windows, Restore now opens windows where it printed commands. A person who wants the old way
  sets `terminal` to `print`.
- **Files:** `<config>/session-restore/launch/` holds one script per session restored, replaced at its next restore,
  pruned with the records after 14 days.

## Steps

1. **The script and its quoting** in `lib.ts`: `posixQuote`, `sessionScript`, `appleScript`, `terminalArgv`,
   `detached`. Tests in `lib.test.ts`: a hostile record's script, line by line; no terminal's argv holds the folder.
   And in `tools/launcher.test.ts`, on Linux and macOS CI: `sh <script>` with Node in place of claude starts in a
   hostile folder and gets every argument whole; the detached start returns within seconds; the Terminal AppleScript
   compiles (`osacompile`) on macOS.
2. **Choosing the terminal and the launch** in `register.tsx`: `chooseTerminal`, `available`, `restoreUnix`. Tests in
   `register.test.tsx`: Linux desktop, tmux, macOS with iTerm2, SSH, `print`, a terminal this system lacks, one of two
   launches failing, `CLAUDE_CONFIG_DIR` kept.
3. **The process lookup** off Windows: `LOOKUP`, `PROCESSES`, `parseLookup`. Tests: the parsing in `lib.test.ts`; on
   Linux and macOS CI, the lookup under a parent named `claude` finds it, and the listing agrees on its start under
   two time zones; in the kit, a looked-up session's flags, and a running session not offered.
4. **Docs and the option:** `plugin.json` (`terminal`, the `shell` description; a test keeps its values the code's),
   `README.md`, `plugin/README.md`, `docs/design.md`, `docs/testing-by-hand.md`, `CHANGELOG.md`, `AGENTS.md`.
5. **`review-code`,** then the PR, which says `Refs #11`: the maintainer closes the issue after step 6.
6. **By hand**, by the maintainer after the merge: `tools/try-restore.sh` on a Mac (Terminal.app, iTerm2, tmux) and on
   Ubuntu (the desktop's terminal, `xterm`, tmux), each window left open over 30 seconds; on Linux, the restored
   session's flags in its `ps` line (improvement 4: whether a real claude's `/proc/<pid>/cmdline` still holds them).

## Tests

- **Unit, every system** (`lib.test.ts`, `register.test.tsx`, Claude Code's test kit): the scripts, the argv per
  terminal, the choice of terminal, the launch, the lookup's parsing.
- **Real shells on CI** (`tools/launcher.test.ts`, its Linux and macOS legs): the session's script run by `sh`, the
  detached start, the lookup and the listing run for real; the Terminal AppleScript compiled on macOS.
- **By hand only** (`docs/testing-by-hand.md`): a window actually opening, in each terminal; CI runners have no
  desktop.

## Docs

`README.md`, `plugin/README.md`, `docs/design.md`, `docs/testing-by-hand.md`, `CHANGELOG.md`, `AGENTS.md` (the
`terminal` option among the one-way doors; Traps), `plugin.json`'s option texts.

## Risks

| # | Risk | Status |
|---|---|---|
| R1 | macOS's `ps -o comm=` for the native installer's claude | Open: the lookup accepts `claude` or a path under `claude/versions/`; the by-hand test shows it. Linux's comm is `claude` (the kernel takes the PATH name) |
| R2 | A terminal's flags differ by version | Lower now: no terminal gets a folder flag; each takes only `-e` or `--` and a path. The by-hand test runs the first in the list and `xterm` |
| R3 | macOS asks the person once to let the restoring app control Terminal or iTerm2 | Accepted: `osascript` gets 120 seconds; a refusal is reported with the commands |
| R4 | iTerm2's AppleScript is deprecated in favour of its Python API | Accepted: it still works and gets fixes; Terminal.app stays the fallback |
| R5 | No CI runner has a desktop, so no test opens a window | Accepted: step 6, by hand |
| R6 | A detached terminal that fails after it started can't be reported | Accepted: the window doesn't open, the record stays `restored`, and the session is offered again only if its process is not found |

## Plan review

### Round 1

- **How:** one fresh reviewer with the review-plan method and lenses, on 2026-10-28, against `2dd23fd`, reading the
  engine's types and the terminals' sources and manuals.
- **Verdict:** needs-fixes, with 2 blockers, 1 major and 5 minors; no change of design or scope.
- **Now:** all applied.

| # | Sev | Finding | Status |
|---|---|---|---|
| P1 | blocker | Most Linux launchers block until their window closes (Debian's wrapper adds `--wait`; Ptyxis, Konsole, kitty, xterm in the foreground): after 30 s the engine kills the terminal and the restored claude, or the restore is reported failed and offered again while it runs | fixed: every Linux desktop terminal starts apart (`setsid -f`); a test that the start returns at once |
| P2 | blocker | `tmux new-window -c <folder>` expands the folder as a format, and `#(...)` runs a command | fixed: no terminal gets the folder; a test that no argv holds it |
| P3 | major | Linux's `lstart` is derived from the wall clock, so a clock stepped after a wake makes every running session look gone for good | fixed: the boot id and the start tick from /proc; macOS in UTC; a test across time zones |
| P4 | minor | Over SSH to a Mac, osascript opens windows on the Mac's screen; inside tmux on a Mac, iTerm2 users got Terminal | fixed: SSH outside tmux prints; tmux first on both systems; `LC_TERMINAL` for iTerm2 |
| P5 | minor | `CLAUDE_CONFIG_DIR` was not carried into the window, so `--resume` looked in `~/.claude` | fixed: exported in the script when set; a test |
| P6 | minor | The record's path is the versioned file an update replaces; iTerm2's command runs without a login shell | fixed: the claude on the restoring session's PATH |
| P7 | minor | One flag for the whole batch marked or lost sessions when one of several launches failed | fixed: each session marked on its own; a test |
| P8 | minor | Pruning was promised but no step did it, and `$.fs` has no delete | fixed: the lookup prunes, its folders as arguments |

Owner calls: Q1 amended (`ptyxis`); Q2, Q3 (with P3), Q4 agreed; Q5 widened (the first terminal in the list and
`xterm`, windows left open over 30 seconds).

Refuted: npm installs running as node (the package copies the native binary over its placeholder); Linux's comm not
being `claude` (the kernel takes the PATH name); tmux too old for several arguments (2.0 and later); osascript taking no
arguments (they reach the run handler); `x-terminal-emulator -e` going through a shell (Debian Policy 11.8.3); no
Linux CI leg (the gate's job runs the tools' tests); `$.fs.write` not making `launch/` (it makes its folders);
splitting `ps` output (step 3's test).

Improvements: telling macOS from Linux, taken (`uname -s`); `LC_TERMINAL` for iTerm2, taken; a longer time for
osascript, taken (120 s); `/proc/<pid>/cmdline` of a real claude, taken into step 6.
