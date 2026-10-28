# How session-restore works

For people changing the plugin. What it does for users is in the [README](../README.md); the rules for changing it
are in [AGENTS.md](../AGENTS.md).

## The parts

| File | What |
|---|---|
| `plugin/hooks/register.tsx` | the hooks: `session.start`, `turn.complete`, `session.end`, `classic.SessionStart`, the `/restore` command, the band above the prompt and the pane; everything that calls `$` |
| `plugin/hooks/register.test.tsx` | the hooks through the engine's test kit: the record's life, the band's clicks, the restores, the clock mocked |
| `plugin/hooks/lib.ts` | the pure logic, tested without the engine: which sessions count as cut off, the launch flags kept, every command line and script, for Windows and for macOS and Linux |
| `plugin/types/index.d.ts` | `SessionRecord`, `SessionStatus`, and the plugin's one `$.state` value, `session-restore.interrupted` |
| `plugin/hooks/lib.test.ts` | the tests, run by `claude plugin test plugin` in the engine's sandbox |

The hooks module runs inside Claude Code, with no Node and no DOM. It reaches the disk with `$.fs`, processes with
`$.process`, the session with `$.session`, and the screen with `$.ui`.

## One record per session

Each interactive terminal session writes `<config>/session-restore/sessions/<session id>.json`, where `<config>` is
`CLAUDE_CONFIG_DIR`, else `~/.claude`. Sessions started by another session's tool (`CLAUDE_CODE_CHILD_SESSION` set)
keep no transcript to resume, so they write none.

| Field | What |
|---|---|
| `id`, `cwd` | the session and its folder, what `claude --resume` needs |
| `title` | the first line of the first prompt, at most 80 characters, for the list |
| `status` | below |
| `startedAt`, `lastSeen`, `endedAt` | milliseconds; `lastSeen` moves on every turn and every heartbeat |
| `endReason` | the reason `session.end` gave |
| `pid`, `pidStarted`, `exe` | the claude process and its start time (Windows), so a later scan can tell whether it still runs |
| `flags` | the launch flags worth repeating on resume (`pickResumeFlags`) |

A record is written from the session's first turn: before that there is no transcript, and `--resume` would find
nothing. `/clear` and `/resume` end one session and start another in the same process; the old record is closed and a
new one starts at the next turn.

- **A record's last word is the close.** `sync` (each turn and heartbeat) notes how many sessions had ended in this
  process when it started (`ctx.ends`), and saves nothing if one ended while it waited. Every write of a record goes
  through one queue (`ctx.writes`), in the order asked, so a save asked for before the close can't land after it.
  An end other than `/clear` or `/resume` ends the process, and tracking stops there: a heartbeat before the exit
  writes nothing.
- **A session `/resume` brings back** in the same process, even one `/clear` left, is tracked again from its next
  `sync`. A `/resume` starts no `session.start`; the settings hook event `SessionStart` with source `resume`
  (`classic.SessionStart`) fires once the picked session is in place, and starts a `sync`: its record is `open`
  before another session's band could reopen it.
- **The title** is the first prompt's first line, read from the messages only after a new turn (`ctx.titleTurns`): a
  session opened with a slash command has none, and reading up to 4,096 messages a minute would find none again.

## Statuses

| Status | Set when | Offered for restore |
|---|---|---|
| `open` | each turn and heartbeat | when its process is gone: its pid and start time no longer match a running process; where the lookup found none, no heartbeat for 5 minutes |
| `closed` | `session.end` for any reason but a signal: `/exit`, ctrl+c, `/clear`, `/resume`, logout | never |
| `interrupted` | `session.end` with reason `other`: a signal, as when the terminal closes or Windows shuts down | yes |
| `restored` | this plugin reopened it; the resumed session marks it `open` again | no |
| `dismissed` | the person chose Dismiss, Forget all or `/restore forget` | no |

Nothing older than 7 days is offered. Records untouched for 14 days are deleted by the process lookup, with the
scripts of macOS and Linux.

The folder kept is the session's project root (`$.session.root()`), not `cwd()`: a shell `cd` inside a tool moves
the second, and `claude --resume` finds a session only from the folder it started in.

