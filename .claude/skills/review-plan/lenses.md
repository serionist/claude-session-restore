# Plan review lenses

`review-plan` applies every lens below. `REVIEW.md` holds the severities, the questions and the harness rule; the
lenses say where to look in a plan. A lens that names nothing in the plan returns no findings at once, and an empty
list is a good result.

**Not a hunt.** A finding on a plan is a defect that would really hurt if the plan were followed as written: a step
that can't be built, a command line a folder name breaks out of, a one-way door changed silently, a test that can't
prove what it claims.

- It has: a title; a severity (blocker, major, minor; most are minor); the plan section.
- **The scenario:** what goes wrong when the plan is followed as written. No scenario, no finding.
- What it is judged against: a rule in `AGENTS.md` or `REVIEW.md`, the code, the hooks API's types, a tool's
  documented behaviour.
- The evidence (quote the plan), and the proposed plan edit.

**Improvements too,** under any lens: what would make the plan, or the code it leads to, simpler, safer or cheaper
to change. No severity, never counted. Mechanical over manual: a step someone must remember, which a check could do.

## plan-and-intent

- Does the plan do what its issue asks, and nothing nobody asked for?
- Does it contradict a rule in `AGENTS.md` or `REVIEW.md`, or change a one-way door without naming it under
  Compatibility? Named openly, it is a choice for the maintainer; silent, it is a blocker.

## omissions

Read `REVIEW.md`, `docs/design.md` and the code the plan changes, and list what they require that the plan leaves out
and that would really bite: a status a new path forgets, the non-Windows commands, a doc (`README.md`,
`docs/design.md`), a CHANGELOG line users need, how records an older version wrote are read.

## command-lines

Applies when: the plan builds or changes a command line, a shell, a launcher or a new way to open a terminal.

Name the input and what it runs. Does each part (a folder, a flag, the claude path) stay one argument through every
reader: PowerShell, `wt`, `cmd`, a POSIX shell? Does the design fail closed (refuse a record it can't quote) rather
than run it?

## session-safety

Does anything the plan adds act without the person's click or command, send a record off the machine, or repeat a
flag on resume that the person would not expect back?

## records

Applies when: the plan adds, removes or changes a record's field, a status, or where records live.

Can the new version read the old records, and the old version survive the new ones? A renamed or retyped field is a
one-way door.

## sequencing-and-tests

- Can each step be built, tested and committed on its own, in that order?
- Does each step name the test that proves it, one that fails without the change?
- Can it run in the engine's sandbox (`claude plugin test`)? What only a real session can show: does the plan say how
  it will be tried by hand, and what that still cannot show?

## simplicity

A seam with no caller, an option nobody asked for, a second way of doing one thing, scope beyond the issue: an
improvement, written as what it drops and who would notice. A finding only when following the plan as written causes
a real failure.

## compatibility

Does it work on Windows with and without Windows Terminal, on every `shell` option, on macOS and Linux (the printed
commands), and on the Claude Code versions the README names? An API taken from the newest types without checking the
floor is the usual way this breaks.

## harness-integrity

Applies when: the plan touches a harness file (`REVIEW.md`, The harness).

Does it loosen a check, a hook, the gate or the agent setup? A blocker unless the plan says so and the maintainer
agrees.

## premortem

Assume the plan shipped and a user's sessions were lost, or a terminal opened that they did not ask for: what was the
likeliest cause, and what plan edit prevents it? Report it only when the plan's text makes the cause plausible.

## Refuting

- Every finding gets a refutation attempt before it is reported.
- Rule it not real when:
  - the plan covers it elsewhere (read the whole plan: this is the usual false positive);
  - it is deferred openly, under Later or Out of scope;
  - it is taste;
  - it rests on a misread rule or code.
- Quote the plan and the rule or code; a refutation without quoted text leaves it real.
- A refuted one stays in the record, with its reason; if the edit would still make the plan simpler, list it as an
  improvement too.
