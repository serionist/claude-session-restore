---
title: Restore only what is still cut off, say what happened, and keep each record's last word
issue: "#1, #2, #3, #4"
status: approved
approved_by: serionist
approved_at: 2026-10-28
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
offered so a folder on a drive that comes back can still be restored; the person can Dismiss them. Also out: a
session resumed where the plugin doesn't track it (VS Code, the desktop app) keeps its `interrupted` record, so a
click's scan still lists it.

## Design

- **#2, scan at the click.** `restore(ids)` and `dismiss(ids)` start with `scan()` and keep only the ids it still lists.
  An id it no longer lists (restored by another session, resumed by hand, closed) is left alone and counted in what
  `restore` says: "1 session was no longer cut off, so it was left alone." `/restore` already scans first; its
  indexes stay those of the list it showed. Restores and dismisses in one process run one at a time (`ctx.acting`),
  so a second click while a launch runs scans after the first marked its sessions `restored` (P4). A `/resume`
  inside a session starts no `session.start`: the settings hook event `SessionStart` with source `resume`
  (`classic.SessionStart`) fires once the picked session is in place, and starts a `sync`, so its record is `open`
  before another band can reopen it (P3; code review round 1 moved it there from a timer on `session.end`). Any
  other end (`/exit`, a signal, logout) ends the process: tracking stops there, so a heartbeat before the exit writes
  nothing.
