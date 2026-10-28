# Security

session-restore runs inside every Claude Code session you open, and it starts processes: PowerShell, Windows Terminal
and claude itself. A flaw here runs with your rights.

## Report a vulnerability

Report it privately: the repository's **Security** tab > **Report a vulnerability**, or
[this link](https://github.com/serionist/claude-session-restore/security/advisories/new). Only the maintainer sees it.
Never put a vulnerability in an issue, a pull request or a discussion: anyone can read those.

Include what you can: the plugin's version, your Windows and Claude Code versions, what an attacker can do and what
they need first, and the smallest reproduction, with invented folders and no real session's prompt. You'll get an
answer within a week; the fix is developed in the advisory and the advisory published with the fixed version,
crediting you unless you ask otherwise.

## What counts

- A folder name, a launch flag or a record that makes a restore run a command it should not: through PowerShell,
  Windows Terminal, `cmd` or the printed commands.
- Anything that restores sessions, opens a terminal or dismisses a record without the person's click or command.
- A session's record (its folder, its first prompt, its flags) reaching anywhere but the person's own config folder.

## Supported versions

The latest release only. Fixes ship as a new version; Claude Code installs it on the next marketplace update.
