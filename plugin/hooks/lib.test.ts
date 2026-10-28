import { describe, expect, test } from 'claude-code/testing'

import type { SessionRecord } from '../types'
import type { Shell } from './lib'
import {
  claudeArgv,
  consoleStarts,
  crtQuote,
  encodePowerShell,
  isInterrupted,
  launchPlan,
  launchScript,
  MAX_AGE_MS,
  manualCommand,
  parseLiveness,
  pickResumeFlags,
  runArgvScript,
  SESSION_ENV,
  STALE_MS,
  splitCommandLine,
  statusForEnd,
  tabArgv,
  WT_LINE_MAX,
  wtLines,
} from './lib'

const NOW = 1_800_000_000_000

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'abc',
    cwd: 'D:\\work\\app',
    status: 'open',
    startedAt: NOW - 3_600_000,
    lastSeen: NOW - 30_000,
    ...over,
  }
}

describe('which sessions count as cut off', () => {
  test('a signal ends a session as interrupted; leaving on purpose closes it', () => {
    expect(statusForEnd('other')).toBe('interrupted')
    for (const reason of ['prompt_input_exit', 'clear', 'resume', 'logout']) expect(statusForEnd(reason)).toBe('closed')
  })

  test('an open session whose process is gone is interrupted', () => {
    const alive = new Map([[42, '2026-10-08T10:00:00.0000000Z']])
    expect(isInterrupted(rec({ pid: 42, pidStarted: '2026-10-08T10:00:00.0000000Z' }), NOW, alive)).toBe(false)
    expect(isInterrupted(rec({ pid: 7, pidStarted: '2026-10-08T10:00:00.0000000Z' }), NOW, alive)).toBe(true)
  })

  test('a reused pid with another start time does not keep a session alive', () => {
    const alive = new Map([[42, '2026-10-09T08:00:00.0000000Z']])
    expect(isInterrupted(rec({ pid: 42, pidStarted: '2026-10-08T10:00:00.0000000Z' }), NOW, alive)).toBe(true)
  })

  test('without a pid, only a stale heartbeat counts', () => {
    expect(isInterrupted(rec(), NOW, null)).toBe(false)
    expect(isInterrupted(rec({ lastSeen: NOW - STALE_MS - 1 }), NOW, null)).toBe(true)
  })

  test('closed, restored, dismissed and very old sessions are never offered', () => {
    for (const status of ['closed', 'restored', 'dismissed'] as const) {
      expect(isInterrupted(rec({ status, lastSeen: NOW - STALE_MS * 2 }), NOW, null)).toBe(false)
    }
    expect(isInterrupted(rec({ status: 'interrupted', lastSeen: NOW - MAX_AGE_MS - 1 }), NOW, null)).toBe(false)
  })
})

describe('launch flags', () => {
  test('splits a Windows command line with quotes', () => {
    expect(splitCommandLine('"C:\\Program Files\\claude.exe" --add-dir "D:\\my dir" --model opus')).toEqual([
      'C:\\Program Files\\claude.exe',
      '--add-dir',
      'D:\\my dir',
      '--model',
      'opus',
    ])
    expect(splitCommandLine('a "b\\"c" d\\\\e')).toEqual(['a', 'b"c', 'd\\\\e'])
  })

  test('keeps the flags that shape a session and drops the rest', () => {
    const args = [
      '--resume',
      'old-id',
      '--model',
      'opus',
      '--dangerously-skip-permissions',
      '--add-dir',
      'a',
      'b',
      '-c',
      '--permission-mode=plan',
    ]
    expect(pickResumeFlags(args)).toEqual([
      '--model',
      'opus',
      '--dangerously-skip-permissions',
      '--add-dir',
      'a',
      'b',
      '--permission-mode=plan',
    ])
    expect(pickResumeFlags(['fix the bug'])).toEqual([])
  })
})

