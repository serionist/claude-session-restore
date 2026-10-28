import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { SessionRecord } from '../types'

// The hooks module against the engine's own `$`, with every noun it calls answered here: the session, the files, the
// processes. Nothing runs PowerShell; process.run is recorded and answered.

const NOW = 1_800_000_000_000
const HOME = 'C:\\Users\\test'
// Matched by its end: off Windows, the engine takes this home for a relative path and writes beneath its own folder.
const SESSIONS = '/.claude/session-restore/sessions'

type Written = { path: string; text: string }

/** Answers the session and its files beneath the plugin; what it writes and runs is kept for the test to read. */
function world(on: On, files: Record<string, string> = {}) {
  const written: Written[] = []
  const ran: string[][] = []
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: HOME })
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'restore' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'own-session' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.root', () => ({ value: 'D:\\work\\app' }))
  on('session.cwd', () => ({ value: 'D:\\work\\app\\packages\\api' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'fix the band', toolUses: [] }] }))
  // The engine hands a path on in the system's own separators.
  on('fs.write', (_, e) => {
    written.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: NOW, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: files[e.path.split(/[\\/]/).at(-1) ?? ''] ?? '' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  return { written, ran, clock }
}

/** The script a `powershell -EncodedCommand` call runs. */
function scriptOf(argv: readonly string[]): string {
  const raw = Uint8Array.from(atob(argv.at(-1) ?? ''), c => c.charCodeAt(0))
  let text = ''
  for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] ?? 0) | ((raw[i + 1] ?? 0) << 8))

  return text
}

describe('the hooks', () => {
  test("a session's record keeps its project root, not where a shell cd took it", async ($, on) => {
    const { written, clock } = world(on)
    await $.session.start({ cwd: 'D:\\work\\app', surface: 'terminal', isInteractive: true })
    await clock.settle()

    const own = written.filter(one => one.path.endsWith(`${SESSIONS}/own-session.json`)).at(-1)
    const rec = JSON.parse(own?.text ?? '{}') as SessionRecord
    expect(rec.cwd).toBe('D:\\work\\app')
    expect(rec.status).toBe('open')
    expect(rec.title).toBe('fix the band')
  })

  test('restoring writes the plan beside the records and runs the launcher on it, its output in UTF-8', async ($, on) => {
    const cut: SessionRecord = {
      id: 'cut-1',
      cwd: 'D:\\repos\\R&D',
      status: 'interrupted',
      startedAt: NOW - 7_200_000,
      lastSeen: NOW - 60_000,
      exe: 'C:\\bin\\claude.exe',
      flags: ['--model', 'opus'],
    }
    const { written, ran, clock } = world(on, { 'cut-1.json': JSON.stringify(cut) })
    await $.session.start({ cwd: 'D:\\work\\app', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // What `$.command.run` takes moved between Claude Code versions: it fills in the origin and presentation now.
    const run = { command: 'restore', args: 'all' } as Parameters<typeof $.command.run>[0]
    const { text } = await $.command.run(run)
    await clock.settle()

    expect(text).toBe('Reopened 1 session in Windows Terminal.')
    const plan = written.find(one => one.path.endsWith('/.claude/session-restore/launch.json'))
    expect(JSON.parse(plan?.text ?? '{}').wt.length).toBe(1)
    const launcher = scriptOf(ran.at(-1) ?? [])
    expect(launcher.split('\n')[0]).toContain('[Console]::OutputEncoding')
    expect(launcher).toContain('Get-Content -Raw -Encoding UTF8 -LiteralPath')
    expect(launcher.includes('R&D')).toBe(false)
    const restored = written.filter(one => one.path.endsWith(`${SESSIONS}/cut-1.json`)).at(-1)
    expect(JSON.parse(restored?.text ?? '{}').status).toBe('restored')
  })
})
