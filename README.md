# session-restore

A Claude Code plugin that reopens the sessions a crash, a restart or a closed terminal cut off, on Windows, macOS and
Linux.

[![CI](https://github.com/serionist/claude-session-restore/actions/workflows/ci.yml/badge.svg)](https://github.com/serionist/claude-session-restore/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Your machine restarts for an update with six Claude sessions open in six folders. The next time you start Claude, a
band above the prompt says so:

```
6 Claude sessions were cut off  [Restore all]  [Choose]  [Dismiss]
api-server · docs · infra · +3 more
```

**Restore all** opens each session in its folder, running `claude --resume <id>` with the flags it was started with:

| System | Where |
|---|---|
| Windows | one Windows Terminal window, a tab per session |
| macOS | a Terminal window each, or iTerm2 when you restore from iTerm2 |
| Linux | a window each in the first installed of `x-terminal-emulator`, `gnome-terminal`, `ptyxis`, `konsole`, `kitty`, `wezterm`, `alacritty`, `xterm` |
| inside tmux (macOS, Linux) | a new tmux window each |
| over SSH, or with no display | no window: the commands to run, in the transcript |

**Choose** opens a pane to pick them one by one. What a
click did is written to the transcript, as a dim line the model never sees, and a session restored meanwhile from
another window, or resumed by hand, is left alone.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install session-restore --marketplace serionist/claude-session-restore
```

Answer `y` to add the marketplace, then choose the **user** scope: the plugin tracks a session only when it loads in
it, so it has to load in all of them. From a shell, the same is
`claude plugin install session-restore --marketplace serionist/claude-session-restore`.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `serionist/claude-session-restore`, then **Add plugin**.

Built and tested on Claude Code 2.1.294 to 2.1.312. The plugin API it uses is early access and may change between
Claude Code releases; an issue with your version helps.

## Use

| Command | What |
|---|---|
| `/restore` | lists the cut-off sessions and opens the pane |
| `/restore all` | reopens all of them |
| `/restore 2`, `/restore 1,3` | reopens some, by their number in the list |
| `/restore 3fa9c1` | reopens the one whose session id starts so |
| `/restore forget` | drops them from the list |

**Options** (in `/config`, under the plugin):

- `shell`: what each restored window leaves you in when claude exits. On Windows `powershell` (the default), `pwsh`
  or `cmd`; on macOS and Linux, any of those leaves your login shell. `none` closes the window with claude.
- `terminal` (macOS, Linux): `auto` (the default, as in the table above), one of `terminal`, `iterm`, `tmux`,
  `x-terminal-emulator`, `gnome-terminal`, `ptyxis`, `konsole`, `kitty`, `wezterm`, `alacritty`, `xterm`, or `print`
  for the commands instead. A terminal this system lacks prints the commands and says why.

## How it knows

Every interactive terminal session keeps a small record of itself, refreshed each minute and on every turn:

- **Leaving on purpose** (`/exit`, ctrl+c, `/clear`, `/resume`) marks it closed: never offered.
- **A closed terminal or a shutdown** ends it on a signal, which marks it interrupted: offered.
- **A crash or a power cut** leaves it open; the next session sees its claude process is gone (its id and start time
  no longer match a running one): offered. A session that only went quiet, a laptop asleep, is never offered.

Sessions cut off more than 7 days ago are not offered. [docs/design.md](docs/design.md) has the detail.

## What it keeps, and where

One JSON file per session in `~/.claude/session-restore/sessions/` (under `CLAUDE_CONFIG_DIR` when that is set): the
session's id and folder, the first line of its first prompt (80 characters at most, to tell sessions apart in the
list), the claude process's id, start time and path, and the launch flags worth repeating. Nothing leaves your
machine. Records untouched for 14 days are deleted. A restore also writes, beside the folder, `launch.json` on Windows
(the plan the launcher reads) or `launch/<id>.sh` on macOS and Linux (the script a window runs), each replaced by
the next restore.

**Folder names are never commands.** A folder named `R&D` or `x’$(calc)’` reaches PowerShell, Windows Terminal, cmd,
`sh`, tmux and AppleScript only as data, never as text they read as code ([docs/design.md](docs/design.md)).

**Flags come back.** A session restores with the flags it was started with: `--model`, `--add-dir`,
`--permission-mode`, and `--dangerously-skip-permissions` too, if you used it.

## Limits

- **macOS** restores a session without its flags: `ps` can't tell where an argument with a space ends.
- **The first restore on macOS** may ask you to let the app that runs claude control Terminal or iTerm2.
- **Without Windows Terminal,** each session opens in a console window of its own.
- **A session with no prompt yet** has no transcript to resume, so it is not tracked.
- **Sessions started by another session's tool** (a nested claude) keep no transcript and are not tracked.
- **Nothing runs until you open a Claude session** after the restart: the plugin lives inside Claude Code.

## Uninstall

`/plugin uninstall session-restore@session-restore`. The records stay in `~/.claude/session-restore/` until you delete
the folder.

## Developing

```
git clone https://github.com/serionist/claude-session-restore.git
cd claude-session-restore
npm ci
node tools/setup.ts
```

`npm ci` installs the pinned dev tools (Claude Code, Biome, TypeScript) without running any install script;
`node tools/setup.ts` turns on the git hooks. Then:

- `claude --plugin-dir plugin` starts a session with the plugin from this clone, and reloads it each time you save.
  Turn the installed copy off first (`claude plugin disable session-restore@session-restore`), or both track the
  session. Loading it also writes the plugin API's types to `plugin/.claude-plugin/types/`, which the gate checks.
- `node tools/gate.ts full` runs every check and test; the pre-push hook runs `quick`.

[CONTRIBUTING.md](CONTRIBUTING.md) is the short path to a pull request; [AGENTS.md](AGENTS.md) has the full rules, for
people and AI agents alike.

## Licence

[MIT](LICENSE). Not affiliated with Anthropic.
