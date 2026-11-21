# session-restore

Reopens the Claude Code sessions a crash, a restart or a closed terminal cut off, on Windows, macOS and Linux.

After a restart, the next Claude session shows a band above the prompt: **Restore all**, **Choose**, **Dismiss**.
Restoring opens each session in its folder, running `claude --resume <id>` with the flags it was started with: on
Windows in one Windows Terminal window, a tab each; on macOS in Terminal or iTerm2; on Linux in the desktop's
terminal; inside tmux in a new tmux window. Over SSH, or with no display, it prints the commands instead. What a click
did is written to the transcript, as a dim line the model never sees, and a session restored meanwhile from another
window, or resumed by hand, is left alone.

| Command | What |
|---|---|
| `/restore` | lists the cut-off sessions and opens the pane |
| `/restore all` | reopens all of them |
| `/restore 2`, `/restore 1,3` | reopens some |
| `/restore <id prefix>` | reopens the one whose session id starts so |
| `/restore forget` | drops them from the list |
| `/sessions [words]` | lists the sessions of every folder, or those whose name, prompt or folder holds the words |
| `/sessions 3` | reopens one by its number, unless its claude still runs |

Options (in `/config`):

- `shell`, what a window leaves you in when claude exits: `powershell` (default), `pwsh`, `cmd`, or `none`, which
  closes it; on macOS and Linux, anything but `none` leaves your login shell.
- `terminal` (macOS, Linux): `auto` (default), a terminal by name, or `print` for the commands instead.
- `autostart` (Windows): `off` (default); `ask` opens a claude at logon that shows the band, `all` one that reopens
  every session cut off by itself.

Install it at the user scope, so it loads in every session. It keeps one small record per session in
`~/.claude/session-restore/sessions/`, on this machine only.

The full README, with what it keeps and its limits: https://github.com/serionist/claude-session-restore
