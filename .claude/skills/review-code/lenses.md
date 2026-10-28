# Code review lenses

`review-code` applies every lens below, to a change or to a path. `REVIEW.md` holds the severities, the questions and
the harness rule; the lenses say where to look. A lens whose "Applies when" names nothing in the scope returns no
findings at once, and an empty list is a good result.

**Not a bug hunt.** Report a problem only when it is real: it can be reproduced and causes an actual failure for a
user, their sessions or the next change.

- It has: a title; a severity (blocker, major, minor; most are minor); the file and the function or line.
- **The scenario:** the input or state, what happens, why it matters. No scenario, no finding.
- What it is judged against: a rule in `AGENTS.md` or `REVIEW.md`, the plan, the hooks API's types, a tool's
  documented behaviour, or "none".
- The evidence, and the fix. Style is Biome's, taste is the author's.

**Improvements too,** under any lens: a reuse it missed, a simpler approach, a clearer name, a step someone must
remember that a check could do. What, where, why it's better; no severity, never counted.

## plan-and-intent

Applies when: the change has a plan in `docs/plans/` or an issue.

Does it do what the plan and the issue say? A planned step missing, or behaviour nobody asked for that a user will
meet, is a finding; a small departure the PR explains is not.

## implementation

Real bugs a user would hit; the lenses below are where this plugin breaks most, and this one catches the rest.

- Wrong logic; an edge case real input reaches (a folder with spaces, quotes, `;`, `&` or non-ASCII; a drive root; a
  record half written by another session; many sessions at once; a session that ran for days).
- A promise left unawaited whose failure vanishes, or an error caught and dropped where the person needed to know.
- A timer or a process that outlives what started it; a `$.process.run` without a timeout.

## command-lines

Applies when: the scope touches `psString`, `runArgvScript`, `tabArgv`, `crtQuote`, `wtLines`, `consoleStarts`,
`launchScript`, `manualCommand`, `runPowerShell`, or anything that turns a record into text a process reads.

Name the input and what it runs. Each part (the folder, each flag, the claude path, the id, a title) passes through
every reader on its way: PowerShell's parser (which takes curly quotes for quotes), `wt`'s own `;` split, `cmd`'s
`&`, `|`, `^`, `%` and quotes, the C runtime's argument split. The rule (`docs/design.md`): record text reaches
PowerShell only as base64, Windows Terminal and `Start-Process` only through `crtQuote`, cmd never. Text that ends
one argument and starts a command is a blocker; text that only garbles the tab is a major. Does
`tools/launcher.test.ts` cover the new path?

## session-safety

- Does anything restore, dismiss, open a terminal or end a session without the person's click or command?
- Does a session's record (its folder, its first prompt, its flags) leave this machine, reach a log another tool reads,
  or land in a file other users can read?
- Is a flag repeated on resume that the person would not expect to come back (a permission mode, a prompt)?

## records

Applies when: the scope touches `SessionRecord`, `save`, `scan`, `isInterrupted`, `statusForEnd`, or the record folder.

- Can this version read every record an older one wrote, and does an older one survive what this one adds? A renamed
  or retyped field is a one-way door broken.
- A live session offered for restore, or a cut-off one never offered: walk the statuses in `docs/design.md`.
- Two sessions writing at once, a record mid-write, a clock change, a pid reused.

## hooks-api

Applies when: the scope touches `register.tsx` or calls `$`.

- Checked against the types the engine wrote (`plugin/.claude-plugin/types/claude-code/index.d.ts`), not memory.
- Does each hook call `next(e)` where the engine's own behaviour must still run, and return its result?
- Work started in `session.start` that blocks the session's start, or a hook that throws where a `.catch` should
  answer.
- A `$.state` value used without its entry in `types/index.d.ts`.

## tests

- Would each new test fail without the change? Is a fix pinned by a test that reproduced the bug?
- Do tests use invented folders, ids and prompts, and run in the engine's sandbox without a real terminal?
- For what no test reaches: does the PR say how it was tried by hand, on which Windows and Claude Code version?

A missing test for new behaviour is major; a missing edge-case test is minor.

## docs-freshness

- Did the docs that describe the scope move with it: `README.md`, `plugin/README.md`, `docs/design.md`,
  `CHANGELOG.md` when users notice, `AGENTS.md` for a changed path, command or rule?
- Does anything cite a path, a command, a flag or an option that no longer exists?
- A comment or doc outside `docs/plans/` and `docs/reviews/` that cites a plan or review id instead of the reason?

## simplicity

A second implementation of one thing, a layer with one caller, an option nobody asked for, dead code: an improvement,
written as what it drops ("X could become Y, which drops Z"). A finding only when it causes a real failure, with its
scenario (the two copies already disagree).

## compatibility

- Windows 10 and 11, with and without Windows Terminal; PowerShell 5.1 and 7; every `shell` option.
- macOS and Linux: no error, and `/restore` prints commands that work in their shells.
- The Claude Code versions the README names: an API only newer releases have needs the README's floor to move.

## harness-integrity

Applies when: the scope touches a harness file (`REVIEW.md`, The harness).

Anything that loosens a check: a gate step dropped or made a warning, a lint rule or a test skipped, an ignore added,
a question or a lens removed, attribution let through, a permission widened, install scripts turned on. A blocker
unless the maintainer agrees in the PR.

## Refuting

- Every finding gets a refutation attempt before it is reported.
- Rule it not real when:
  - its scenario can't happen (read further: it is often handled elsewhere);
  - it causes no actual failure;
  - it is taste;
  - it rests on a misread of the code, the API or the tool.
- Settle it with evidence: quote the line that proves or kills it. On your own branch a refuter may reproduce it with
  a test or a short script, never by restoring or killing the person's own sessions.
- Someone else's PR is never run here.
- A refutation you couldn't check leaves it real. A refuted one stays in the record, with its reason.
