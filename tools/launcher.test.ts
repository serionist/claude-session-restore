// The restore's scripts, run for real: on Windows the launcher's PowerShell (CI's Windows job, a Windows clone), on
// macOS and Linux the session's sh script, the detached start and the process lookup (CI's Linux and macOS jobs).
// Each hands the program every argument whole, whatever quotes, spaces or characters it holds. Claude Code's test
// sandbox has no processes, so plugin/hooks/lib.test.ts can't show this. Nothing here opens a window or a terminal:
// the program is Node, which writes the arguments it got to a file.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { ROOT, which } from './gate.ts'

type SessionLike = {
  id: string
  cwd: string
  status: string
  startedAt: number
  lastSeen: number
  exe?: string
  flags?: string[]
}
type Lib = {
  runArgvScript(argv: readonly string[], dir: string, after?: string): string
  launchScript(planPath: string): string
  encodePowerShell(script: string): string
  crtQuote(arg: string): string
  UTF8_OUTPUT: string
  sessionScript(rec: SessionLike, shell: string, env?: { claude?: string; configDir?: string }): string
  posixQuote(word: string): string
  appleScript(app: 'terminal' | 'iterm'): string[]
  DETACH: string
  LOOKUP: string
  PROCESSES: string
  parseLookup(stdout: string): { pid: number; started: string; exe?: string; args?: string[] } | undefined
  parseLiveness(stdout: string): Map<number, string>
  TERMINALS: readonly string[]
}
// Imported at run time: the plugin is type-checked as Claude Code reads it (plugin/tsconfig.json), not as Node does.
const lib = (await import(pathToFileURL(join(ROOT, 'plugin', 'hooks', 'lib.ts')).href)) as Lib

const pwsh = which('pwsh')
const SHELLS = process.platform === 'win32' ? ['powershell.exe', ...(pwsh ? [pwsh] : [])] : []
const skip = SHELLS.length === 0 ? 'no Windows PowerShell here' : false

// What a folder, a flag or a path may hold; invented. PowerShell drops an empty argument, so none is empty.
const HOSTILE = [
  '--add-dir',
  'D:\\R&D',
  '--settings',
  '{"a": 1}',
  'x’$(calc)’',
  "it's; here\\",
  'two words\\',
  'Sóma Ügyfél',
  '%PATH%',
  '^x',
  'a\\"b',
  'tab\there',
]

const folder = mkdtempSync(join(tmpdir(), 'launcher-test-'))
// A session's folder, as hostile as Windows allows: the tab script must start the program in it.
mkdirSync(join(folder, 'R&D x’$(calc)’; [old] 100%'))
// Its long path: a temp folder may be an 8.3 short one (C:\Users\RUNNER~1 on CI), and PowerShell names it the long way.
const sessionDir = realpathSync.native(join(folder, 'R&D x’$(calc)’; [old] 100%'))
const echo = join(folder, 'echo.cjs')
writeFileSync(
  echo,
  "require('fs').writeFileSync(process.env.ECHO_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))\n",
)
after(() => rmSync(folder, { recursive: true, force: true }))

function runPowerShell(shell: string, script: string, env: Record<string, string> = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', lib.encodePowerShell(script)]
  const done = spawnSync(shell, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true })
  assert.equal(done.status, 0, `${shell}: ${done.stderr}`)

  return done.stdout.trim()
}

/** How many errors PowerShell's own parser finds in the script; nothing in it runs. */
function parseErrors(shell: string, script: string): number {
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const check = [
    `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    '$errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$errors)',
    '$errors.Count',
  ].join('\n')

  return Number(runPowerShell(shell, check))
}

describe('the launcher in real PowerShell', { skip }, () => {
  for (const shell of SHELLS) {
    test(`${shell}: the tab script and the launcher parse`, () => {
      const tab = lib.runArgvScript(['C:\\Users\\O’Brien\\claude.exe', ...HOSTILE], sessionDir, '& cmd.exe')
      assert.equal(parseErrors(shell, tab), 0)
      assert.equal(parseErrors(shell, lib.launchScript('C:/Users/O’Brien/.claude/session-restore/launch.json')), 0)
    })

    test(`${shell}: the tab script starts the program in the session's folder, every argument whole`, () => {
      const out = join(folder, `argv-${SHELLS.indexOf(shell)}.json`)
      runPowerShell(shell, lib.runArgvScript([process.execPath, echo, ...HOSTILE], sessionDir), { ECHO_OUT: out })
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { argv: HOSTILE, cwd: sessionDir })
    })
  }

  test('Windows PowerShell writes UTF-8 to a pipe after UTF8_OUTPUT', () => {
    assert.equal(runPowerShell('powershell.exe', `${lib.UTF8_OUTPUT}\n'Sóma Ügyfél'`), 'Sóma Ügyfél')
  })

  test('crtQuote: Windows reads each argument back whole', () => {
    const out = join(folder, 'argv-crt.json')
    const line = [echo, ...HOSTILE].map(lib.crtQuote)
    spawnSync(process.execPath, line, { windowsVerbatimArguments: true, env: { ...process.env, ECHO_OUT: out } })
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).argv, HOSTILE)
  })
})

