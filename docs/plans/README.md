# Plans

A non-trivial change gets a plan here before any code: a new capability (another platform, another terminal), a change
to a one-way door (`AGENTS.md`), to a command line the plugin builds, to the record's fields or statuses, a change
that touches several hooks at once, a Claude Code API the plugin has not used before. A fix a reviewer can follow
from the PR alone needs none; its PR says `Trivial: <why>`.

- One file per plan: `YYYY-MM-DD-<slug>.md`, dated the day it was started.
- Written with `start-work`, reviewed with `review-plan` until approved, approved by the maintainer, and committed as
  the first commit of its branch. Someone outside the maintainers puts it up as a draft PR for that approval
  (`start-work`).
- A plan records what was decided and why at the time. It changes while its branch is open, when the work departs from
  it, and not after the merge.
- Fill every section. "None" is an answer; a blank is not.

## Template

```markdown
---
title: <a plain imperative sentence, which can become the PR title>
issue: "#<n>"
status: draft
approved_by:
approved_at:
---

# <title>

## Goal

What is true when this is done, and why it matters. In scope; out of scope.

## Design

How it works: the hooks, the logic in `lib.ts`, the record's fields and statuses, the command lines it adds or
changes. The alternatives considered and why this one.

## Compatibility

The one-way doors it touches (`AGENTS.md`), what changes for users (the band, `/restore`, the `shell` option, the
records an older version wrote, the Claude Code versions supported) and how they move over. Or "none".

## Steps

Ordered, each one buildable and testable on its own, each naming the test that proves it.

## Tests

The new and changed tests in `plugin/hooks/*.test.ts` (run in the engine's sandbox), and what only a real session
shows, with how it will be tried by hand.

## Docs

The docs that change with it: `README.md`, `plugin/README.md`, `docs/design.md`, `CHANGELOG.md`, `AGENTS.md`.

## Risks

What could go wrong, and whether each risk is resolved or accepted.

## Plan review

Written by `review-plan`: each round's reviewer, date and verdict, the findings with their status, the owner calls
with their answers, and the improvements with theirs.
```

`issue` is quoted: a bare `#` starts a YAML comment.
