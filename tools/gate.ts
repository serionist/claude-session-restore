/**
 * The gate: the checks a change passes before it lands. People run it, the pre-push hook runs its quick lane, CI runs
 * its full lane.
 *
 * Usage: node tools/gate.ts quick|full [--base <ref> | --all] [--head <ref>]
 *        node tools/gate.ts text      (the PR's title and body, from PR_TITLE and PR_BODY)
 *
 * The commits checked are base..head, origin/main..HEAD by default; --all checks all of head's history.
 *
 * Two kinds of check:
 * - the working tree's: the pinned dev tools, Biome, the types, the plugin as Claude Code validates it, the version's
 *   CHANGELOG section, AGENTS.md within 150 lines, each skill's frontmatter and its Codex link, the hooks stored as
 *   executable; full adds the plugin's tests and the tools' tests. They run when the head is the checked-out commit,
 *   and are skipped, with the reason, when the tree is not what is checked;
 * - the commits': no tool attribution in any message, and gitleaks, on base..head (merges included).
 *
 * It prints a table of the checks and exits 1 when any failed; a warning or a skip never fails it. Without gitleaks
 * the secret scan is skipped with a warning, unless GATE_REQUIRE_GITLEAKS=1 (as CI sets it), which makes that a
 * failure.
 *
 * Node's standard library only: the hooks run it before `npm ci` has, and every tool it runs comes from node_modules,
 * at the version package.json pins.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BASE = 'origin/main'
export const AGENTS_MAX_LINES = 150
export const SKILLS_DIR = '.claude/skills'
export const SKILL_LINKS_DIR = '.agents/skills'
export const LINK_MODE = '120000'
const HOOKS_DIR = '.githooks'
const HOOK_MODE = '100755'
const SKILL_KEYS = new Set(['name', 'description'])
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX = 64
const DESCRIPTION_MAX = 1024
const GITLEAKS_CONFIG = '.gitleaks.toml'
const GITLEAKS_IGNORE = '.gitleaksignore'
// The git log options every scan starts with. gitleaks reads `git log -p` as git prints it, and a developer's git
// config can reshape that: colour codes leave it reading no commit, a short commit id or a missing path prefix loses
// each finding's commit or path, a textconv driver shows converted text. Options on the command line outrank every
// setting. Without --diff-merges git shows a merge commit no diff at all, so what a merge's resolution adds would
// never be scanned; against its first parent, it is.
const GITLEAKS_PLAIN_LOG =
  '--no-color --no-textconv --no-show-signature --pretty=medium --date=default --no-abbrev-commit ' +
  '--src-prefix=a/ --dst-prefix=b/ --text --diff-merges=first-parent'
const OUTPUT_TAIL = 40
const PLUGIN_DIR = 'plugin'
// The engine writes the API types beside the mod when a session loads it (README, Developing); no command writes them.
const PLUGIN_TYPES = `${PLUGIN_DIR}/.claude-plugin/types/tsconfig.json`
const CLAUDE = 'node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs'
const BIOME = 'node_modules/@biomejs/biome/bin/biome'
const TSC = 'node_modules/typescript/bin/tsc'

// Tool attribution: lines a tool adds to say it wrote a change. Nothing on `main` carries them (AGENTS.md, Commits
// and PRs). Each pattern matches the line a tool adds, so a sentence about Claude, or a person named Claude, passes.
// A line may sit behind symbols ("🤖 ", "- ", a comment character): git keeps comment lines in a message given with
// -m, so the hook reads them too.
const TOOLS =
  'claude|anthropic|codex|openai|chatgpt|gpt-?\\d\\w*|copilot|gemini|devin|aider|windsurf|cursor\\s*(?:agent|ai|ide)|' +
  'cursoragent|cursor\\.com'
const CO_AUTHOR = /^[^\w]*co-authored-by\s*:\s*(?<who>.*?)\s*$/i
const WHO = /^(?<name>[^<>]*?)\s*(?:<(?<email>[^<>]*)>)?$/
// A co-author is a tool when its address is a tool's, or its name is a tool's alone or with a model and a version
// ("Claude", "Claude Opus 4.6", "GitHub Copilot", "aider (gpt-4o)"); "Claude Martin" is a person.
const TOOL_EMAIL =
  /^(?:noreply@anthropic\.com|no-?reply@openai\.com|cursoragent@cursor\.com|noreply@aider\.chat|\d+\+copilot@users\.noreply\.github\.com|[^@\s]*\[bot\]@users\.noreply\.github\.com)$/i
const TOOL_NAME = new RegExp(
  '^(?:claude(?:\\s+code)?|anthropic|(?:openai\\s+)?codex|chatgpt|gpt-?\\d[\\w.]*|(?:github\\s+)?copilot' +
    '|gemini(?:\\s+code\\s+assist)?|cursor(?:\\s+agent)?|devin(?:\\s+ai)?|aider|windsurf)' +
    '(?:\\s+(?:opus|sonnet|haiku|fable|code|cli|pro|flash|ultra|nano|mini|turbo|max|agent|ai|assist|preview|latest' +
    '|thinking|v?\\d[\\w.]*|\\([^()]*\\)))*$',
  'i',
)
const GENERATED = new RegExp(
  `^[^\\w]*(?:generated|created|written|authored|produced|assisted)\\s+(?:with|by|using|via|in)\\b.*?\\b(?:${TOOLS})\\b`,
  'i',
)
const SESSION_LINK =
  /(?:https?:\/\/)?(?:www\.)?(?:claude\.ai\/(?:code|chat|share)\b|chatgpt\.com\/(?:codex|share|c)\/)/i
const TOOL_TRAILER = /^[^\w]*(?:claude|anthropic|codex|openai|chatgpt|copilot|gemini|cursor)-[\w-]+\s*:/i
const PLAIN_YAML_BREAKERS = /:(?:\s|$)|\s#/
const FULL_SHA = /\b([0-9a-f]{10})[0-9a-f]{30}\b/g
const KEY_LINE = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/
const BLOCK_STYLES = new Set(['>', '>-', '>+', '|', '|-', '|+'])
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

export type Status = 'pass' | 'FAIL' | 'warn' | 'skip'

/** One check's outcome: a short detail for the table, and output shown on a FAIL. */
export type Result = { name: string; status: Status; detail: string; seconds?: number; output?: string }

