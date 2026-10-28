# Review

What every review of a change to this repo checks, whoever does it: the maintainer, an AI agent (`review-plan`,
`review-code`) or another tool. Same rules for all.

## What a finding is

Not a bug hunt. A finding is a real problem with a scenario you can reproduce: the input or state, what happens, and
why it matters to a user, their sessions or the next change.

- No scenario, no finding. Style is Biome's; taste is the author's, at most an improvement (below).
- Refute each finding before you report it: quote the line that proves or kills it. A refuted one stays in the
  record, with its reason.

| Severity | What it is |
|---|---|
| blocker | a command line a folder name, a flag or a record can break out of; a session restored, closed or a terminal opened without the person's click; a secret or a session's prompt sent anywhere; a one-way door broken; a check loosened |
| major | a real user hits it in normal use: a cut-off session not offered, a live one offered, a restore that opens the wrong folder or loses its flags, a Claude session that fails to start with the plugin on, new behaviour without a test |
| minor | everything else that is real: an edge case few meet, a missing doc line, a clumsy message |

- Most findings are minor. An edge case that needs several unlikely things at once is a minor at most.
- Another round only after a blocker or a major. Minors are fixed in the same round, or recorded with a reason, and
  the review ends.

## Improvements

Apart from findings, a review lists only the improvements worth more than the edit they cost: a reuse it missed, a
simpler approach, a clearer name, a step a person must remember that a check could do.

- Not improvements: rewording or reshuffling for taste, options for cases nobody hits, "while you're here" extras.
- No severity, no scenario. Never counted, never a reason for another round.
- The author answers each: `taken`, `left: <why>` or `later: <issue>`. "left: not worth it" is a normal answer.

## The questions

Each is a yes or no; a "no" is a finding.

1. Did `node tools/gate.ts full` pass on the reviewed commit, with the plugin's types checked, and CI on the PR's head?
2. Does the change do what its issue and plan say, and nothing nobody asked for?
3. Does new behaviour have a test that fails without it, and a fix a test that reproduced the bug? Do tests use
   invented records, folders and ids?
4. For a change a test can't reach (a restore, the band, the pane, a real process lookup): does the PR say how it was
   tried by hand, on which Windows and Claude Code version, and what it could not show?
5. Does a record's text (a folder, a flag, a title, the claude path) reach PowerShell only as base64, Windows Terminal
   and `Start-Process` only through `crtQuote`, and cmd never (`docs/design.md`)?
6. Does the plugin still do nothing unasked: no restore, no terminal, no record dismissed without the person's click
   or command? Does a session's record stay on this machine?
7. Can a newer version read every record an older one wrote, and an older one ignore what a newer one adds?
8. Does it work on the Claude Code versions the README names, and do non-Windows systems still get the commands to run
   instead of an error?
9. Does it leave the one-way doors in `AGENTS.md` alone, or name the one it changes and link the maintainer's
   agreement?
10. Did the docs move with it (`README.md`, `plugin/README.md`, `docs/design.md`, `CHANGELOG.md`, `AGENTS.md`),
    written the way `AGENTS.md` asks?
11. Is each new package needed, under a licence compatible with MIT, pinned exactly in `package-lock.json`, and free of
    known advisories? The plugin itself takes none: it runs in Claude Code's sandbox.
12. Is the PR title a plain imperative sentence, does the body say `Closes #<n>` or `Refs #<n>`, and is there no tool
    attribution anywhere?

## The harness

These decide how every other change is checked:

- `AGENTS.md`, `REVIEW.md`, `.claude/` (`CLAUDE.md`, the settings, the skills), `.agents/`, `.mcp.json`;
- `tools/`, `.githooks/`, `.gitleaks.toml`, `.github/`;
- `biome.jsonc`, `tsconfig.json`, `plugin/tsconfig.json`, `.npmrc`, the pins in `package.json`.

Rules:

- A change that loosens a check is a blocker unless the maintainer agrees in the PR.
- That includes a gate step dropped or made a warning, a lint rule or a test skipped, an ignore added, a question or a
  lens removed, attribution let through, a permission widened, install scripts turned on.
- A change that only makes a check stricter needs no more than a normal review.
- The `Read` denies in `.claude/settings.json` don't cover Bash: an allowed command that can print any file (a
  `git diff --no-index`, `git blame --contents`) gets around them. Keep Bash allows to narrow forms.
