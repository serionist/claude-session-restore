# Changelog

What each release changes for the people who install the plugin, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. A change users notice adds its line under Unreleased
in the same PR; `docs/releasing.md` says how a release dates it.

## Unreleased

## 0.1.0 (2026-10-28)

The first public release.

### Added

- A record per interactive terminal session in `~/.claude/session-restore/sessions/`, refreshed every minute and on
  every turn, closed when you leave on purpose and marked interrupted when a signal ends the session.
- On Windows, the claude process's id and start time, so a crash or a power cut is told apart from a session still
  running; elsewhere, a session silent for 5 minutes counts as gone.
- A band above the prompt when sessions were cut off: Restore all, Choose, Dismiss; and a pane to pick them.
- `/restore`, `/restore all`, `/restore 2`, `/restore 1,3`, `/restore <id prefix>`, `/restore forget`.
- Restoring on Windows: one Windows Terminal window, `claude-restore`, a tab per session in its folder, running
  `claude --resume <id>` with the launch flags worth repeating; a console window each without Windows Terminal. On
  macOS and Linux, the commands to run.
- The `shell` option: `powershell`, `pwsh`, `cmd` or `none`.
- A folder, a flag or a path reaches PowerShell, Windows Terminal and cmd only as data, never as text they read as
  code, so a folder named `R&D` or `x’$(calc)’` restores like any other.
