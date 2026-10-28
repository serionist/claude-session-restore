# session-restore

Reopens the Claude Code sessions a crash, a Windows restart or a closed terminal cut off.

After a restart, the next Claude session shows a band above the prompt: **Restore all**, **Choose**, **Dismiss**.
Restoring opens one Windows Terminal window with a tab per session, each in its folder, running
`claude --resume <id>` with the flags it was started with.

| Command | What |
|---|---|
| `/restore` | lists the cut-off sessions and opens the pane |
| `/restore all` | reopens all of them |
| `/restore 2`, `/restore 1,3` | reopens some |
| `/restore <id prefix>` | reopens the one whose session id starts so |
| `/restore forget` | drops them from the list |

Option `shell` (in `/config`), what a tab leaves you in when claude exits: `powershell` (default), `pwsh`, `cmd`, or
`none`, which closes the tab.

Install it at the user scope, so it loads in every session. It keeps one small record per session in
`~/.claude/session-restore/sessions/`, on this machine only. On macOS and Linux, `/restore` prints the commands to
run instead.

The full README, with what it keeps and its limits: https://github.com/serionist/claude-session-restore
