# Changelog

What each release changes for the people who install the plugin, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. A change users notice adds its line under Unreleased
in the same PR; `docs/releasing.md` says how a release dates it.

## Unreleased

### Fixed

- The band's and the pane's Restore and Dismiss act on the sessions cut off at the moment of the click: one another
  session restored, or that you resumed by hand, is left alone and counted, never opened a second time (#2).
- What the band's and the pane's Restore did is in the transcript: the sessions reopened, a launch's error, a folder
  that is gone, and on macOS and Linux the commands to run; a toast says which (#1).
- A session you leave stays closed: a heartbeat that started just before `/exit` or `/clear` no longer saves it open
  again, which offered it for restore once its process ended (#3).
- Two clicks on Restore within a launch's seconds open each session once, and a session picked with `/resume` inside
  another is tracked within a second, before another band could reopen it.
- Less work in the background: on Windows the claude process is looked for at most 5 times, over a session's first
  15 minutes, and the messages are read for a title only after a new turn (#4).

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