describe('the macOS and Linux scripts in a real shell', {
  skip: process.platform === 'win32' ? 'Windows' : false,
}, () => {
  /** Runs a script by /bin/sh, its arguments as "$1" and on. */
  const sh = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync('/bin/sh', ['-c', script, 'sh', ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

  test("the session's script starts the program in the session's folder, every argument whole", () => {
    // A stand-in for claude: Node, writing what it got.
    const program = join(folder, 'fake-claude')
    writeFileSync(program, `#!/bin/sh\nexec ${lib.posixQuote(process.execPath)} ${lib.posixQuote(echo)} "$@"\n`)
    chmodSync(program, 0o755)
    const record = {
      id: 's9',
      cwd: `${sessionDir}/`,
      status: 'interrupted',
      startedAt: 0,
      lastSeen: 0,
      exe: program,
      flags: HOSTILE.filter(arg => !arg.includes('\t')),
    }
    const script = join(folder, 's9.sh')
    writeFileSync(script, lib.sessionScript(record, 'none'))
    const out = join(folder, 'argv-sh.json')

    const done = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: { ...process.env, ECHO_OUT: out, CLAUDECODE: '1' },
    })

    assert.equal(done.status, 0, done.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
      argv: ['--resume', 's9', ...record.flags],
      cwd: sessionDir,
    })
  })

  test('a detached start returns at once, whatever the program does', () => {
    const started = performance.now()
    const done = sh(lib.DETACH, ['sleep', '30'])
    assert.equal(done.status, 0, done.stderr)
    assert.ok(performance.now() - started < 3_000, `took ${performance.now() - started} ms`)
  })

  test('the lookup finds a parent named claude, and the listing agrees on its start whatever the time zone', () => {
    // A copy of sh named claude stands for claude; `; true` keeps it from handing its process to the last command.
    const claude = join(folder, 'claude')
    copyFileSync('/bin/sh', claude)
    chmodSync(claude, 0o755)
    const records = join(folder, 'records')
    mkdirSync(records, { recursive: true })
    const run =
      '/bin/sh -c "$LOOKUP" sh "$RECORDS" "$RECORDS"; echo ---; ' +
      'TZ=UTC0 /bin/sh -c "$PROCESSES"; echo ---; TZ=Asia/Tokyo /bin/sh -c "$PROCESSES"; true'
    const done = spawnSync(claude, ['-c', run], {
      encoding: 'utf8',
      env: { ...process.env, LOOKUP: lib.LOOKUP, PROCESSES: lib.PROCESSES, RECORDS: records },
    })
    assert.equal(done.status, 0, done.stderr)
    const [lookup = '', utc = '', tokyo = ''] = done.stdout.split('---\n')

    const found = lib.parseLookup(lookup)
    assert.ok(found, lookup)
    assert.equal(found.pid, done.pid)
    assert.ok(found.exe?.endsWith('/claude'), found.exe)
    assert.equal(lib.parseLiveness(utc).get(done.pid), found.started)
    assert.equal(lib.parseLiveness(tokyo).get(done.pid), found.started)
    if (process.platform === 'linux') assert.equal(found.args?.[0], '-c')
  })

  test('macOS compiles the Terminal AppleScript', { skip: process.platform === 'darwin' ? false : 'not macOS' }, () => {
    const compiled = join(folder, 'terminal.scpt')
    const done = spawnSync(
      'osacompile',
      ['-o', compiled, ...lib.appleScript('terminal').flatMap(line => ['-e', line])],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(done.status, 0, done.stderr)
  })
})

test("plugin.json's terminal option lists the terminals the plugin knows, in its order", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.deepEqual(manifest.userConfig.terminal.options, lib.TERMINALS)
  assert.equal(manifest.userConfig.terminal.default, 'auto')
})
