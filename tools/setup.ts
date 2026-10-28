/**
 * Set up a clone once, and link skills for Codex. Safe to run again.
 *
 * Usage:
 *   node tools/setup.ts                 turn on the hooks, check out the skill links as symlinks where this machine
 *                                       can make them, and check the tools
 *   node tools/setup.ts link [skill]    write .agents/skills/<skill> into git's index as a link to
 *                                       .claude/skills/<skill>; every skill when none is named
 *
 * Every setting is this repo's own (`git config --local`), shared by its worktrees; nothing global changes.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { git, LINK_MODE, ROOT, SKILL_LINKS_DIR, SKILLS_DIR, skillFolders, which } from './gate.ts'

const CONFIG: Array<[key: string, value: string, why: string]> = [
  ['core.hooksPath', '.githooks', 'the hooks in .githooks/: commit-msg, pre-push, post-checkout, post-merge'],
]
const TOOLS: Array<[name: string, needed: boolean, why: string]> = [
  ['gitleaks', false, "the gate's secret scan, skipped without it: https://github.com/gitleaks/gitleaks"],
  ['gh', false, "the skills' issues and PRs: https://cli.github.com, then gh auth login"],
]

function setConfig(root: string, key: string, value: string): string {
  if (git(['config', '--local', '--get', key], root).stdout.trim() === value) return `${key}=${value} (already set)`
  const done = git(['config', '--local', key, value], root)
  if (done.status !== 0) return `TO DO: git config --local ${key} ${value} failed: ${done.stderr.trim()}`

  return `${key}=${value} (set)`
}

/** On Linux and macOS git skips a hook without the executable bit; git stores them as 100755, but a copy may drop it. */
function makeHooksExecutable(root: string): string[] {
  if (process.platform === 'win32') return []
  const done: string[] = []
  const folder = join(root, '.githooks')
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name)
    const { mode } = statSync(path)
    if (statSync(path).isFile() && (mode & 0o100) === 0) {
      chmodSync(path, mode | 0o111)
      done.push(`made .githooks/${name} executable`)
    }
  }

  return done
}

