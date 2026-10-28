import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { SessionRecord } from '../types'

// The hooks module against the engine's own `$`, with every noun it calls answered here: the session, the files, the
// processes. Nothing runs PowerShell; process.run is recorded and answered.

const NOW = 1_800_000_000_000
const HOME = 'C:\\Users\\test'
// Matched by its end: off Windows, the engine takes this home for a relative path and writes beneath its own folder.
const SESSIONS = '/.claude/session-restore/sessions'
const MINUTE = 60_000

type Written = { path: string; text: string }

type WorldOptions = {
  /** The records in the sessions folder, by file name; the test may change them as it goes. */
  files?: Record<string, string>
  /** False: no OS variable, as on macOS and Linux. */
  windows?: boolean
  /** The first prompt's text; one starting with `<` is a slash command's, which gives no title. */
  prompt?: string
  /** The launcher's process fails with this on stderr. */
  launchFails?: string
}

/** Answers the session and its files beneath the plugin; what it writes, runs, logs and toasts is kept. */
function world(on: On, options: WorldOptions = {}) {
  const files = options.files ?? {}
  const written: Written[] = []
  const ran: string[][] = []
  const logs: string[] = []
  const toasts: string[] = []
  const session = { turns: 1, messageReads: 0, hold: undefined as Promise<void> | undefined }
  mock.env(on, options.windows === false ? { HOME: '/home/test' } : { OS: 'Windows_NT', USERPROFILE: HOME })
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'restore' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'own-session' }))
  on('session.turns', () => ({ value: session.turns }))
  on('session.root', () => ({ value: 'D:\\work\\app' }))
  on('session.cwd', () => ({ value: 'D:\\work\\app\\packages\\api' }))
  on('session.messages', async () => {
    session.messageReads++
    if (session.hold) await session.hold
    return { value: [{ role: 'user' as const, text: options.prompt ?? 'fix the band', toolUses: [] }] }
  })
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
    const fails = options.launchFails !== undefined && scriptOf(e.argv).includes('Start-Process')
    const done = { stdout: '', isStdoutTruncated: false, isStderrTruncated: false }

    return { value: { ...done, exitCode: fails ? 1 : 0, stderr: fails ? (options.launchFails ?? '') : '' } }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  return { files, written, ran, logs, toasts, session, clock }
}

/** The script a `powershell -EncodedCommand` call runs. */
function scriptOf(argv: readonly string[]): string {
  const raw = Uint8Array.from(atob(argv.at(-1) ?? ''), c => c.charCodeAt(0))
  let text = ''
  for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] ?? 0) | ((raw[i + 1] ?? 0) << 8))

  return text
}

function record(id: string, over: Partial<SessionRecord> = {}): string {
  const rec: SessionRecord = {
    id,
    cwd: `D:\\repos\\${id}`,
    status: 'interrupted',
    startedAt: NOW - 7_200_000,
    lastSeen: NOW - MINUTE,
    exe: 'C:\\bin\\claude.exe',
    flags: ['--model', 'opus'],
    ...over,
  }

  return JSON.stringify(rec)
}

function lastWrite(written: readonly Written[], id: string): SessionRecord {
  return JSON.parse(written.filter(one => one.path.endsWith(`${SESSIONS}/${id}.json`)).at(-1)?.text ?? '{}')
}

