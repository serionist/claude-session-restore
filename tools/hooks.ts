/**
 * The git hooks behind the `.githooks/` shims, which `node tools/setup.ts` turns on.
 *
 * Usage (from a shim): node tools/hooks.ts commit-msg|pre-push|post-checkout|post-merge [git's arguments]
 *
 * - commit-msg refuses a message with tool attribution: a co-author that is a tool, a "Generated with" line, a tool's
 *   session trailer or link (AGENTS.md, Commits and PRs).
 * - pre-push runs the gate's quick lane on what the push sends: the commits' checks on each pushed range, and the
 *   working tree's checks only when the push sends HEAD and the tree has nothing else in it.
 * - post-checkout and post-merge name the AI setup files that changed, so an agent re-reads them. They only inform:
 *   git makes post-checkout's exit status the checkout's.
 *
 * Node's standard library only, like the gate.
 */

import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { attributionLines, BASE, git, runLane, scopeOf } from './gate.ts'

// The line above the diff `git commit -v` adds, behind whatever comment character is set; git drops it and all
// below it. Everything above, comment lines included, is the message: with -m git keeps comment lines.
const SCISSORS = /^\S+ -{24} >8 -{24}\s*$/
const ZERO_SHA = /^0+$/
// What an agent reads as its rules when a session starts (REVIEW.md, The harness).
const AGENT_SETUP_PREFIXES = ['.claude/', '.agents/']
const AGENT_SETUP_FILES = new Set(['REVIEW.md', '.mcp.json'])
const AGENT_SETUP_NAMES = new Set(['AGENTS.md', 'CLAUDE.md'])

function say(hook: string, text: string): void {
  process.stderr.write(`${hook}: ${text}\n`)
}

/** The message git may record: everything above the scissors line, comment lines included. */
export function messageText(raw: string): string {
  const kept: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (SCISSORS.test(line)) break
    kept.push(line)
  }

  return kept.join('\n').trim()
}

/** Refuse a message with tool attribution; 1 refuses the commit. */
export function commitMsg(path: string): number {
  const found = attributionLines(messageText(readFileSync(path, 'utf8')))
  for (const line of found) say('commit-msg', `refused: tool attribution: ${line}`)
  if (found.length > 0) {
    say('commit-msg', 'take those lines out and commit again (AGENTS.md, Commits and PRs)')
    return 1
  }

  return 0
}

/**
 * (range, local sha) for each ref a push updates, from the lines git gives pre-push on stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`. A deletion sends nothing and is left out. A new branch, or a
 * remote commit this clone never fetched, is compared with base.
 */
export function pushRanges(lines: string[], base: string, known: (sha: string) => boolean): Array<[string, string]> {
  const pushed: Array<[string, string]> = []
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    const [, local = '', , remote = ''] = parts
    if (parts.length !== 4 || ZERO_SHA.test(local)) continue
    const since = !ZERO_SHA.test(remote) && known(remote) ? remote : base
    pushed.push([`${since}..${local}`, local])
  }

  return pushed
}

/**
 * Why the working tree can't stand for what a push sends, or undefined when it can: every pushed commit is HEAD, and
 * nothing is changed or untracked. pushed and head are commit ids.
 */
export function treeSkipReason(pushed: string[], head: string, dirty: boolean): string | undefined {
  const other = pushed.find(sha => sha !== head)
  if (other !== undefined) return `the push sends ${other.slice(0, 10)}, not HEAD`
  if (dirty) return 'it has changes or untracked files that are not pushed'

  return undefined
}

/** The gate's quick lane on what the push sends. */
function prePush(lines: string[]): number {
  const known = (sha: string) => git(['cat-file', '-e', `${sha}^{commit}`]).status === 0
  // A clone of a repo with no origin/main yet (the first push) checks all of what it sends.
  const base = git(['rev-parse', '--verify', '--quiet', `${BASE}^{commit}`]).status === 0 ? BASE : ''
  const pushed = pushRanges(lines, base, known)
  if (pushed.length === 0) {
    say('pre-push', 'the push only deletes, so there is nothing to check')
    return 0
  }
  const commits = pushed.map(([, sha]) => git(['rev-parse', `${sha}^{commit}`]).stdout.trim())
  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  const dirty = git(['status', '--porcelain']).stdout.trim() !== ''
  const ranges = pushed.map(([range, sha]) => (range.startsWith('..') ? sha : range))
  const scope = scopeOf(ranges, treeSkipReason(commits, head, dirty))
  if (scope.treeSkipped) scope.treeSkipped += '; run node tools/gate.ts quick on the pushed commit to check it'

  return runLane('quick', scope)
}

/** True for an agent's rules: AGENTS.md and CLAUDE.md anywhere, REVIEW.md, .claude/, .agents/, .mcp.json. */
export function isAgentSetup(path: string): boolean {
  const shown = path.replace(/\\/g, '/').replace(/^\.\//, '')

  return (
    AGENT_SETUP_PREFIXES.some(prefix => shown.startsWith(prefix)) ||
    AGENT_SETUP_FILES.has(shown) ||
    AGENT_SETUP_NAMES.has(posix.basename(shown))
  )
}

/** Name the AI setup files that differ between revs: an agent read the old ones when its session started. */
function setupChanged(hook: string, revs: string[]): number {
  const names = git(['diff', '--name-only', ...revs])
    .stdout.split('\n')
    .filter(Boolean)
  const changed = names.filter(isAgentSetup)
  if (changed.length > 0) {
    say(hook, 'the AI setup changed; an agent re-reads those it already read, or starts a new session:')
    for (const name of changed) say(hook, `  ${name}`)
  }

  return 0
}

/** True while a rebase runs: its checkout goes from the branch's tip to the commit it rebases onto. */
function rebasing(): boolean {
  return ['rebase-merge', 'rebase-apply'].some(name => existsSync(git(['rev-parse', '--git-path', name]).stdout.trim()))
}

/** After a branch switch. A file checkout, the same commit and a new worktree (old is the null id) say nothing. */
export function postCheckout(old = '', next = '', branch = '0'): number {
  if (branch !== '1' || old === next || ZERO_SHA.test(old) || old === '') return 0
  // A rebase compares only what the new base changed, not the branch's own commits it is about to replay.
  return setupChanged('post-checkout', rebasing() ? [`${old}...${next}`] : [old, next])
}

/** After a merge or a pull: ORIG_HEAD is the commit before it. */
function postMerge(): number {
  const old = git(['rev-parse', '-q', '--verify', 'ORIG_HEAD']).stdout.trim()

  return old ? setupChanged('post-merge', [old, 'HEAD']) : 0
}

export function main(argv: string[]): number {
  const [hook, ...rest] = argv
  if (hook === 'commit-msg' && rest[0] !== undefined) return commitMsg(rest[0])
  if (hook === 'pre-push') return prePush(readFileSync(0, 'utf8').split(/\r?\n/))
  if (hook === 'post-checkout') return postCheckout(rest[0], rest[1], rest[2])
  if (hook === 'post-merge') return postMerge()
  process.stderr.write(`unknown hook or missing argument: ${argv.join(' ')}\n`)

  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
