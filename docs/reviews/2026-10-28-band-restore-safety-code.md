---
subject: "Restore only what is still cut off, say what happened, and keep each record's last word (PR #9)"
base: main (2fd16b3)
head: 2c460a2
date: 2026-10-28
round: 1
tier: standard (one fresh reviewer, which mutated the code to see which tests catch each change; findings checked by the main session)
verdict: needs-fixes
---

# Review: Restore only what is still cut off, say what happened, and keep each record's last word (PR #9)

One fresh reviewer read the branch against `REVIEW.md`, every lens, the plan and issues #1 to #4. It ran the gate
(14 checks, the plugin's types checked) and the plugin's tests (33), and on a copy of the plugin removed each change in
turn to see which test fails. The plan's second review round ran in the same pass, and is recorded in the plan.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F1 | minor | `register.test.tsx`, "a close is never overtaken" | The test released the held `open` write before the close was asked for, so it passed with or without the queue; the kit does run writes at once. | fixed: the close is asked for first; the test fails without the queue |
| F2 | minor | `register.tsx` `stillCutOff` | `/restore 1,1`, or a number and its id's prefix, named one session twice, and the reply said one was "no longer cut off" after reopening it. | fixed: the ids as a set; a test |
| F3 | minor | `register.tsx` `restoreFromClick` | Off Windows the toast said the commands were in the transcript whatever Restore did, also when it left the only session alone and listed no command. | fixed: `restore` says whether it gave commands; a test |
| F4 | minor | `plugin/README.md` | The plan named it, but it did not say what a click now writes, or that a session restored elsewhere is left alone. | fixed |
| F5 | minor | `docs/design.md` | "On each heartbeat until it succeeds" contradicted the cap the next sentences give. | fixed |

Mutations: removing `oneAtATime`, the save's check of `ends`, the resume's `sync`, the title's turn check, the scan at
the click or the click's logging each failed a test; removing the queue failed none (F1), nor did removing the check
of `ends` after `root()`, nor lookups at the first five heartbeats instead of the spread.

Refuted: a deadlock between `ctx.acting` and `ctx.writes` (writes never wait on `acting`); a failed write or a failed
restore stalling the queues (both move on); a `sync` reading the status between `ends++` and the close (would need the
engine to answer calls out of order: guarded anyway, improvement 2); the timer for reasons other than `resume`;
`ctx.beats` across a reload (a reload rebuilds the state); unhandled rejections from `restoreFromClick`; the
`titleTurns` reset; `/restore` scanning twice (left in the plan's round 1); ids never offered (only duplicates, F2);
folders and flags in the transcript (the pane and `/restore` show the same, and log lines never reach the model).

Improvements:

1. The resume's `sync` on a timer from `session.end`: the event's 1.5-second bound can abort a `$` call in flight, and
   the switch to the picked session may take longer than a second. Taken: the settings hook event `SessionStart` with
   source `resume`, which fires once the session is in place.
2. Check the status before the save, so the close stays the last word whatever order the engine answers in: taken.
3. Pin the lookups' spread: taken, the test expects minutes 0, 1, 3, 7 and 15.
4. Dismiss and Forget all left a failed write unhandled and silent: taken, `dismissFromClick` logs and toasts it.
5. A rescan that fails at the end of a good restore turned it into "Could not reopen": taken, it is caught.
6. The check of `ends` after `root()` was untested: taken, dropped. An end other than `/clear` or `/resume` now stops
   tracking, since the process is ending, and the save's own check covers `/clear`; a test: after `/exit`, a heartbeat
   writes nothing.
7. `register.test.tsx` in the docs' tables: taken, `docs/design.md` and `AGENTS.md`.

Not covered: the command-lines lens (no function it names changed); a live `/resume` and live clicks on the band,
which need a person at a session.

## Checks

After the fixes: `node tools/gate.ts full`, 14 checks, the plugin's 36 tests, the tools' 72. With the queue removed,
"a close is never overtaken" fails; with the code of `main`, 15 of the plugin's 36 tests fail.