const START = { cwd: 'D:\\work\\app', surface: 'terminal', isInteractive: true } as const
const BAND = {
  plugin: 'session-restore',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

describe('the record', () => {
  test("a session's record keeps its project root, not where a shell cd took it", async ($, on) => {
    const { written, clock } = world(on)
    await $.session.start(START)
    await clock.settle()

    const rec = lastWrite(written, 'own-session')
    expect(rec.cwd).toBe('D:\\work\\app')
    expect(rec.status).toBe('open')
    expect(rec.title).toBe('fix the band')
  })

  test('a close that lands while a heartbeat waits stays closed (#3)', async ($, on) => {
    const { written, session, clock } = world(on, { windows: false })
    let release = () => {}
    session.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await $.session.start(START)
    await clock.settle()

    // The first sync waits on the messages for a title while the person leaves.
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'own-session' } as Parameters<
      typeof $.session.end
    >[0])
    release()
    await clock.settle()

    expect(lastWrite(written, 'own-session').status).toBe('closed')
  })

  test('the messages are read for a title only after a new turn (#4)', async ($, on) => {
    const { session, clock } = world(on, { windows: false, prompt: '<command-name>/model</command-name>' })
    await $.session.start(START)
    await clock.settle()
    await clock.advance(5 * MINUTE)
    expect(session.messageReads).toBe(1)

    session.turns = 2
    await clock.advance(MINUTE)
    expect(session.messageReads).toBe(2)
  })

  test('a process lookup that keeps failing is tried LOOKUP_TRIES times, not every minute (#4)', async ($, on) => {
    const { ran, clock } = world(on)
    await $.session.start(START)
    await clock.settle()
    await clock.advance(30 * MINUTE)

    const lookups = ran.filter(argv => scriptOf(argv).includes('ProcessId=$PID'))
    expect(lookups.length).toBe(5)
  })
})

describe('restoring', () => {
  test('/restore writes the plan beside the records and runs the launcher on it, its output in UTF-8', async ($, on) => {
    const { written, ran, clock } = world(on, { files: { 'cut-1.json': record('cut-1', { cwd: 'D:\\repos\\R&D' }) } })
    await $.session.start(START)
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
    expect(lastWrite(written, 'cut-1').status).toBe('restored')
  })

  test('the band restores only what is still cut off, and says what it left alone (#2, #1)', async ($, on) => {
    const { files, written, logs, clock } = world(on, {
      files: { 'cut-1.json': record('cut-1'), 'cut-2.json': record('cut-2') },
    })
    await $.session.start(START)
    await clock.settle()
    // Another session restores cut-1 while this one's band still lists both.
    files['cut-1.json'] = record('cut-1', { status: 'restored' })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'restore-all' })
    await clock.settle()

    const plan = JSON.parse(written.find(one => one.path.endsWith('/launch.json'))?.text ?? '{}')
    expect(plan.consoles.length).toBe(1)
    expect(plan.consoles[0].dir).toBe('D:\\repos\\cut-2')
    expect(logs.at(-1)).toBe(
      'Reopened 1 session in Windows Terminal.\n1 session was no longer cut off, so it was left alone.',
    )
    await band.unmount()
  })

  test("off Windows, the band's Restore all puts the commands in the transcript and marks nothing (#1)", async ($, on) => {
    const { written, logs, toasts, clock } = world(on, { windows: false, files: { 'cut-1.json': record('cut-1') } })
    await $.session.start(START)
    await clock.settle()

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'restore-all' })
    await clock.settle()

    expect(logs.at(-1)).toContain('Run these to reopen them:')
    expect(logs.at(-1)).toContain('claude --resume cut-1 --model opus')
    expect(toasts.at(-1)).toBe('The commands to reopen them are in the transcript')
    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-1.json`))).toBe(false)
    await band.unmount()
  })

  test('a launch that fails says why in the transcript, with a toast, and leaves the session offered (#1)', async ($, on) => {
    const { written, logs, toasts, clock } = world(on, {
      files: { 'cut-1.json': record('cut-1') },
      launchFails: 'Start-Process: access denied',
    })
    await $.session.start(START)
    await clock.settle()

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'restore-all' })
    await clock.settle()

    expect(logs.at(-1)).toBe('Could not open a terminal: exit 1: Start-Process: access denied')
    expect(toasts.at(-1)).toBe('Could not reopen the sessions: see the transcript')
    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-1.json`))).toBe(false)
    await band.unmount()
  })
})