/** True when this machine lets this user make a symlink; on Windows that takes Developer Mode. */
function symlinksWork(): boolean {
  const tmp = mkdtempSync(join(tmpdir(), 'setup-'))
  try {
    mkdirSync(join(tmp, 'target'))
    symlinkSync('target', join(tmp, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Paths under .agents/skills that differ on disk from git's index, or that git doesn't track. A link only staged, as
 * `link` leaves it, is no change: checking it out writes what the index holds.
 */
function changedLinks(root: string): string[] {
  const status = git(['status', '--porcelain', '--', SKILL_LINKS_DIR], root).stdout
  // Each line is "XY path": Y is the working tree's side, " " when the file on disk is what the index holds.
  return status
    .split('\n')
    .filter(line => line.length > 3 && line[1] !== ' ')
    .map(line => line.slice(3))
}

/**
 * Where symlinks work, have git check the skill links out as real symlinks, which Codex follows. Elsewhere they stay
 * plain files holding their target: git's index still has them as links, so every commit keeps them.
 */
export function checkoutLinks(root: string, canSymlink: () => boolean): string[] {
  if (!canSymlink()) {
    return [
      `this machine can't make symlinks (Windows without Developer Mode), so ${SKILL_LINKS_DIR} holds plain files ` +
        'and Codex finds no skills there; AGENTS.md names them, and each is a SKILL.md to read',
    ]
  }
  // A checkout overwrites what differs on disk from git's index, so a changed link is left for the developer to look
  // at. Checked before core.symlinks changes: with it false, a plain file holding the target is no change.
  const changed = changedLinks(root)
  if (changed.length > 0) {
    return [
      `warning: ${SKILL_LINKS_DIR} has local changes, so it was not checked out again: ${changed.join(', ')}; ` +
        `see git status -- ${SKILL_LINKS_DIR}, then run this again`,
    ]
  }
  const lines = [setConfig(root, 'core.symlinks', 'true')]
  if (!git(['ls-files', '--', SKILL_LINKS_DIR], root).stdout.trim()) return lines
  const done = git(['checkout', '--', SKILL_LINKS_DIR], root)
  if (done.status !== 0) return [...lines, `TO DO: git checkout -- ${SKILL_LINKS_DIR} failed: ${done.stderr.trim()}`]

  return [...lines, `${SKILL_LINKS_DIR} checked out as symlinks`]
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Write `.agents/skills/<name>` into git's index as a symlink (mode 120000) to the skill, then check it out.
 *
 * git puts a symlink on disk where it can, and otherwise a plain file holding the target; either way the commit has
 * the link. Git Bash's `ln -s` copies the folder instead, which is why this writes the index directly.
 */
export function link(root: string, name: string): [ok: boolean, line: string] {
  if (!existsSync(join(root, SKILLS_DIR, name, 'SKILL.md'))) {
    return [false, `no skill ${name}: ${SKILLS_DIR}/${name}/SKILL.md doesn't exist`]
  }
  const path = `${SKILL_LINKS_DIR}/${name}`
  const onDisk = join(root, path)
  if (existsSync(onDisk) && !isSymlink(onDisk) && statSync(onDisk).isDirectory()) {
    return [false, `${path} is a folder (a copy, as Git Bash's ln -s makes): delete it, then run this again`]
  }
  const target = `../../${SKILLS_DIR}/${name}`
  const blob = git(['hash-object', '-w', '--stdin'], root, target)
  if (blob.status !== 0) return [false, `linking ${path} failed: ${blob.stderr.trim()}`]
  const sha = blob.stdout.trim()
  const listed = git(['ls-files', '-s', '--', path], root).stdout.split(/\s+/)
  if (listed[0] === LINK_MODE && listed[1] === sha && (isSymlink(onDisk) || existsSync(onDisk))) {
    return [true, `${path} -> ${target} (already linked)`]
  }
  const added = git(['update-index', '--add', '--cacheinfo', `${LINK_MODE},${sha},${path}`], root)
  if (added.status !== 0) return [false, `linking ${path} failed: ${added.stderr.trim()}`]
  const done = git(['checkout', '--', path], root)
  if (done.status !== 0)
    return [false, `${path} is staged as a link, but git couldn't check it out: ${done.stderr.trim()}`]
  const kind = isSymlink(onDisk) ? 'a symlink' : 'a plain file holding the target (git makes no symlinks here)'

  return [true, `${path} -> ${target} (linked in git's index; on disk ${kind}). Commit it with the skill.`]
}

function linkAll(root: string, names: string[]): number {
  let failed = 0
  for (const name of names.length > 0 ? names : [...skillFolders(root).keys()]) {
    const [ok, line] = link(root, name)
    process.stdout.write(`${line}\n`)
    if (!ok) failed++
  }

  return failed > 0 ? 1 : 0
}

/** Configure the repo at root and print what was done; 1 when something is left for you to do. */
export function setup(root: string, canSymlink: () => boolean = symlinksWork): number {
  const print = (line: string) => process.stdout.write(`${line}\n`)
  if (git(['rev-parse', '--git-dir'], root).status !== 0) {
    print(`not a git repository: ${root}`)
    return 1
  }
  const madeExecutable = makeHooksExecutable(root)
  const sections: Array<[string, string[]]> = [
    ['git config (this repo only)', CONFIG.map(([key, value, why]) => `${setConfig(root, key, value)}: ${why}`)],
    ['hooks', madeExecutable.length > 0 ? madeExecutable : ['executable as stored']],
    ['skill links', checkoutLinks(root, canSymlink)],
  ]
  let todo = 0
  for (const [title, lines] of sections) {
    print(`${title}:`)
    for (const line of lines) {
      print(`  ${line}`)
      if (line.startsWith('TO DO')) todo++
    }
  }
  print('tools:')
  if (!existsSync(join(root, 'node_modules', '.package-lock.json'))) {
    todo++
    print('  TO DO: npm ci, which installs the pinned Biome, TypeScript and Claude Code the gate runs')
  } else {
    print('  node_modules: installed')
  }
  for (const [name, needed, why] of TOOLS) {
    if (which(name)) print(`  ${name}: found`)
    else if (needed) {
      todo++
      print(`  TO DO: ${name} is missing. Install: ${why}`)
    } else print(`  ${name}: missing (optional: ${why})`)
  }
  print(todo === 0 ? 'done.' : `done, with ${todo} thing(s) to do above.`)

  return todo > 0 ? 1 : 0
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv
  if (command === 'link') return linkAll(ROOT, rest)
  if (command !== undefined) {
    process.stderr.write('usage: node tools/setup.ts [link [skill...]]\n')
    return 2
  }

  return setup(ROOT)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