/** What one run checks: the commits in its ranges, listed once, and whether the working tree is what they hold. */
export type Scope = {
  ranges: string[]
  /** Why the working tree's checks don't run; undefined when they do. */
  treeSkipped?: string
  /** A line on how the commits were chosen, when it is not what was asked. */
  note?: string
  commits: Array<[sha: string, message: string]>
  /** Why the commits could not be listed. */
  problem?: string
}

export type Ran = { status: number; stdout: string; stderr: string }

/** Run a command with a fixed argument list, no shell, and capture its output as UTF-8 text. */
export function run(cmd: string, args: readonly string[], cwd = ROOT, input?: string): Ran {
  const done = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (done.error) return { status: 127, stdout: '', stderr: String(done.error.message) }
  return { status: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

export function git(args: readonly string[], cwd = ROOT, input?: string): Ran {
  return run('git', args, cwd, input)
}

/** The full path of a program on PATH, or undefined; on Windows each PATHEXT suffix is tried. */
export function which(name: string): string | undefined {
  const suffixes = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE').split(';')] : ['']
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (!folder) continue
    for (const suffix of suffixes) {
      const path = join(folder, name + suffix.toLowerCase())
      try {
        if (statSync(path).isFile()) return path
      } catch {
        // Not here; the next folder.
      }
    }
  }
  return undefined
}

// Pure checks: tested in tools/gate.test.ts

/** True when a Co-authored-by trailer's `Name <email>` is a tool, by its address or by its name. */
export function toolCoAuthor(who: string): boolean {
  const match = WHO.exec(who.trim())
  if (!match?.groups) return false
  const email = (match.groups.email ?? '').trim()
  return TOOL_EMAIL.test(email) || TOOL_NAME.test((match.groups.name ?? '').trim())
}

/**
 * The lines of a commit message, PR title or body that carry tool attribution: a co-author that is a tool, a
 * "Generated with" line, a tool's own trailer (`Claude-Session:`), a session link.
 */
export function attributionLines(message: string): string[] {
  return message
    .split(/\r?\n/)
    .filter(line => {
      const coAuthor = CO_AUTHOR.exec(line)
      return (
        (coAuthor?.groups !== undefined && toolCoAuthor(coAuthor.groups.who ?? '')) ||
        GENERATED.test(line) ||
        TOOL_TRAILER.test(line) ||
        SESSION_LINK.test(line)
      )
    })
    .map(line => line.trim())
}

/** One line per attribution line in each (sha, message). */
export function commitProblems(commits: Scope['commits']): string[] {
  return commits.flatMap(([sha, message]) => attributionLines(message).map(line => `${sha.slice(0, 10)}: ${line}`))
}

/** (sha, message) pairs from `git log --format=%H%x00%B%x01`. */
export function parseLog(output: string): Scope['commits'] {
  const commits: Scope['commits'] = []
  for (const record of output.split('\x01')) {
    const trimmed = record.replace(/^[\r\n]+|[\r\n]+$/g, '')
    const at = trimmed.indexOf('\x00')
    if (at >= 0) commits.push([trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim()])
  }
  return commits
}

/** AGENTS.md stays within its line limit: every agent reads all of it at the start of each session. */
export function agentsMdProblems(text: string, limit = AGENTS_MAX_LINES): string[] {
  const lines = lineCount(text)
  return lines > limit ? [`AGENTS.md has ${lines} lines; keep it within ${limit}`] : []
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * The `key: value` pairs between a file's opening `---` and the next, each value with whether it is a plain scalar
 * (true) or quoted or a block (`>-`, `|`). Block and continuation lines are joined with spaces.
 *
 * Enough YAML for a skill's frontmatter, which holds two keys; throws on anything else.
 */
export function frontmatter(text: string): Map<string, [value: string, plain: boolean]> {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trimEnd() !== '---') throw new Error('it does not start with a --- line')
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
  if (end < 0) throw new Error('its frontmatter has no closing --- line')
  const fields = new Map<string, [string, boolean]>()
  let key: string | undefined
  let parts: string[] = []
  let plain = true

  const close = () => {
    if (key !== undefined) fields.set(key, [parts.filter(Boolean).join(' '), plain])
  }

  for (const line of lines.slice(1, end)) {
    if (key !== undefined && (!line.trim() || line.startsWith(' ') || line.startsWith('\t'))) {
      parts.push(line.trim())
      continue
    }
    close()
    key = undefined
    parts = []
    plain = true
    if (!line.trim() || line.startsWith('#')) continue
    const match = KEY_LINE.exec(line)
    if (!match) throw new Error(`the line '${line.trim()}' is not \`key: value\``)
    const name = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    if (fields.has(name)) throw new Error(`${name} is set twice`)
    key = name
    if (BLOCK_STYLES.has(value)) {
      plain = false
    } else if (value.startsWith("'") || value.startsWith('"')) {
      if (value.length < 2 || value.at(-1) !== value[0]) {
        throw new Error(`${name}'s quoted value does not end with its quote on the same line`)
      }
      parts = [value.slice(1, -1)]
      plain = false
    } else {
      parts = [value]
    }
  }
  close()

  return fields
}

/**
 * What is wrong with `.claude/skills/<folder>/SKILL.md` for Claude Code and Codex: the frontmatter holds only `name`
 * (equal to the folder) and `description` ("Use when ...", within 1,024 characters, valid YAML).
 */
export function skillProblems(folder: string, text: string): string[] {
  const where = `${SKILLS_DIR}/${folder}/SKILL.md`
  let fields: Map<string, [string, boolean]>
  try {
    fields = frontmatter(text)
  } catch (err) {
    return [`${where}: ${err instanceof Error ? err.message : String(err)}`]
  }
  const problems = [...fields.keys()]
    .filter(key => !SKILL_KEYS.has(key))
    .map(
      key => `${where}: frontmatter key '${key}': a skill's frontmatter holds only name and description (write-skill)`,
    )
  const name = fields.get('name')?.[0] ?? ''
  if (name !== folder) problems.push(`${where}: name is '${name}'; it must equal the folder name '${folder}'`)
  if (!SKILL_NAME.test(folder) || folder.length > SKILL_NAME_MAX) {
    problems.push(`${where}: the folder name takes lowercase letters, digits and hyphens, at most 64`)
  }
  const [description, plain] = fields.get('description') ?? ['', true]
  if (!description) {
    problems.push(`${where}: description is missing; agents pick a skill by it`)
    return problems
  }
  if (!description.startsWith('Use when'))
    problems.push(`${where}: description starts with its trigger, "Use when ..."`)
  if (description.length > DESCRIPTION_MAX) {
    problems.push(`${where}: description has ${description.length} characters; keep it within ${DESCRIPTION_MAX}`)
  }
  if (plain && PLAIN_YAML_BREAKERS.test(description)) {
    problems.push(`${where}: description: plain YAML can't hold a colon or a #: write it as a >- block`)
  }

  return problems
}

/**
 * Each skill has one link `.agents/skills/<name>`, a symlink in git's index (mode 120000) whose target is
 * `../../.claude/skills/<name>`, and each link leads to a skill. entries: (mode, path, the blob's text).
 */
export function linkProblems(entries: Array<[mode: string, path: string, target: string]>, skills: Set<string>) {
  const problems: string[] = []
  const linked = new Set<string>()
  const fix = 'node tools/setup.ts link'
  for (const [mode, path, target] of entries) {
    const rest = path.slice(SKILL_LINKS_DIR.length + 1)
    const slash = rest.indexOf('/')
    const name = slash < 0 ? rest : rest.slice(0, slash)
    if (slash >= 0) {
      if (!linked.has(name)) {
        problems.push(`${SKILL_LINKS_DIR}/${name} holds files; it must be one link: delete it, then ${fix} ${name}`)
      }
      linked.add(name)
      continue
    }
    linked.add(name)
    if (!skills.has(name)) problems.push(`${path} leads to no skill in ${SKILLS_DIR}: delete it`)
    else if (mode !== LINK_MODE)
      problems.push(`${path} is a plain file in git (mode ${mode}), not a link: ${fix} ${name}`)
    else if (target.trim() !== `../../${SKILLS_DIR}/${name}`) {
      problems.push(`${path} points to '${target.trim()}', not ../../${SKILLS_DIR}/${name}: ${fix} ${name}`)
    }
  }
  for (const name of [...skills].sort()) {
    if (!linked.has(name))
      problems.push(`${SKILL_LINKS_DIR}/${name} is missing, so Codex can't see the skill: ${fix} ${name}`)
  }

  return problems
}

/**
 * Each file in .githooks/ is stored as executable (mode 100755): Linux and macOS skip a hook without the bit, and a
 * hook added from Windows gets 100644. entries: (mode, path).
 */
export function hookProblems(entries: Array<[mode: string, path: string]>): string[] {
  return entries
    .filter(([mode]) => mode !== HOOK_MODE)
    .map(
      ([mode, path]) =>
        `${path} is stored as mode ${mode}, so Linux and macOS skip it: git update-index --chmod=+x ${path}`,
    )
}

/**
 * Every dev tool is pinned to one exact version in package.json, package-lock.json says the same, and node_modules
 * holds it. installed maps a package to the version in node_modules, undefined when it is missing.
 */
export function dependencyProblems(
  pinned: Record<string, string>,
  locked: Record<string, string>,
  installed: (name: string) => string | undefined,
): string[] {
  const problems: string[] = []
  for (const [name, version] of Object.entries(pinned)) {
    if (!EXACT_VERSION.test(version)) problems.push(`package.json: ${name} is "${version}"; pin one exact version`)
    if (locked[name] !== version)
      problems.push(`package-lock.json has ${name} ${locked[name] ?? 'missing'}: npm install`)
    const have = installed(name)
    if (have !== version) problems.push(`node_modules has ${name} ${have ?? 'missing'}, not ${version}: npm ci`)
  }
  for (const name of Object.keys(locked)) {
    if (!(name in pinned)) problems.push(`package-lock.json still has ${name}: npm install`)
  }

  return problems
}

/** The plugin's version has its dated section in CHANGELOG.md, written by the release PR that set it. */
export function versionProblems(version: string, changelog: string): string[] {
  if (!EXACT_VERSION.test(version)) return [`plugin.json's version "${version}" is not X.Y.Z`]
  const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm')

  return heading.test(changelog)
    ? []
    : [`CHANGELOG.md has no "## ${version} (YYYY-MM-DD)" section; the release PR that sets a version dates it`]
}

export function truthy(value: string | undefined): boolean {
  return !['', '0', 'false', 'no', 'off'].includes((value ?? '').trim().toLowerCase())
}

/** The last non-empty line of a tool's output: the table's detail. */
export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  return lines.at(-1) ?? ''
}

