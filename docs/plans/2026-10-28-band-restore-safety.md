---
title: Restore only what is still cut off, say what happened, and keep each record's last word
issue: "#1, #2, #3, #4"
status: draft
approved_by:
approved_at:
---

# Restore only what is still cut off, say what happened, and keep each record's last word

## Goal

The four findings the first review left open, all in `plugin/hooks/register.tsx`, in one change since they meet in
the same functions:

- **#2:** the band and the pane act on the list as it was last scanned. A second session's band, or a session resumed
  by hand since, reopens a session that runs again: two claude processes on one transcript.
- **#1:** the band's and the pane's buttons drop what `restore()` returns. Off Windows, Restore does nothing visible;
  on Windows, a failed launch or a folder that is gone is silent.
- **#3:** a heartbeat's `sync` that started before `session.end` can save the record `open` after `session.end` closed
  it, and the dead session is then offered.
- **#4:** where the process lookup can't succeed, every session starts a PowerShell each minute for its whole life;
  and a session with no title yet reads up to 4,096 messages on every heartbeat.

When this is done, Restore and Dismiss reopen or drop only sessions that are cut off at the moment of the click, every
click says what it did, a closed record stays closed, and a session's background cost is bounded.

Out of scope: the band refreshing on its own while nothing is clicked (a scan costs a PowerShell when any record is
open; the list is checked when it is acted on, which is what matters), and sessions whose folder is gone, which stay
offered so a folder on a drive that comes back can still be restored; the person can Dismiss them.

## Design

- **#2, scan at the click.** `restore(ids)` and `dismiss(ids)` start with `scan()` and keep only the ids it still lists.
  An id it no longer lists (restored by another session, resumed by hand, closed) is left alone and counted in what
  `restore` says: "1 session was no longer cut off, so it was left alone." `/restore` already scans first; its
  indexes stay those of the list it showed.
- **#1, every click says what it did.** The band's and the pane's Restore buttons log what `restore()` returns to the
  transcript (`$.ui.log`, a dim line the model never sees): the reopened count, a launch's error, each folder that is
  gone, and off Windows the `cd <folder> && claude --resume <id>` lines. A failure also toasts ("Could not reopen the
  sessions: see the transcript"), as success already does; off Windows the toast says the commands are in the
  transcript. Off Windows nothing is marked restored, since nothing was. `/restore` keeps returning the same text as
  its output, so nothing is said twice.
- **#3, a record's last word.** `Ctx` gains `ended: Set<string>`, the ids `session.end` closed in this process.
  `sync` checks it after each await and before it saves, and leaves an ended id alone. Every write of a record goes
  through one queue (`ctx.writes`), in the order the writes were asked for, so a save `sync` asked for first can't
  land after the close.
- **#4, bounded background work.**
  - `beat` tries the process lookup at most `LOOKUP_TRIES` (5) times, the first five minutes, when MCP servers are
    still starting; after that the session counts as gone by its heartbeat alone, as off Windows (`isInterrupted`
    already falls back to `STALE_MS` without a pid). The 14-day prune runs in those lookups as now.
  - `sync` reads the messages for a title only when `$.session.turns()` changed since it last looked
    (`ctx.titleTurns`, reset with each new tracked session).

Alternatives not taken:

| Option | Why not |
|---|---|
| Rescan on every heartbeat, so the band is never stale | A PowerShell per session per minute whenever any record is open |
| Mark a session whose folder is gone as dismissed | A folder on a network or removable drive comes back; Dismiss is one click |
| A lock file around record writes | One process writes its own record; the queue orders this process's writes, and other processes write other records |

## Compatibility

No one-way door moves: `/restore` and its arguments, the `shell` option and the record's fields stay. Records get no
new field (`ended`, `writes`, `titleTurns` and the lookup count live in the process). Users see new transcript lines
after a click, and fewer background PowerShells.

## Steps

1. **#3 and #4** in `register.tsx`: `ended`, the write queue, `LOOKUP_TRIES`, `titleTurns`. Tests in
   `register.test.tsx`: a `sync` held on its messages while `session.end` closes the record ends with the record
   closed; ten minutes with the lookup failing start at most five lookups; heartbeats with no new turn read the
   messages once.
2. **#2 and #1** in `register.tsx`: `restore` and `dismiss` scan first; the buttons log and toast. Tests: the band's
   Restore all after another session restored one of two sessions launches only the other and says one was left
   alone; off Windows the band's Restore all logs the commands and marks nothing; a launch that fails logs its error
   and toasts.
3. **Docs:** `docs/design.md` (the scan at the click, the queue, the lookup's limit), the READMEs where they say what
   Restore does, `CHANGELOG.md` under Unreleased (Fixed).
4. **`review-code`,** then the PR.

## Tests

All in `plugin/hooks/register.test.tsx`, through the engine's test kit: the band mounted with `$.ui.mount` and pressed
by key, the clock mocked, `process.run`, `fs.*` and `ui.log` answered and recorded. The existing `lib.test.ts` and
`tools/launcher.test.ts` stay as they are. By hand, on this machine: a band's Restore all from a second session after
the first restored, with a dummy record; it opens nothing when nothing is left.

## Docs

`docs/design.md`, `README.md` (Use: what the band says), `plugin/README.md`, `CHANGELOG.md`.

## Risks

| # | Risk | Status |
|---|---|---|
| R1 | The extra scan at a click costs a PowerShell when an open record exists | Accepted: one per click |
| R2 | A session resumed by hand writes its record only at its first `sync`; a click in the second before that still reopens it | Accepted: the window is the resumed session's start, and the same click before this change reopened it at any time |
| R3 | A test kit difference between Claude Code versions in how the band is mounted | The tests run on the pinned 2.1.306 in CI, and the types are checked locally |

## Plan review

Written by `review-plan`.
