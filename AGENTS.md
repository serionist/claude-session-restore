# claude-session-restore

The rules for anyone who changes this repo, person or agent. Claude Code reads this file through `.claude/CLAUDE.md`,
Codex reads it directly; the gate caps it at 150 lines. What the plugin does for those who use it is in `README.md`.

## What this is

`session-restore`, a Claude Code plugin (a mod: a hooks module, no MCP server, no skills) that reopens the sessions a
crash, a restart or a closed terminal cut off. The repo is its own marketplace.

- **The plugin** (`plugin/`): `hooks/register.tsx` hooks the session's life and draws the band and the pane;
  `hooks/lib.ts` holds the pure logic (which sessions count as cut off, the launch flags, the command lines);
  `types/index.d.ts` declares the record and the plugin's state.
- **It runs inside Claude Code,** in an environment with no DOM and no Node: everything outside reaches it through `$`
  (`$.fs`, `$.process`, `$.session`, `$.ui`). The API is early access and changes between Claude Code releases.
- **Windows first:** finding the claude process and reopening sessions in Windows Terminal are Windows-only; elsewhere
  `/restore` prints the commands to run. `docs/design.md` says how each part works.

## Where things are

| Path | What |
|---|---|
| `plugin/` | the plugin: `.claude-plugin/plugin.json` (name, version, the `shell` option), `hooks/` (`hooks.json`, `register.tsx`, `lib.ts`, and their tests `register.test.tsx`, `lib.test.ts`), `types/index.d.ts`, `tsconfig.json`, `README.md` |
| `.claude-plugin/marketplace.json` | the marketplace: one plugin, source `./plugin` |
| `docs/` | `design.md` (how it works), `releasing.md`, `testing-by-hand.md` (a real window, on each system); `plans/`, `reviews/`: dated records, never current truth |
| `tools/` | `gate.ts` (the gate), `hooks.ts` (behind `.githooks/`), `setup.ts` (once per clone; `link` for skills), `gate.test.ts`, `launcher.test.ts` (the restore scripts run for real: PowerShell on Windows, `sh` on macOS and Linux), `try-restore.sh` (the by-hand test's setup and check); Node's standard library only |
| `.githooks/` | `commit-msg` refuses attribution, `pre-push` runs gate quick on what the push sends, `post-checkout` and `post-merge` name changed AI setup files |
| `.claude/` | `CLAUDE.md` (imports this file), `settings.json` (no attribution; allows read-only git and gh, plus the repo's own checks), `skills/` (below) |
| `.agents/skills/` | links to `.claude/skills/<name>` for Codex, written into git's index by `node tools/setup.ts link` |
| `.github/` | CI, CodeQL, the PR text check, the release, Dependabot, issue forms, the PR template, CODEOWNERS |
| `AGENTS.md`, `REVIEW.md` | this file; what a review finding is, and the questions every review answers |
| `.mcp.json` | Context7 over HTTP; `.claude/settings.local.json.example` turns it on |
| `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc` | the dev tools, pinned exactly (Claude Code, Biome, TypeScript); no install scripts; Node 24 |
| `biome.jsonc`, `tsconfig.json` | lint and format for everything; the tools' types (the plugin's are `plugin/tsconfig.json`) |
| `.gitleaks.toml` | the secret scan: gitleaks' own rules, and any exception with its reason |
| `.editorconfig`, `.gitattributes`, `.gitignore` | UTF-8 and LF everywhere; what git ignores |
| `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` | for users; what changed, under Unreleased; a first contribution's short path; how to report a vulnerability; MIT |

A new top-level file or folder adds its row in the same change.

## Build and test

You need Node 24, git, and gitleaks for the secret scan. Claude Code itself comes pinned from `npm ci`.

| What | Command |
|---|---|
| once per clone | `npm ci`, then `node tools/setup.ts` (hooks, skill links) |
| the plugin's tests | `npm run claude -- plugin test plugin` (the pinned Claude Code) |
| the gate | `node tools/gate.ts quick` (pins, Biome, types, the plugin validated, version, AGENTS.md, skills, hooks, attribution, secrets); `full` adds the plugin's tests and the tools' tests |
| format | `npx biome check --write .`, then review the diff |
| run it | `claude --plugin-dir plugin`: the mod from this clone, reloaded on each save (README, Developing) |

- **The plugin's types** come from Claude Code: it writes them to `plugin/.claude-plugin/types/` when a session loads
  the mod. No command writes them, so CI can't check them: gate quick checks them where they are, and skips with the
  reason where they are not. Load the mod once before a PR that changes `plugin/`.
- **Tests run in the engine's sandbox:** `$.fs`, `$.process` and the clock are mocks, so no test starts a terminal or
  a PowerShell. What only a real session shows (a restore, the band) is checked by hand, and the PR says how.

## How a change lands

1. **An issue** for anything beyond a typo.
2. **A plan** in `docs/plans/` for non-trivial work (`docs/plans/README.md` says when), reviewed with `review-plan`
   until approved, then approved by the maintainer.
3. **A branch** `<issue>-<slug>` from `origin/main`, the plan its first commit.
4. **The code,** with its tests and docs in the same change.
5. **finish-work:** `node tools/gate.ts full`, `review-code` until clean, a PR.
6. **The maintainer,** @serionist, squash-merges; merging is the approval. `main` takes PRs only.

The skills in `.claude/skills/` run this loop: `start-work` (1 to 3), `review-plan`, `review-code`, `finish-work`
(5), and `write-skill` for writing or fixing a skill.

## Writing

- A lead line, then a table or short bullets. Conclusion first; name the file, the command, the number.
- Plain words. No "ensure", "robust", "comprehensive", "leverage" or "seamless"; spaced hyphens, never em dashes;
  British spelling (behaviour, licence).
- A comment says why, not what the next line does, and says it in its own words, not only as a plan or review id.
- Docs move in the same change: `README.md` and `plugin/README.md` for what users see, `docs/design.md` for how it
  works, `CHANGELOG.md` when users notice, this file for a changed path, command or rule.

## Commits and PRs

- A plain imperative subject that says what changed; a body that says why, ending `Refs #<n>` or `Closes #<n>`.
- PRs are squash-merged: the PR title becomes the subject on `main`, its description the body.
- No tool attribution anywhere: no AI co-author trailers, no "Generated with" lines, no session links, in commits,
  PR titles or PR bodies. `commit-msg` refuses them, the gate checks every message, and CI checks the PR's text.
- **Versions:** users get a change only when `plugin.json`'s version moves. A release PR sets it and dates the
  CHANGELOG section (`docs/releasing.md`); no other PR touches it.

## One-way doors

Users depend on these. Change one only in a PR that names it in its title, after the maintainer agrees in its issue;
in `0.x` a minor may break one, under CHANGELOG's Breaking.

- the plugin's and the marketplace's name, `session-restore`;
- the `/restore` command and its arguments (`all`, numbers, an id prefix, `forget`);
- the `shell` and `terminal` options, their names and their values;
- the record folder, `<config>/session-restore/sessions/`, and the record's fields: a new version reads the records an
  older one wrote, so a field is added, never renamed or retyped.

## Traps

What this code already paid for; `docs/design.md` has the detail.

| What broke | Where | The guard |
|---|---|---|
| Windows reuses pids, so a new process kept a dead session looking alive | `isInterrupted` | The pid and its start time must both match |
| Windows Terminal gives new tabs the caller's environment; a claude that sees `CLAUDE_CODE_*` runs as a child session, which keeps no transcript to resume | `launchScript` | `SESSION_ENV` is cleared first |
| `wt` splits its own arguments on `;` | `wtLines` | `\;` keeps one |
| PowerShell takes U+2018 to U+201B for quotes, so doubling `'` let a folder named `x’$(calc)’` run code | `psString` | Record text reaches PowerShell only as base64 |
| cmd reads `&`, `%` and `^` in a folder or a flag | `tabArgv`, `launchScript` | No record text reaches cmd; console windows start through `Start-Process` |
| `Start-Process` reads a working directory as a wildcard, so `[old] api` matched nothing | `launchScript` | `WildcardPattern.Escape` |
| A bare `claude` in PowerShell is npm's `claude.ps1`, which a Restricted policy refuses | `runArgvScript` | The program on PATH (`-CommandType Application`), with no flags |
| Windows PowerShell writes to a pipe in the console's code page, garbling `C:\Users\Sóma` | `runPowerShell` | UTF-8 output first |
| A shell `cd` in a tool moved `cwd()`, and the restore opened a folder `--resume` can't find the session from | `sync` | The record keeps `root()` |
| The process lookup failed at startup, while MCP servers spawn | `beat` | Tried again at heartbeats 1, 3, 7 and 15, then no more |
| The band acted on the list as last scanned, and reopened a session already restored or resumed | `stillCutOff` | Restore and Dismiss scan again, one at a time |
| tmux reads `new-window -c <folder>` as a format, where `#(...)` runs a command | `terminalArgv` | No terminal gets the folder; the script `cd`s |
| Most Linux terminals run until their window closes, Ubuntu's `x-terminal-emulator` on purpose, and a call past 30 s is killed with the window | `detached` | Started apart with `setsid -f` |
| Linux derives `ps`'s start time from the wall clock, which a laptop's wake can step | `PROCESSES`, `LOOKUP` | The boot id and the start tick, from /proc |
| A heartbeat's save landed after `/exit` closed the record, and the dead session was offered | `sync`, `save` | A count of ends; one write queue |
| A session with no prompt has no transcript, and `--resume` finds nothing | `sync` | Tracked from its first turn |

## Look up APIs before coding against them

The hooks API: `plugin/.claude-plugin/types/claude-code/index.d.ts`, written by the Claude Code that loaded the mod;
grep it for the event or noun (`'session.end'`, `Pane: {`). `npm run claude -- plugin validate plugin` lists what the
module hooks and calls, and what the engine would refuse. Anything else (Windows Terminal, PowerShell, Node):
Context7 (`.mcp.json`) or the vendor's docs, never memory.

## Never

- Push to `main`, or merge with a failing gate.
- Weaken a test, a check, a hook or CI to make a change pass: no skip, no new ignore, no `--no-verify`.
- Check out, build or run code from outside the maintainers (a contributor's PR or branch) on your machine: read it,
  and let CI run it. A hooks module runs in every Claude session, with every credential there.
- Put a record's text (a folder, a flag, a path) into a script or a command line a shell parses: it travels as data
  (`psString`, `crtQuote`; `docs/design.md`).
- Add tool attribution: commits, PR titles, PR bodies.
- Commit secrets, or a real person's session record: tests use invented ones.
- Change a one-way door without the maintainer's agreement.