- **#1, every click says what it did.** The band's and the pane's Restore buttons log what `restore()` returns to the
  transcript (`$.ui.log`, a dim line the model never sees; one call per line, since the terminal draws a line's first
  2,000 characters, P2): "Reopened N sessions", whatever opened them, a launch's error, each folder that is gone,
  and off Windows the `cd <folder> && claude --resume <id>` lines. A failure also toasts ("Could not reopen the
  sessions: see the transcript"), as success already does; off Windows the toast says the commands are in the
  transcript. Off Windows nothing is marked restored, since nothing was. `/restore` keeps returning the same text as
  its output, so nothing is said twice. The launch and the `restored` marks fail apart: a mark that can't be saved
  after a good launch says so, rather than "Could not open a terminal", which would invite a second click.
- **#3, a record's last word.** `Ctx` gains `ends`, how many sessions ended in this process. `sync` notes it when it
  starts and saves nothing if it moved while it waited: what it would save is from before the end. A count, not a
  set of ended ids, which would freeze a session `/clear` left and `/resume` brought back in the same process (P1).
  Every write of a record goes through one queue (`ctx.writes`), in the order asked; each write runs once the one
  before it settled, failed or not, and its caller sees its own failure (P5).
- **#4, bounded background work.**
  - `beat` tries the process lookup at most `LOOKUP_TRIES` (5) times, spread over heartbeats 0, 1, 3, 7 and 15, so a
    slow start (many sessions opening at once after a restore) is still covered; after that the session counts as
    gone by its heartbeat alone, as off Windows (`isInterrupted` already falls back to `STALE_MS` without a pid). The
    14-day prune runs in those lookups as now.
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
new field (`ends`, `writes`, `acting`, `titleTurns` and the lookup counts live in the process). Users see new transcript lines
after a click, and fewer background PowerShells.

## Steps

1. **#3 and #4** in `register.tsx`: `ends`, the write queue, the resume's `sync`, `LOOKUP_TRIES`, `titleTurns`.
   Tests in `register.test.tsx`: a `sync` held on its messages while `session.end` closes the record ends with the
   record closed; a close while the first save is still written lands last; `/clear`, back to the first session by
   `/resume`, then a signal leaves it `interrupted` (P1); after a `/resume` the picked session's record is `open`
   once `SessionStart` says it is in place (P3); after `/exit` a heartbeat writes nothing; thirty minutes with the
   lookup failing start five lookups, at minutes 0, 1, 3, 7 and 15; a session whose only prompt is a
   slash command reads the messages once until a new turn.
2. **#2 and #1** in `register.tsx`: `restore` and `dismiss` scan first and run one at a time; the buttons log and
   toast. Tests: the band's Restore all after another session restored one of two sessions launches only the other
   and says one was left alone; the same when the person resumed one by hand (its record `open`, its process alive);
   the band's Dismiss leaves a session restored elsewhere alone; two `/restore all` at once launch once; off Windows
   the band's Restore all logs the commands, a line each, and marks nothing; a launch that fails logs its error and
   toasts.
3. **Docs:** `docs/design.md` (the scan at the click, one at a time, the count and the queue, the resume's sync, the
   lookup's spread), the READMEs where they say what Restore does, `AGENTS.md`'s Traps row for `beat` (P7),
   `CHANGELOG.md` under Unreleased (Fixed).
4. **`review-code`,** then the PR.

## Tests

All in `plugin/hooks/register.test.tsx`, through the engine's test kit: the band mounted with `$.ui.mount` and pressed
by key, the clock mocked, `process.run`, `fs.*` and `ui.log` answered and recorded. The existing `lib.test.ts` and
`tools/launcher.test.ts` stay as they are. By hand, on this machine, with a dummy record: a band's Restore all from a
second session after the first restored opens nothing and says so in the transcript. Not tried by hand: the band on
macOS and Linux, which the kit's tests cover.

## Docs

`docs/design.md`, `README.md` (Use: what the band says), `plugin/README.md`, `AGENTS.md` (Traps), `CHANGELOG.md`.

## Risks

| # | Risk | Status |
|---|---|---|
| R1 | The extra scan at a click costs a PowerShell when an open record exists | Accepted: one per click |
| R2 | A session resumed by hand writes its record only at its first `sync`; a click in that moment still reopens it | Accepted: `claude --resume` syncs at its start, and an in-session `/resume` at its `SessionStart` (P3); before this change the same click reopened it at any time |
| R3 | A test kit difference between Claude Code versions in how the band is mounted | The tests run on the pinned Claude Code in CI, and the types are checked locally |
| R4 | No test failed without the write queue | Resolved (P8): the kit runs writes at once; the test released the held write too early, and now asks for the close first |

## Plan review

### Round 1

- **How:** one fresh reviewer with the review-plan method and lenses, on 2026-10-28, against `16ab319`.
- **Verdict:** needs-fixes, with 1 major and 6 minors; no owner calls.
- **Now:** all applied.

| # | Sev | Finding | Status |
|---|---|---|---|
| P1 | major | `ended` never forgets an id: after `/clear` (or `/resume` away) and `/resume` back to the same id in the process, every `sync` leaves it alone; its record stays `closed`, and a crash after is never offered | fixed: a count of ends, not a set of ids; a test for the round trip |
| P2 | minor | Off Windows, many sessions' commands in one `$.ui.log` line are cut at 2,000 characters | fixed: one line per call |
| P3 | minor | An in-session `/resume` writes the picked session's record only at the next heartbeat, so for up to a minute another band reopens it | fixed: a `sync` a second after `session.end` with reason `resume`, then (code review round 1) at `SessionStart` with source `resume`; a test |
| P4 | minor | Two clicks in one session within a launch's seconds open each session twice | fixed: restores and dismisses run one at a time; a test |
| P5 | minor | The plan said nothing of a failed write; a plain chain would skip every later write | fixed: each write runs once the one before settled; its caller sees its own failure |
| P6 | minor | The title test passed on the old code; nothing failed without the queue; Dismiss and the resumed-by-hand case went untested; the by-hand line covered #2 only | fixed: a slash-command session for the title, Dismiss and resumed-by-hand tests, the by-hand line extended; the queue: no kit test can fail without it (R4) |
| P7 | minor | `AGENTS.md`'s Traps row for `beat` and the resume-back sentence in `docs/design.md` would go stale | fixed: both in Docs |

Refuted: off Windows nothing marked and the band staying; `$.ui.log` outside the terminal; a module reload resetting
the state; `LOOKUP_TRIES` and other sessions' liveness; sessions that never get a pid; `titleTurns` with `/clear`; a
double restore across two windows within seconds; the kit settling unawaited work; flags leaving the machine; a
fresh `claude --resume` of an `interrupted` session.

Improvements:

- `/restore all` scans twice: left, the second scan is what makes a click and a command safe alike.
- Space the lookups out: taken, heartbeats 0, 1, 3, 7 and 15.
- R3 named a version the pin did not hold: taken.
- "in Windows Terminal" when consoles opened: taken, "Reopened N sessions".
- The `restored` saves inside the launch's try: taken, apart.
- Sessions resumed where they are not tracked: taken, under Out of scope.

### Round 2

- **How:** one fresh reviewer, on 2026-10-28, against `29efca7`, reading the edits and round 1's findings, in the same
  pass as the code's first review, mutating the code to see which tests catch each fix.
- **Verdict:** approved; one new minor.
- **Now:** applied.

P1, P3, P4, P5 and P7 confirmed, each by a test that fails without it; P6 confirmed but for the queue (P8).

| # | Sev | Finding | Status |
|---|---|---|---|
| P8 | minor | R4 was wrong: the kit runs writes at once; the queue's test released the held write before the close was asked for | fixed: the test asks for the close first, and fails without the queue |

**Approved** by the maintainer's "do all" for #1 to #4, 2026-10-28.