/** A record a folder name or a flag would break out of, if any of it reached a shell as text. Invented. */
const HOSTILE = rec({
  id: 's9',
  cwd: 'D:\\repos\\x’$(calc)’ R&D; %PATH% ^x\\',
  exe: 'C:\\Users\\O’Brien Sóma\\claude.exe',
  flags: ['--add-dir', 'D:\\R&D', '--settings', '{"a": 1}', '--add-dir', "C:\\it's; here\\"],
})
const SHELLS: Shell[] = ['powershell', 'pwsh', 'cmd', 'none']
/** Only what Windows Terminal, cmd, PowerShell and the C runtime all pass through untouched. */
const INERT = /^[\w.+/=-]+$/

function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}

/** Each text a script carries as psString's base64, decoded. */
function carried(script: string): string[] {
  return [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map(m =>
    new TextDecoder().decode(bytes(m[1] ?? '')),
  )
}

/** The script an -EncodedCommand holds: UTF-16LE, which this environment's TextDecoder does not read. */
function decodeCommand(encoded: string): string {
  const raw = bytes(encoded)
  let text = ''
  for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] ?? 0) | ((raw[i + 1] ?? 0) << 8))

  return text
}

describe('reopening', () => {
  test('a tab runs claude through a script that carries its folder, path and flags only as base64', () => {
    for (const shell of SHELLS) {
      const argv = tabArgv(HOSTILE, shell)
      for (const part of argv) expect(INERT.test(part)).toBe(true)
      const script = decodeCommand(argv.at(-1) ?? '')
      for (const text of ['’', '$(calc)', 'R&D', 'Sóma', '{"a"']) expect(script.includes(text)).toBe(false)
      expect(carried(script)).toEqual([
        'D:\\repos\\x’$(calc)’ R&D; %PATH% ^x',
        'C:\\Users\\O’Brien Sóma\\claude.exe',
        '--resume',
        's9',
        ...(HOSTILE.flags ?? []),
      ])
    }
  })

  test('each shell keeps its tab open, or not, as the option says; cmd starts after claude and reads nothing', () => {
    expect(tabArgv(rec(), 'powershell').slice(0, 2)).toEqual(['powershell.exe', '-NoExit'])
    expect(tabArgv(rec(), 'pwsh').slice(0, 2)).toEqual(['pwsh.exe', '-NoExit'])
    expect(tabArgv(rec(), 'none').slice(0, 2)).toEqual(['powershell.exe', '-NoProfile'])
    const cmd = tabArgv(rec(), 'cmd')
    expect(cmd.slice(0, 2)).toEqual(['powershell.exe', '-NoProfile'])
    expect(
      decodeCommand(cmd.at(-1) ?? '')
        .split('\n')
        .slice(-2),
    ).toEqual(['& $exe $rest', "& $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })"])
  })

  test('flags come back only with the path of the claude that had them', () => {
    const known = rec({ id: 'a', exe: 'C:\\c\\claude.exe', flags: ['--model', 'opus'] })
    expect(claudeArgv(known)).toEqual(['C:\\c\\claude.exe', '--resume', 'a', '--model', 'opus'])
    expect(claudeArgv(rec({ id: 'a', flags: ['--add-dir', 'D:\\R&D'] }))).toEqual(['claude', '--resume', 'a'])
  })

  test('the tab script escapes double quotes only where PowerShell passes arguments the old way', () => {
    const script = runArgvScript(['claude', '--resume', 'x'], 'D:\\work')
    expect(script.split('\n')[0]).toContain('Set-Location -LiteralPath')
    expect(script).toContain('-CommandType Application')
    expect(script).toContain("$passing -eq 'Legacy'")
    expect(script).toContain(`$arg = $_ -replace '(\\\\*)"', '$1$1\\"'`)
    expect(script.split('\n').at(-1)).toBe('& $exe $rest')
  })

  test('crtQuote gives back each argument whole through the C runtime', () => {
    const args = ['plain', 'two words', 'D:\\', 'D:\\my dir\\', 'a"b', 'a\\"b', '', 'tab\there', 'x\\\\', '{"a": 1}']
    expect(splitCommandLine(args.map(crtQuote).join(' '))).toEqual(args)
  })

  test("one Windows Terminal line opens a tab per session, in its folder, with wt's ; kept", () => {
    const two = rec({ id: 's2', cwd: "D:\\it's; here\\" })
    const lines = wtLines([rec({ id: 's1' }), two], 'powershell')
    expect(lines.length).toBe(1)
    const tokens = splitCommandLine(lines[0] ?? '')
    expect(tokens.slice(0, 7)).toEqual(['-w', 'claude-restore', 'new-tab', '--title', 'app', '-d', 'D:\\work\\app'])
    expect(tokens.slice(7, 11)).toEqual(tabArgv(rec({ id: 's1' }), 'powershell'))
    expect(tokens.slice(11, 16)).toEqual([';', 'new-tab', '--title', "it's\\; here", '-d'])
    expect(tokens[16]).toBe("D:\\it's\\; here")
    expect(tokens.slice(17)).toEqual(tabArgv(two, 'powershell'))
  })

  test('many sessions take several Windows Terminal calls, each short enough to start', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...HOSTILE, id: `s${i}` }))
    const lines = wtLines(many, 'powershell')
    expect(lines.length > 1).toBe(true)
    for (const line of lines) {
      expect(line.length <= WT_LINE_MAX).toBe(true)
      expect(line.startsWith('-w claude-restore new-tab ')).toBe(true)
    }
    expect(lines.join(' ; ').split(' new-tab ').length - 1).toBe(60)
  })

  test('without Windows Terminal, each session gets a console window in its folder', () => {
    const [one] = consoleStarts([HOSTILE], 'cmd')
    expect(one?.file).toBe('powershell.exe')
    expect(one?.dir).toBe('D:\\repos\\x’$(calc)’ R&D; %PATH% ^x')
    expect(splitCommandLine(one?.args ?? '')).toEqual(tabArgv(HOSTILE, 'cmd').slice(1))
  })

  test('the launcher reads its plan from a file whose path it carries as base64, and clears the session variables', () => {
    const path = 'C:/Users/O’Brien/.claude/session-restore/launch.json'
    const script = launchScript(path)
    expect(script.includes('’')).toBe(false)
    expect(carried(script)).toEqual([path])
    expect(script).toContain('Start-Process -FilePath $wt.Source -ArgumentList $line')
    expect(script.includes('cmd')).toBe(false)
    expect(script).toContain('[Management.Automation.WildcardPattern]::Escape($one.dir)')
    expect(script).toContain('[Console]::Error.WriteLine($_.Exception.Message)')
    const plan = launchPlan([HOSTILE], 'powershell')
    expect(plan.env).toEqual(SESSION_ENV)
    expect(plan.env).toContain('CLAUDE_CODE_CHILD_SESSION')
    expect(plan.wt.length).toBe(1)
    expect(plan.consoles.length).toBe(1)
  })

  test('elsewhere, the command to type is quoted for a POSIX shell', () => {
    const line = manualCommand(
      rec({ id: 'x1', cwd: "/home/a/it's dir", exe: '/bin/claude', flags: ['--model', 'opus'] }),
    )
    expect(line).toBe("cd '/home/a/it'\\''s dir' && claude --resume x1 --model opus")
  })

  test('parses running processes', () => {
    const alive = parseLiveness('101 2026-10-08T10:00:00.0000000Z\r\n202 2026-10-08T11:00:00.0000000Z\r\n')
    expect(alive.get(101)).toBe('2026-10-08T10:00:00.0000000Z')
    expect(alive.size).toBe(2)
  })

  test('encodes a script as UTF-16LE base64', () => {
    expect(encodePowerShell('dir')).toBe('ZABpAHIA')
    expect(encodePowerShell('ab')).toBe('YQBiAA==')
  })
})