## Finding the claude process (Windows)

At start, and at later heartbeats until it succeeds, a PowerShell script walks up from its own process to the nearest
`claude*` ancestor, through `Win32_Process`, and returns its pid, start time, path and command line. The lookup is
retried because it can time out while MCP servers are still spawning, at most `LOOKUP_TRIES` (5) times, at heartbeats
0, 1, 3, 7 and 15, which covers a slow start after a restore opened many sessions at once: where it can't
succeed (PowerShell blocked, claude running as `node.exe` from npm), the session counts as gone by its heartbeat
alone, as off Windows. The command line becomes `flags`. Every
PowerShell the plugin runs writes UTF-8 (`runPowerShell`): Windows PowerShell otherwise writes to a pipe in the
console's code page, and a path like `C:\Users\Sóma` comes back garbled.

Whether a session still runs is the pair (pid, start time): Windows reuses pids, so a pid alone would keep a dead
session looking alive once another process took its number.

## Finding the claude process (macOS, Linux)

The same, through `sh` (`LOOKUP`): it walks up with `ps -o ppid=` to the nearest ancestor that is claude, named
`claude` or a file under `claude/versions/` (where the native installer keeps each version), and prints its pid, start
time, path and, on Linux, its arguments from `/proc/<pid>/cmdline`, NUL-separated and exact, which become `flags`.
macOS has no exact arguments (`ps` joins them with spaces), so its sessions come back without their flags. The
listing (`PROCESSES`) gives every process's start the same way:

- **Linux:** the boot's id and the tick the process started at (`/proc/<pid>/stat`, field 22). `ps`'s start time is
  derived from the wall clock, which a laptop's wake may step, and would make every running session look gone.
- **macOS:** `ps`'s start time in UTC, which macOS stores as it was.

The lookup's folders reach it as arguments, never written into the script.

## Offering and restoring

- **The scan** reads every record, skips this session's own, and publishes the cut-off ones to `$.state`, which the
  band and the pane read. It runs at start, on `/restore`, and before and after every restore or dismiss.
- **The band** (`AbovePrompt`) shows when there are any: Restore all, Choose (the pane), Dismiss. It stays out of the
  way while Claude Code shows a survey.
- **A click acts on the list as it is now** (`stillCutOff`): the band shows the list as last scanned, and since then
  another session may have restored a session, or the person resumed it by hand. Restore and Dismiss scan again and
  leave alone each session no longer cut off, saying how many. They run one at a time (`oneAtATime`): the band stays
  clickable while a launch runs, and a second click scans after the first marked its sessions `restored`.
- **A click says what it did** (`restoreFromClick`): what Restore did goes to the transcript as dim lines the model
  never sees, one per line, since the terminal draws a line's first 2,000 characters: the sessions reopened, a
  launch's error, each folder that is gone, and off Windows the commands to run; a toast says it succeeded, failed
  or put commands there. `/restore` returns the same text as its output. The launch and the `restored` marks fail
  apart: a mark that can't be saved after a good launch says so, never "Could not open a terminal". A session whose
  folder is gone stays offered: a network or removable drive comes back, and Dismiss is one click.
- **Restoring** writes a plan (`launchPlan`) to `<config>/session-restore/launch.json` and runs a fixed PowerShell
  script (`launchScript`) that reads it. The script first clears the session variables (`SESSION_ENV`): Windows
  Terminal gives new tabs the caller's environment, and a claude that sees them runs as a child session with no
  transcript. Then `wt -w claude-restore` opens a tab per session in its folder, titled with the folder's name,
  running `claude --resume <id> <flags>` inside the chosen shell; many sessions take several calls (`wtLines`), each
  within a command line's 32,767 characters. Without Windows Terminal, `Start-Process` opens a console window per
  session in its folder. `Start-Process` hands the new processes none of the launcher's handles, so the launcher
  returns at once.
