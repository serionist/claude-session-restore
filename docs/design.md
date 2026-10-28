# How session-restore works

For people changing the plugin. What it does for users is in the [README](../README.md); the rules for changing it
are in [AGENTS.md](../AGENTS.md).

## The parts

| File | What |
|---|---|
| `plugin/hooks/register.tsx` | the hooks: `session.start`, `turn.complete`, `session.end`, the `/restore` command, the band above the prompt and the pane; everything that calls `$` |
| `plugin/hooks/lib.ts` | the pure logic, tested without the engine: which sessions count as cut off, the launch flags kept, every command line |
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
- **A session `/resume` brings back** in the same process, even one `/clear` left, is tracked again from its next
  `sync`. A `/resume` starts no `session.start`, so `session.end` with reason `resume` schedules a `sync` a second
  later: the picked session's record is `open` before another session's band could reopen it.
- **The title** is the first prompt's first line, read from the messages only after a new turn (`ctx.titleTurns`): a
  session opened with a slash command has none, and reading up to 4,096 messages a minute would find none again.

## Statuses

| Status | Set when | Offered for restore |
|---|---|---|
| `open` | each turn and heartbeat | when its process is gone: on Windows the pid and its start time no longer match a running claude; elsewhere no heartbeat for 5 minutes |
| `closed` | `session.end` for any reason but a signal: `/exit`, ctrl+c, `/clear`, `/resume`, logout | never |
| `interrupted` | `session.end` with reason `other`: a signal, as when the terminal closes or Windows shuts down | yes |
| `restored` | this plugin reopened it; the resumed session marks it `open` again | no |
| `dismissed` | the person chose Dismiss, Forget all or `/restore forget` | no |

Nothing older than 7 days is offered. On Windows, records untouched for 14 days are deleted at each session's start.

The folder kept is the session's project root (`$.session.root()`), not `cwd()`: a shell `cd` inside a tool moves
the second, and `claude --resume` finds a session only from the folder it started in.

## Finding the claude process (Windows)

At start, and on each heartbeat until it succeeds, a PowerShell script walks up from its own process to the nearest
`claude*` ancestor, through `Win32_Process`, and returns its pid, start time, path and command line. The lookup is
retried because it can time out while MCP servers are still spawning, at most `LOOKUP_TRIES` (5) times, at heartbeats
0, 1, 3, 7 and 15, which covers a slow start after a restore opened many sessions at once: where it can't
succeed (PowerShell blocked, claude running as `node.exe` from npm), the session counts as gone by its heartbeat
alone, as off Windows. The command line becomes `flags`. Every
PowerShell the plugin runs writes UTF-8 (`runPowerShell`): Windows PowerShell otherwise writes to a pipe in the
console's code page, and a path like `C:\Users\Sóma` comes back garbled.

Whether a session still runs is the pair (pid, start time): Windows reuses pids, so a pid alone would keep a dead
session looking alive once another process took its number.

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
- **Elsewhere** (macOS, Linux), `/restore` prints a `cd <folder> && claude --resume <id> ...` line per session, quoted
  for a POSIX shell.

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

`plugin/hooks/lib.test.ts` checks the scripts carry no record text, and `tools/launcher.test.ts` runs them in Windows
PowerShell and PowerShell 7 with hostile arguments, on CI's Windows job.

## The flags kept on resume

`pickResumeFlags` keeps the flags that shape a session and are safe to repeat, and drops the rest (a first prompt,
`-c`, `--resume`, `-p`):

- switches: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--chrome`, `--no-chrome`,
  `--strict-mcp-config`, `--verbose`;
- one value: `--model`, `--fallback-model`, `--permission-mode`, `--agent`, `--settings`, `--plugin-dir`;
- several values: `--add-dir`, `--mcp-config`, `--allowedTools`, `--disallowedTools` and their kebab-case forms.

A session started with `--dangerously-skip-permissions` comes back with it. That is the point (it resumes as it ran),
and the README says so.
