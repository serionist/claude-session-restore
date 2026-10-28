// The restore launcher's PowerShell, run for real where Windows PowerShell is (CI's Windows job, a Windows clone):
// each script parses, and a tab's script hands the program every argument whole, whatever quotes, spaces or
// characters it holds. Claude Code's test sandbox has no processes, so plugin/hooks/lib.test.ts can't show this.
// Nothing here opens a window or a terminal: the program is Node, which writes the arguments it got to a file.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { ROOT, which } from './gate.ts'

type Lib = {
  runArgvScript(argv: readonly string[], dir: string, after?: string): string
  launchScript(planPath: string): string
  encodePowerShell(script: string): string
  crtQuote(arg: string): string
  UTF8_OUTPUT: string
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
const sessionDir = join(folder, 'R&D x’$(calc)’; [old] 100%')
mkdirSync(sessionDir)
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