// Reading the repo

export function listCommits(ranges: readonly string[], cwd = ROOT): { commits: Scope['commits']; problem?: string } {
  const seen = new Set<string>()
  const commits: Scope['commits'] = []
  for (const rev of ranges) {
    const done = git(['log', '--format=%H%x00%B%x01', rev], cwd)
    if (done.status !== 0) {
      const reason = done.stderr.trim().split(/\r?\n/)[0] || 'git log failed'
      return { commits: [], problem: `can't list ${rev} (${reason}): git fetch origin, then run it again` }
    }
    for (const [sha, message] of parseLog(done.stdout)) {
      if (!seen.has(sha)) {
        seen.add(sha)
        commits.push([sha, message])
      }
    }
  }

  return { commits }
}

export function scopeOf(ranges: string[], treeSkipped?: string, cwd = ROOT): Scope {
  return { ranges, treeSkipped, ...listCommits(ranges, cwd) }
}

/** Each folder under .claude/skills that holds a SKILL.md, by name. */
export function skillFolders(root = ROOT): Map<string, string> {
  const folder = join(root, SKILLS_DIR)
  if (!existsSync(folder)) return new Map()
  const names = readdirSync(folder)
    .filter(name => existsSync(join(folder, name, 'SKILL.md')))
    .sort()

  return new Map(names.map(name => [name, join(folder, name, 'SKILL.md')]))
}