- A session whose folder no longer exists is skipped and named.
- **On macOS and Linux** (`restoreUnix`), each session gets a script, `<config>/session-restore/launch/<id>.sh`
  (`sessionScript`): `cd` into the folder, the session variables cleared, `CLAUDE_CONFIG_DIR` kept when the restoring
  session has one, the claude on the restoring session's PATH run with `--resume <id>` and the flags, then the
  person's login shell unless the `shell` option is `none`. A terminal then opens a window running `/bin/sh <script>`
  (`terminalArgv`), chosen by `chooseTerminal`: the `terminal` option; else tmux inside tmux; nothing over SSH, where
  a window would open on the other machine; Terminal or iTerm2 (`TERM_PROGRAM`, `LC_TERMINAL`) on macOS; on Linux with
  a display, the first of `LINUX_TERMINALS` on PATH. Where none can open, the commands are printed with why:
  `cd <folder> && claude --resume <id> ...`, quoted for a POSIX shell.
- **Started apart:** the Linux desktop terminals run until their window closes (Debian's `x-terminal-emulator` waits
  on purpose), and a call held past its time is killed, the window with it. They start through `setsid -f`
  (`detached`), which returns at once; Terminal, iTerm2 and tmux return by themselves, and say when they failed.
- Each session is marked `restored` once its own window opened; one that failed is named, with its command.

## Where a folder or a flag can never become a command

A record's folder, flags and claude path are input: a folder may be named `R&D`, `x’$(calc)’` or `%PATH%`. None of
them is ever text a shell reads as code:

| Reader | How the text reaches it |
|---|---|
| PowerShell | only as base64 (`psString`): the plan's path in the launcher, the claude path and arguments in a tab's script (`runArgvScript`). Doubling `'` would not do: PowerShell takes the curly quotes U+2018 to U+201B for quotes too |
| a tab's shell | the tab runs `powershell -EncodedCommand <base64>` (or pwsh), whose every part is a fixed word or base64 (`tabArgv`). The script moves into the session's folder first (`Set-Location -LiteralPath`), since a profile may have moved it. `cmd` and `none` run it in a PowerShell without a profile, which then starts cmd or ends with claude: cmd never sees a folder or a flag |
| `Start-Process` | the console fallback's folder goes through `WildcardPattern.Escape`: `Start-Process` reads a working directory as a pattern, and `[old] api` would match nothing |
| Windows Terminal | its arguments are quoted the way Windows splits a command line (`crtQuote`), with `;` written `\;`, the one character `wt` splits on itself |
| claude | the tab script passes the arguments as an array; on PowerShell before 7.3 it escapes their double quotes and trailing backslashes first, which that PowerShell does not, so `--settings '{"a": 1}'` arrives whole. A bare `claude` (the path was not found) runs the program on PATH, never npm's `claude.ps1`, and without the flags: npm's `claude.cmd` would hand them to cmd |

| `sh`, on macOS and Linux | inside the session's script only, each word single-quoted (`posixQuote`: `'` written `'\''`, nothing else special inside) |
| AppleScript | the script's path only, as the run handler's argument (`osascript -e ... <path>`), never in the source; `quoted form of` quotes it for the window's shell |
| tmux and the Linux terminals | the script's path as an argument of its own, after `-e` or `--`; never the folder, since tmux reads `-c` as a format, where `#(...)` runs a command |

`plugin/hooks/lib.test.ts` checks the scripts carry no record text, and `tools/launcher.test.ts` runs them for real
with hostile arguments: in Windows PowerShell and PowerShell 7 on CI's Windows job, in `sh` on its Linux and macOS
jobs. A window opening is tried by hand (`docs/testing-by-hand.md`).

## The flags kept on resume

`pickResumeFlags` keeps the flags that shape a session and are safe to repeat, and drops the rest (a first prompt,
`-c`, `--resume`, `-p`):

- switches: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--chrome`, `--no-chrome`,
  `--strict-mcp-config`, `--verbose`;
- one value: `--model`, `--fallback-model`, `--permission-mode`, `--agent`, `--settings`, `--plugin-dir`;
- several values: `--add-dir`, `--mcp-config`, `--allowedTools`, `--disallowedTools` and their kebab-case forms.

A session started with `--dangerously-skip-permissions` comes back with it. That is the point (it resumes as it ran),
and the README says so.
