---
title: Open restored sessions in a terminal on macOS and Linux
issue: "#11"
status: draft
approved_by:
approved_at:
---

# Open restored sessions in a terminal on macOS and Linux

## Goal

Off Windows, Restore today prints a `cd <folder> && claude --resume <id>` line per session and opens nothing; a
restored session loses its launch flags; and a session that only went quiet (a laptop asleep) looks cut off for up to
a minute after waking. When this is done:

- **macOS:** Restore opens each session in a new window of Terminal.app, or of iTerm2 when the restoring session runs
  in iTerm2.
- **Linux:** in a new tmux window when the restoring session runs inside tmux; otherwise in a new window of the
  desktop's terminal, the first of a fixed list that is installed.
- **Everywhere off Windows:** where no terminal can be opened (an SSH session, no display, none of the list
  installed), the commands are printed as today, and the transcript says why.
- **Liveness:** each session records its claude process (pid and start time), so a session still running is never
  offered, asleep or not.
- **Flags:** on Linux, the launch flags come back on restore, as on Windows.

In scope: the launch on macOS and Linux, the process lookup there, the tests, the docs.

Out of scope:
- Flags on macOS: `ps` joins a process's arguments with spaces, so a folder with a space can't be told from two
  arguments, and there is no `/proc` (Q4).
- Restoring into a tmux session or a terminal other than the one the restoring session runs in.
- Terminals beyond the list below; a person can name one in the new option (Q2).

## Design

### A script per session, never a command line built from text

The Windows rule holds (`docs/design.md`, Where a folder or a flag can never become a command): no record text is
ever read as code. Off Windows:

- **The script.** Restore writes `<config>/session-restore/launch/<id>.sh` for each session, with `$.fs.write`:
  ```sh
  cd '<folder>' || exit 1
  unset CLAUDECODE CLAUDE_PID CLAUDE_CODE_CHILD_SESSION ...   # SESSION_ENV, so claude keeps a transcript
  '<claude>' '--resume' '<id>' '<flag>' ...
  exec "${SHELL:-/bin/sh}" -l                                  # left out when the shell option is none
  ```
  Every word is POSIX single-quoted (`posixQuote`, the quoting `manualCommand` already uses: `'` becomes `'\''`;
  nothing else is special inside single quotes). The script is run as `sh <path>`, so it needs no executable bit.
- **The terminal** gets only the script's path, and the folder for its own working directory, each as its own
  argument to `$.process.run`, never joined into a string a shell parses:

  | Where | Opened with |
  |---|---|
  | macOS, Terminal.app | `osascript -e 'on run argv' -e 'tell application "Terminal" to do script "exec /bin/sh " & quoted form of (item 1 of argv)' -e 'end run' <script>` |
  | macOS, iTerm2 (`TERM_PROGRAM=iTerm.app`) | `osascript` with `create window with default profile command ("/bin/sh " & quoted form of (item 1 of argv))`, the path again through `argv` |
  | Linux, inside tmux (`TMUX` set) | `tmux new-window -c <folder> /bin/sh <script>` |
  | Linux, a desktop (`DISPLAY` or `WAYLAND_DISPLAY` set) | the first found of `x-terminal-emulator -e /bin/sh <script>`, `gnome-terminal --working-directory=<folder> -- /bin/sh <script>`, `konsole --workdir <folder> -e /bin/sh <script>`, `kitty --directory <folder> /bin/sh <script>`, `wezterm start --cwd <folder> -- /bin/sh <script>`, `alacritty --working-directory <folder> -e /bin/sh <script>`, `xterm -e /bin/sh <script>` |
  | Linux, neither | the printed commands, with "No terminal to open: run these" |

  AppleScript sees the path only through `argv`, and `quoted form of` POSIX-quotes it for the shell Terminal runs.
  Each Linux terminal takes the program and its arguments as separate argv elements after its `-e` or `--`, so no
  shell reads the path.
- **Many sessions:** one launcher call per session; no command line grows with the number of sessions.
- **The `shell` option** keeps its name and values (a one-way door). Off Windows `none` ends the window with claude;
  every other value leaves the person's login shell (`$SHELL -l`) in it. Its description says so.
- **A new option, `terminal`** (Q2): `auto` (the default: the rules above), or one of `terminal`, `iterm`, `tmux`,
  `gnome-terminal`, `konsole`, `kitty`, `wezterm`, `alacritty`, `xterm`, `print`. Adding it makes it a one-way door.

### The process lookup off Windows

- **Finding the claude process** (`identify`): a fixed `sh` script walks up from its own pid with
  `ps -o ppid= -p <pid>` to the nearest ancestor that is claude: its `comm` is `claude`, or its executable sits under a
  `claude/versions/` folder, where the native installer keeps each version as a file named by its version (R1). It
  prints the pid and `LC_ALL=C ps -o lstart= -p <pid>`, the start time to the second in a fixed format.
- **Flags, Linux only:** `/proc/<pid>/cmdline`, whose arguments are NUL-separated and exact, through
  `pickResumeFlags` as on Windows.
- **Liveness** (`liveness`): `LC_ALL=C ps -A -o pid=,lstart=` once per scan; a record whose pid and start time no
  longer match is gone, as on Windows. A pid and start time are only ever compared with others from the same `ps`, so
  their format never has to be parsed.
- **Limits:** the same `LOOKUP_TRIES`, at the same heartbeats. Where it can't succeed (`ps` missing, a sandbox), the
  5-minute heartbeat rule stays.

Alternatives not taken:

| Option | Why not |
|---|---|
| `open -a Terminal <script>.command` | Needs an executable bit `$.fs.write` can't set, and a file the system may quarantine; `do script` opens the window just as well |
| AppleScript with the command built into its source | Puts record text into code: the quoting Windows needed base64 for |
| `$TERMINAL` (no standard) or `xdg-terminal-exec` (not yet in most distributions) first | Neither is reliable today; `x-terminal-emulator` is Debian's own alternative and leads the list |
| Flags on macOS from `ps -o args` | Ambiguous: a space inside an argument looks like two (Q4) |

### Choices for the maintainer

| # | Question | Recommendation |
|---|---|---|
| Q1 | Linux terminals: the list and its order above? | Yes; it covers GNOME, KDE and the common GPU terminals, with Debian's own choice first |
| Q2 | A new `terminal` option, a one-way door from its release? | Yes, with `auto` the default; without it a person whose terminal isn't first in the list can't pick theirs |
| Q3 | The process lookup and Linux flags in the same change, or later? | Same change: Restore off Windows is only worth trusting with liveness, and the code sits beside the launch's |
| Q4 | Flags on macOS? | Not now: `ps` loses the argument boundaries; a later change could read them through `sysctl` (KERN_PROCARGS2) |
| Q5 | Who tries it by hand on macOS? | The maintainer, on a Mac, before the release; Linux on the maintainer's Ubuntu |

## Compatibility

- **Records:** no new field. Off Windows, `pid`, `pidStarted` and `exe` now get values, and on Linux `flags` too, in
  the formats already declared (strings and numbers). Records written before this change have none, and stay judged
  by the heartbeat rule.
- **One-way doors:** `shell` keeps its name and values, with a meaning off Windows it never had (documented); the new
  `terminal` option becomes one (Q2).
- **Behaviour:** off Windows, Restore now opens windows where it printed commands. A person who wants the old way
  sets `terminal` to `print`.
- **Files:** `<config>/session-restore/launch/` holds one script per session restored, replaced at the next restore of
  that session; records older than 14 days are pruned with their scripts.

## Steps

1. **The script and its quoting** in `lib.ts`: `posixQuote` (from `manualCommand`), `sessionScript(rec, shell)`,
   `terminalArgv(kind, script, folder)` per terminal. Tests in `lib.test.ts`: a hostile record's script holds each
   part single-quoted and decodes back; every `terminalArgv` keeps the path as one element. And in
   `tools/launcher.test.ts`, on Linux and macOS CI: `sh <script>` with Node in place of claude starts in a hostile
   folder (`R&D x'$(calc)'; [old] 100%`) and gets every argument whole; the `osascript` source has no record text.
2. **Choosing the terminal** in `register.tsx`: from `TERM_PROGRAM`, `TMUX`, `DISPLAY`/`WAYLAND_DISPLAY`, the
   `terminal` option and `$.process.run(['sh', '-c', 'command -v ...'])` for the list. Tests in `register.test.tsx`:
   each environment picks its terminal, `print` and no display print the commands, a launch that fails says why.
3. **The process lookup** off Windows: `identify` and `liveness` for macOS and Linux, `/proc` flags on Linux. Tests:
   the parsing of `ps` and `/proc` output in `lib.test.ts`; on Linux and macOS CI, the real lookup script finds a
   parent named `claude` (a copy of `sh` started under that name) and its start time matches the liveness listing.
4. **Docs and the option:** `plugin.json` (`terminal`, the `shell` description), `README.md` and `plugin/README.md`
   (what Restore does on each system, the new option), `docs/design.md`, `CHANGELOG.md`, `AGENTS.md` (one-way doors,
   Traps).
5. **By hand**, before the PR is ready: on the maintainer's Ubuntu (GNOME, and inside tmux) and on a Mac (Terminal.app
   and iTerm2), restore two sessions cut off by closing their windows, one in a folder with a space and a `'`.
6. **`review-code`,** then the PR.

## Tests

- **Unit, every system** (`lib.test.ts`, `register.test.tsx`, Claude Code's test kit): the scripts, the argv per
  terminal, the choice of terminal, the lookup's parsing.
- **Real shells on CI** (`tools/launcher.test.ts`, its Linux and macOS legs): the generated script run by `sh`, the
  lookup script run for real; the AppleScript source parsed by `osacompile` on macOS without running it.
- **By hand only:** a window actually opening, in each terminal; CI runners have no desktop.

## Docs

`README.md`, `plugin/README.md`, `docs/design.md` (a section for macOS and Linux beside Windows'), `CHANGELOG.md`,
`AGENTS.md` (the `terminal` option among the one-way doors; Traps as they turn up), `plugin.json`'s option texts.

## Risks

| # | Risk | Status |
|---|---|---|
| R1 | The native installer's claude runs as a file named by its version (`~/.local/share/claude/versions/2.1.312`), so `comm` is not `claude` | Open: the lookup also accepts an executable under `claude/versions/`; to check by hand on both systems |
| R2 | A terminal's flags differ by version (gnome-terminal's `-e` is deprecated; kitty's `--directory`) | Open: each terminal's argv checked against its `--help` on the maintainer's Ubuntu; the script's own `cd` makes the folder flag a nicety, not a need |
| R3 | macOS asks the person once to let the restoring app control Terminal or iTerm2 (Automation permission) | Accepted: a first restore may show the system's prompt; a refusal is reported with the printed commands |
| R4 | iTerm2's AppleScript is deprecated in favour of its Python API | Accepted: it still works and gets fixes; Terminal.app stays the fallback |
| R5 | No CI runner has a desktop, so no test opens a window | Accepted: step 5, by hand |

## Plan review

Written by `review-plan`.