/** (mode, blob sha, path) of each entry in git's index under pathspec. */
export function indexEntries(pathspec: string, cwd = ROOT): Array<[mode: string, sha: string, path: string]> {
  const listed = git(['ls-files', '-s', '--', pathspec], cwd)
  if (listed.status !== 0) throw new Error(listed.stderr.trim() || `git ls-files failed for ${pathspec}`)

  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [meta = '', path = ''] = line.split('\t')
      const [mode = '', sha = ''] = meta.split(' ')
      return [mode, sha, path]
    })
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>
}

function readText(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function outcome(name: string, problems: string[], detail: string): Result {
  if (problems.length === 0) return { name, status: 'pass', detail }

  return {
    name,
    status: 'FAIL',
    detail: problems.length === 1 ? (problems[0] ?? '') : `${problems.length} problems`,
    output: problems.join('\n'),
  }
}

/** A dev tool from node_modules, run with this Node. */
function tool(name: string, script: string, args: string[]): Result {
  if (!existsSync(join(ROOT, script))) return { name, status: 'FAIL', detail: `${script} is missing: npm ci` }
  const done = run(process.execPath, [script, ...args])
  const output = `${done.stdout}${done.stderr}`.trim()

  return { name, status: done.status === 0 ? 'pass' : 'FAIL', detail: lastLine(output), output }
}

// The working tree's checks

function checkDependencies(): Result {
  const pkg = readJson('package.json')
  const lock = readJson('package-lock.json')
  const pinned = (pkg.devDependencies ?? {}) as Record<string, string>
  const packages = (lock.packages ?? {}) as Record<string, { devDependencies?: Record<string, string> }>
  const installed = (name: string) => {
    const path = join(ROOT, 'node_modules', name, 'package.json')
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version : undefined
  }
  const problems = dependencyProblems(pinned, packages['']?.devDependencies ?? {}, installed)

  return outcome('dependencies', problems, `${Object.keys(pinned).length} pinned`)
}

function checkPluginTypes(): Result {
  if (!existsSync(join(ROOT, PLUGIN_TYPES))) {
    return {
      name: 'plugin types',
      status: 'skip',
      detail: 'no API types yet: Claude Code writes them when a session loads the mod (README, Developing)',
    }
  }

  return tool('plugin types', TSC, ['-p', PLUGIN_DIR])
}

function checkPlugin(): Result {
  const outputs: string[] = []
  for (const target of ['.', PLUGIN_DIR]) {
    const done = tool('plugin', CLAUDE, ['plugin', 'validate', '--strict', target])
    outputs.push(`$ claude plugin validate --strict ${target}\n${done.output ?? done.detail}`)
    if (done.status !== 'pass') return { ...done, output: outputs.join('\n\n') }
  }

  return { name: 'plugin', status: 'pass', detail: 'the marketplace and the plugin validate --strict' }
}

function checkVersion(): Result {
  const version = String(readJson(`${PLUGIN_DIR}/.claude-plugin/plugin.json`).version ?? '')

  return outcome('version', versionProblems(version, readText('CHANGELOG.md')), version)
}

function checkAgentsMd(): Result {
  if (!existsSync(join(ROOT, 'AGENTS.md'))) return { name: 'AGENTS.md', status: 'FAIL', detail: 'AGENTS.md is missing' }
  const text = readText('AGENTS.md')

  return outcome('AGENTS.md', agentsMdProblems(text), `${lineCount(text)} lines`)
}

function checkSkills(): Result {
  const skills = skillFolders()
  const agents = existsSync(join(ROOT, 'AGENTS.md')) ? readText('AGENTS.md') : ''
  const problems: string[] = []
  for (const [name, path] of skills) {
    problems.push(...skillProblems(name, readFileSync(path, 'utf8')))
    if (!agents.includes(`\`${name}\``)) problems.push(`AGENTS.md does not name the skill \`${name}\` (write-skill)`)
  }

  return outcome('skills', problems, `${skills.size} skills`)
}

/**
 * Read from git's index, not the disk: where git makes no symlinks (Windows without Developer Mode) a link is a plain
 * file holding its target, and only the index says it is a link.
 */
function checkSkillLinks(): Result {
  const entries = indexEntries(SKILL_LINKS_DIR).map(([mode, sha, path]): [string, string, string] => [
    mode,
    path,
    mode === LINK_MODE ? git(['cat-file', 'blob', sha]).stdout : '',
  ])
  const links = entries.filter(([, path]) => !path.slice(SKILL_LINKS_DIR.length + 1).includes('/')).length

  return outcome('skill links', linkProblems(entries, new Set(skillFolders().keys())), `${links} links`)
}

function checkHooks(): Result {
  const entries = indexEntries(HOOKS_DIR).map(([mode, , path]): [string, string] => [mode, path])
  if (entries.length === 0)
    return { name: 'hooks', status: 'FAIL', detail: `nothing in ${HOOKS_DIR} is in git's index` }

  return outcome('hooks', hookProblems(entries), `${entries.length} executable`)
}

// The commits' checks

function checkAttribution(scope: Scope): Result {
  if (scope.problem) return { name: 'attribution', status: 'FAIL', detail: scope.problem }
  const found = commitProblems(scope.commits)
  if (found.length > 0) {
    return {
      name: 'attribution',
      status: 'FAIL',
      detail: `tool attribution in ${found.length} line(s)`,
      output: `${found.join('\n')}\nReword each commit without it (git rebase -i, reword).`,
    }
  }

  return { name: 'attribution', status: 'pass', detail: `${scope.commits.length} commits` }
}

function checkGitleaks(scope: Scope): Result {
  const name = 'gitleaks'
  const exe = which('gitleaks')
  if (!exe) {
    if (truthy(process.env.GATE_REQUIRE_GITLEAKS)) {
      return { name, status: 'FAIL', detail: 'not installed, and GATE_REQUIRE_GITLEAKS=1 requires it' }
    }
    return { name, status: 'warn', detail: 'not installed, so not scanned; https://github.com/gitleaks/gitleaks' }
  }
  if (existsSync(join(ROOT, GITLEAKS_IGNORE))) {
    return {
      name,
      status: 'FAIL',
      detail: `${GITLEAKS_IGNORE} skips findings without a reason`,
      output: `Delete ${GITLEAKS_IGNORE}; allow each exception in ${GITLEAKS_CONFIG} with its reason.`,
    }
  }
  if (scope.problem) return { name, status: 'FAIL', detail: scope.problem }
  if (scope.commits.length === 0) return { name, status: 'pass', detail: 'no commits to scan' }
  for (const rev of scope.ranges) {
    const args = ['git', '--config', join(ROOT, GITLEAKS_CONFIG), '--log-opts', `${GITLEAKS_PLAIN_LOG} ${rev}`]
    args.push('--redact', '--no-banner', '--ignore-gitleaks-allow', '--exit-code', '1', '-v', ROOT)
    const done = run(exe, args)
    if (done.status !== 0) {
      const output = `${done.stdout}${done.stderr}`.trim()
      return { name, status: 'FAIL', detail: `secrets found in ${rev}, or the scan failed`, output }
    }
  }

  return { name, status: 'pass', detail: `${scope.commits.length} commits` }
}

// The full lane's tests

function checkPluginTests(): Result {
  return tool('plugin tests', CLAUDE, ['plugin', 'test', PLUGIN_DIR])
}

function checkToolTests(): Result {
  const tests = readdirSync(join(ROOT, 'tools'))
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `tools/${name}`)
  const done = run(process.execPath, ['--test', ...tests])
  const output = `${done.stdout}${done.stderr}`.trim()
  const passed = /^(?:ℹ|#) pass (\d+)$/m.exec(output)?.[1]

  return {
    name: 'tool tests',
    status: done.status === 0 ? 'pass' : 'FAIL',
    detail: passed ? `${passed} passed` : lastLine(output),
    output,
  }
}

type Check = { name: string; check: (scope: Scope) => Result; readsTree: boolean }

const TREE: Check[] = [
  { name: 'dependencies', check: checkDependencies, readsTree: true },
  {
    name: 'biome',
    check: () => tool('biome', BIOME, ['ci', '--colors=off', '--reporter=summary', '.']),
    readsTree: true,
  },
  { name: 'tool types', check: () => tool('tool types', TSC, ['-p', '.']), readsTree: true },
  { name: 'plugin types', check: checkPluginTypes, readsTree: true },
  { name: 'plugin', check: checkPlugin, readsTree: true },
  { name: 'version', check: checkVersion, readsTree: true },
  { name: 'AGENTS.md', check: checkAgentsMd, readsTree: true },
  { name: 'skills', check: checkSkills, readsTree: true },
  { name: 'skill links', check: checkSkillLinks, readsTree: true },
  { name: 'hooks', check: checkHooks, readsTree: true },
]
const COMMITS: Check[] = [
  { name: 'attribution', check: checkAttribution, readsTree: false },
  { name: 'gitleaks', check: checkGitleaks, readsTree: false },
]
const FULL_ONLY: Check[] = [
  { name: 'plugin tests', check: checkPluginTests, readsTree: true },
  { name: 'tool tests', check: checkToolTests, readsTree: true },
]

export function laneChecks(lane: 'quick' | 'full'): Check[] {
  return [...TREE, ...COMMITS, ...(lane === 'full' ? FULL_ONLY : [])]
}

// Output

function say(text = ''): void {
  process.stdout.write(`${text}\n`)
}

function row(name: string, status: string, seconds: string, detail: string, width: number): string {
  return `  ${name.padEnd(width)}  ${status.padEnd(6)}  ${seconds.padStart(6)}  ${detail}`.trimEnd()
}

/** Run the lane's checks on the scope, print the table, and return the exit code: 1 when any failed. */
export function runLane(lane: 'quick' | 'full', scope: Scope): number {
  const checks = laneChecks(lane)
  const width = Math.max(...checks.map(one => one.name.length))
  say(`gate ${lane}, commits ${scope.ranges.join(', ').replace(FULL_SHA, '$1') || '(none)'}`)
  if (scope.note) say(scope.note)
  if (scope.treeSkipped) say(`the working tree's checks are skipped: ${scope.treeSkipped}`)
  say()
  say(row('check', 'result', 'time', 'detail', width))
  const results: Result[] = []
  for (const { name, check, readsTree } of checks) {
    let result: Result
    if (readsTree && scope.treeSkipped) {
      result = { name, status: 'skip', detail: 'the working tree is not what is checked' }
    } else {
      const started = performance.now()
      try {
        result = check(scope)
      } catch (err) {
        result = { name, status: 'FAIL', detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
      }
      result.seconds = (performance.now() - started) / 1000
    }
    results.push(result)
    const seconds = result.seconds === undefined ? '' : `${result.seconds.toFixed(1)}s`
    say(row(name, result.status, seconds, result.detail, width))
  }
  const failed = results.filter(result => result.status === 'FAIL')
  for (const result of failed) {
    if (!result.output) continue
    say()
    say(`--- ${result.name} ---`)
    say(result.output.split(/\r?\n/).slice(-OUTPUT_TAIL).join('\n'))
  }
  const warned = results.filter(result => result.status === 'warn').length
  const skipped = results.filter(result => result.status === 'skip').length
  const extra = (warned ? `, ${warned} warning(s)` : '') + (skipped ? `, ${skipped} skipped` : '')
  say()
  if (failed.length > 0) {
    say(`gate ${lane} FAILED: ${failed.map(result => result.name).join(', ')}`)
    return 1
  }
  say(`gate ${lane} passed: ${results.length - warned - skipped} checks${extra}`)

  return 0
}

/** The PR's title and body carry no tool attribution: the squash commit on main is built from them. */
export function runText(title: string, body: string): number {
  const found = attributionLines(`${title}\n${body}`)
  for (const line of found) say(`tool attribution in the PR's title or body: ${line}`)
  if (found.length > 0) {
    say('Edit the PR: the squash commit on main is built from its title and description (AGENTS.md, Commits and PRs).')
    return 1
  }
  say("gate text passed: no tool attribution in the PR's title or body")

  return 0
}

/** base..head, or all of head's history; the working tree's checks run when head is the checked-out commit. */
export function cliScope(base: string | undefined, head: string, cwd = ROOT): Scope {
  const headSha = git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], cwd).stdout.trim()
  const checkedOut = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd).stdout.trim()
  // A repository with no commit yet: the working tree is all there is, and the first push's pre-push scans the commit.
  if (head === 'HEAD' && !checkedOut) return { ranges: [], commits: [] }
  const skipped = headSha && headSha === checkedOut ? undefined : `${head} is not the checked-out commit`
  // Before the first push there is no origin/main to fetch: all of head's history is what the push will send.
  const unpushed = base === BASE && git(['rev-parse', '--verify', '--quiet', `${BASE}^{commit}`], cwd).status !== 0
  if (base === undefined || unpushed) {
    const scope = scopeOf([head], skipped, cwd)
    if (unpushed) scope.note = `${BASE} doesn't exist yet, so all of ${head}'s history is checked`
    return scope
  }

  return scopeOf([`${base}..${head}`], skipped, cwd)
}

export function main(argv: string[]): number {
  const [lane, ...rest] = argv
  const option = (flag: string, fallback: string) => {
    const at = rest.indexOf(flag)
    return at >= 0 && rest[at + 1] !== undefined ? (rest[at + 1] as string) : fallback
  }
  if (lane === 'text') return runText(process.env.PR_TITLE ?? '', process.env.PR_BODY ?? '')
  if (lane !== 'quick' && lane !== 'full') {
    process.stderr.write('usage: node tools/gate.ts quick|full [--base <ref> | --all] [--head <ref>], or text\n')
    return 2
  }
  const base = rest.includes('--all') ? undefined : option('--base', BASE)

  return runLane(lane, cliScope(base, option('--head', 'HEAD')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
