---
name: review-plan
description: >-
  Use when a plan in docs/plans/ is drafted and needs checking before any code ("review the plan", "is this plan
  ready", start-work's review step). A fresh reviewer applies REVIEW.md and lenses.md, refutes each finding and
  reports only real defects with their scenario, plus improvements; the round is written into the plan's Plan review
  section; another round only after a blocker or a major.
---

# Review a plan

A plan review catches a design defect while it is still a one-line edit. Not a hunt: a finding is a defect that would
really hurt if the plan were followed as written (`REVIEW.md`, What a finding is), and most are minor.

## Steps

1. **The plan, by path:** `docs/plans/<date>-<slug>.md`, never "the latest plan". Commit it first, so the round names
   a fixed version: `git log -1 --format=%h -- <plan>`.
2. **The ground truth** the reviewer reads: `AGENTS.md`, `REVIEW.md`, `docs/design.md`, the plan in full, its issue
   (`gh issue view <n> --comments`), and every file and doc the plan names.
3. **Review.** Start one fresh agent, one that has not seen this session, with the plan's path, the ground-truth list
   and `lenses.md` (this folder). It reads and nothing else. It applies every lens, refutes each finding by quoting
   the plan and the rule or code, and returns the confirmed and refuted findings, each with its scenario and an honest
   severity, the improvements worth making, and a verdict. Don't read the ground truth into this session yourself.
   - Each confirmed blocker or major goes to its own fresh refuter agent, in parallel. One that can't settle it
     leaves the finding open, never refuted.
   - No agents in your tool: apply every lens yourself, then refute each finding, and say in the record that the
     author reviewed their own plan.
4. **Write the round** into the plan's "Plan review" section as `### Round <n>`:
   - **How:** the reviewer, the model, the date; **Verdict:**; **Now:** what has been applied.
   - A table `| # | Sev | Finding | Status |`: ids `P1`, `P2`, ... numbered on across rounds, the finding with its
     scenario, status `open`, `fixed` (what changed), or `wontfix: <why>`.
   - Refuted findings under "Refuted", each with its reason.
   - Owner calls, when there are any: `| # | Question | Recommendation | Answer |`, ids `Q1`, `Q2`, ...
   - Improvements, each with its answer: `taken`, `left: <why>` or `later: <issue>`.
5. **Act.** Edit the plan for each confirmed finding that keeps its design and scope, and mark it `fixed`. One that
   changes either goes to the maintainer as a yes or no question with your recommendation, as an owner call. List the
   improvements to the developer and ask take, leave or later for each.
6. **Another round only after a blocker or a major.** Commit the edits and go back to step 3: a fresh reviewer reads
   the edits and the open findings only. Only minors: fix or record them, and the loop ends.
7. **Verdict:** `approved` when no blocker or major is open, every owner call has its answer, and the plan names its
   tests and docs and ends with `review-code`. Otherwise `needs-fixes` or `needs-answers`. Commit the plan.

## Done means

- The plan's "Plan review" section says `approved`, or the maintainer stopped the loop with the open findings
  recorded.
- Every owner call and every improvement has its answer.

## Never

- Report a finding without its scenario, or inflate a minor to keep the loop going.
- Change the plan's design or scope without the maintainer's yes.
- Approve a plan with an open blocker on a command line, a one-way door or the harness.
- Drop a finding silently: refuted and `wontfix` ones stay in the plan.
