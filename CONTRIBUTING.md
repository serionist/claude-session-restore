# Contributing

Thanks for helping. This is the short path for a first contribution. [AGENTS.md](AGENTS.md) has the full rules, for
people and AI agents alike, and [REVIEW.md](REVIEW.md) what a review checks.

## Before you start

- **Open an issue** for anything beyond a typo, with the bug or feature form. Say there that you want to work on it.
- **Write a plan first** for a non-trivial change: another platform or terminal, a change to a command line the
  plugin builds, to the record's fields, or to `/restore`. Use the template in
  [docs/plans/README.md](docs/plans/README.md) and open it as a draft PR. A maintainer approves it before any code.
- **Leave the one-way doors alone** unless the maintainer agrees in the issue first: the plugin's name, `/restore`
  and its arguments, the `shell` option, and the record folder and its fields (AGENTS.md, One-way doors).
- **Don't set versions.** A release PR sets `plugin.json`'s version ([docs/releasing.md](docs/releasing.md)).
- **Report security issues privately**, never in an issue: see [SECURITY.md](SECURITY.md).
- **Your contribution is MIT licensed.** Opening a pull request means you agree to license it under the repository's
  [MIT licence](LICENSE).

## Build and test

You need Node 24 and git; [gitleaks](https://github.com/gitleaks/gitleaks) for the secret scan (the gate warns and
skips without it); and Claude Code to try the plugin in a session.

```
npm ci
node tools/setup.ts
node tools/gate.ts full
```

- `npm ci` installs the pinned Claude Code, Biome and TypeScript, and runs no install script.
- `node tools/gate.ts full` runs Biome, the types, `claude plugin validate --strict`, the plugin's tests (in Claude
  Code's own sandbox) and the tools' tests.
- **The plugin's types** come from the Claude Code that loads it: run `claude --plugin-dir plugin` once, and the gate
  checks them from then on. CI can't, so a PR that changes `plugin/` says the gate ran with them.
- **What no test reaches** (a restore, the band, the process lookup) is tried in a real session: AGENTS.md, Build and
  test. Say in the PR's "Tested by" how you tried it, on which Windows and Claude Code version.
- A bug fix comes with a test that failed before it, in `plugin/hooks/lib.test.ts` when the logic is in `lib.ts`.

## Open the pull request

1. Fork, and branch from `main` as `<issue>-<slug>`, such as `12-cmd-quoting`.
2. Make the change with its tests and docs: `README.md` and `plugin/README.md` for what users see, `docs/design.md`
   for how it works, a line in [CHANGELOG.md](CHANGELOG.md) under Unreleased when users notice, AGENTS.md when a
   path, a command or a rule changes.
3. Commit with an imperative subject that says what changed, and a body that says why. No AI co-author trailers,
   "Generated with" lines or session links: the commit-msg hook refuses them, and CI checks the PR's title and body.
4. Open the PR with the template filled in, ending `Closes #<issue>`. Its title becomes the commit on `main`.

CI runs the full gate on Linux, the plugin's tests on Windows and macOS, and CodeQL. The maintainer reviews a PR from
outside by reading it: they never check it out, build, load or run it on their machines, where a hooks module would
run in every Claude session. Your PR is ready for review when CI is green. The maintainer squash-merges it.
