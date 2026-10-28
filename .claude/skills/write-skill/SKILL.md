---
name: write-skill
description: >-
  Use when someone asks for a new skill, a slash command or a reusable agent recipe for working on this repo, or to fix
  a skill that is wrong or out of date. Keeps every skill usable by Claude Code and Codex alike, links it into
  .agents/skills and lists it in AGENTS.md. Not for the plugin, which ships no skills.
---

# Write a skill

Skills here serve the people and agents who work on this repo, in Claude Code and Codex alike; the plugin users
install has none. A skill is a recipe an agent follows: steps in a fixed order, a definition of done, hard nevers, and
the traps already paid for. Deterministic work belongs in a script the skill calls, not in prose the agent has to get
right.

## Steps

1. **Check it is needed.** Search `.claude/skills/` for a skill that already covers the request; change that one
   rather than adding a near-duplicate.
2. **Create the folder** `.claude/skills/<name>/` with `SKILL.md`. The folder name equals `name`: lowercase letters,
   digits and hyphens, at most 64 characters.
3. **Frontmatter** holds `name` and `description`, and nothing else. The description puts the trigger first
   ("Use when ..."), names the requests that should fire it, and stays within 1,024 characters. Write it as a `>-`
   block, as every skill here does: a `: ` or ` #` in a plain value is invalid YAML for the tools that parse it
   strictly.
4. **Body,** at most about 200 lines, in the house shape (`start-work` is the model):
   - what the skill is for, in two or three sentences;
   - **Steps:** numbered, each naming the file, tool or command it touches. A scope (a diff, a review, a branch) is
     named as the git command that resolves it, never in words;
   - **Done means:** what must be true when the agent stops;
   - **Never:** the hard rules;
   - **Traps,** once there are some: what broke, when, the guard.
   A file the skill reads beside `SKILL.md` (such as `lenses.md`) sits in its folder and is named in the step that
   uses it.
5. **Scripts** a skill needs live in `tools/`, Node's standard library only, with tests in `tools/<name>.test.ts`, and
   are named by their path from the repo root (`node tools/<name>.ts`). If the work is deterministic, write the script
   first.
6. **Link it for Codex:** `node tools/setup.ts link <name>`. It writes `.agents/skills/<name>` into git's index as a
   symlink to the skill, so the commit has the link on any machine, a Windows clone without Developer Mode included.
   Commit the link with the skill.
7. **List it** in `AGENTS.md`, in the skills line under How a change lands: its name and when to use it.
8. **Run `node tools/gate.ts quick`.** It checks the frontmatter (only `name` and `description`, the name equal to the
   folder, the description set, "Use when ..." first, within 1,024 characters), that `AGENTS.md` names the skill, and
   that each skill has its link and each link leads to a skill. The rest is review.

## Done means

- The skill fires on the requests in its description and on nothing unrelated.
- Every path, tool and command it names exists.
- `.agents/skills/<name>` links to it, `AGENTS.md` names it, and gate quick passes.

## Never

- Claude-only syntax in a skill: `!` shell injection, `$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`,
  or `allowed-tools`.
- A skill that restates a rule instead of pointing at it: name the section of `AGENTS.md` or `REVIEW.md`.
- A rule kept only in a skill's prose when a check could keep it: add the check to `tools/gate.ts`, with its test.
- `ln -s` from Git Bash, or a copied folder, for the link: use `node tools/setup.ts link`.

## Traps

| What broke | When | The guard |
|---|---|---|
| A skill's folder name differed from its `name`, and the tool dropped the skill without a word | another repo, 2026-10 | gate quick compares them |
| Git Bash's `ln -s` copied the folder instead of linking it, and Codex read a stale copy | another repo, 2026-10 | `setup.ts link`; gate quick reads each link's mode from git's index |
| A description with `: ` in it read fine in Claude Code and was invalid YAML in Codex | another repo, 2026-10 | Every description is a `>-` block; gate quick refuses a plain one with `: ` |
