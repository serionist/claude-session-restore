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
  /** Off Windows: what `uname -s` answers, and the variables the terminal is chosen by. */
  unix?: { name: 'Darwin' | 'Linux'; env?: Record<string, string> }
  /** Off Windows: the terminal FIND answers, or none. */
  installed?: string
  /** Off Windows: what the process lookup prints. */
  lookup?: string
  /** Off Windows: the launch that fails, by a word in its script's path (the session's id). */
  failsFor?: string
  /** Off Windows: no claude this session can run (a path an update removed). */
  noClaude?: boolean
}

/** Answers the session and its files beneath the plugin; what it writes, runs, logs and toasts is kept. */
function world(on: On, options: WorldOptions = {}) {
  const files = options.files ?? {}
  const written: Written[] = []
  const ran: string[][] = []
  const logs: string[] = []
  const toasts: string[] = []
  /** When each process lookup ran, by the mocked clock. */
  const lookupsAt: number[] = []
  const session = {
    id: 'own-session',
    turns: 1,
    messageReads: 0,
    /** Holds the messages' answer until it settles. */
    hold: undefined as Promise<void> | undefined,
    /** Holds each write of a record saved `open` until it settles. */
    holdOpen: undefined as Promise<void> | undefined,
    /** What the process listing answers: `<pid> <start time>` lines of the claude processes running. */
    alive: '',
  }
  const unixEnv = { HOME: '/home/test', ...options.unix?.env }
  mock.env(on, options.windows === false || options.unix ? unixEnv : { OS: 'Windows_NT', USERPROFILE: HOME })
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'restore' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: session.id }))
  on('session.turns', () => ({ value: session.turns }))
  on('session.root', () => ({ value: 'D:\\work\\app' }))
  on('session.cwd', () => ({ value: 'D:\\work\\app\\packages\\api' }))
  on('session.messages', async () => {
    session.messageReads++
    if (session.hold) await session.hold
    return { value: [{ role: 'user' as const, text: options.prompt ?? 'fix the band', toolUses: [] }] }
  })
  // The engine hands a path on in the system's own separators. A record written is what the next scan reads.
  on('fs.write', async (_, e) => {
    if (session.holdOpen && e.text.includes('"status": "open"')) await session.holdOpen
    const path = e.path.replace(/\\/g, '/')
    written.push({ path, text: e.text })
    if (path.includes(`${SESSIONS}/`)) files[path.split('/').at(-1) ?? ''] = e.text
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: NOW, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: files[e.path.split(/[\\/]/).at(-1) ?? ''] ?? '' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const done = { isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] !== 'powershell.exe') return { value: { ...done, ...unixAnswer(e.argv, options, session.alive) } }
    const script = scriptOf(e.argv)
    if (script.includes('ProcessId=$PID')) lookupsAt.push(clock.now())
    const fails = options.launchFails !== undefined && script.includes('Start-Process')
    const stdout = script.includes("Name like 'claude%'") ? session.alive : ''

    return { value: { ...done, stdout, exitCode: fails ? 1 : 0, stderr: fails ? (options.launchFails ?? '') : '' } }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  return { files, written, ran, logs, toasts, session, clock, lookupsAt }
}

/** What a process off Windows answers: `uname`, the scripts by what they do, and a terminal's launch. */
function unixAnswer(argv: readonly string[], options: WorldOptions, alive: string) {
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  if (argv[0] === 'uname') return ok(options.unix?.name ?? '')
  const script = argv[0] === '/bin/sh' && argv[1] === '-c' ? (argv[2] ?? '') : ''
  if (script.includes('command -v "$t"'))
    return ok(argv.slice(4).includes(options.installed ?? '') ? options.installed : '')
  if (script === 'command -v claude') return ok(options.noClaude ? '' : '/home/test/.local/bin/claude')
  if (script === 'test -x "$1"') return options.noClaude ? { exitCode: 1, stdout: '', stderr: '' } : ok()
  if (script.includes('found_exe')) return ok(options.lookup ?? '')
  if (script.includes('ps -A -o pid=,lstart=')) return ok(alive)
  // A launch, which ends with the script's path.
  if (options.failsFor !== undefined && argv.at(-1)?.includes(options.failsFor)) {
    return { exitCode: 1, stdout: '', stderr: 'no window' }
  }

  return ok()
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

  test('a close is never overtaken by a save asked for before it (#3)', async ($, on) => {
    const { written, session, clock } = world(on, { windows: false })
    let release = () => {}
    session.holdOpen = new Promise<void>(resolve => {
      release = resolve
    })
    await $.session.start(START)
    await clock.settle()

    // The first save, `open`, is still being written when the person leaves; the close is asked for before it lands.
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 'own-session' } as Parameters<
      typeof $.session.end
    >[0])
    await clock.settle()
    release()
    await ending
    await clock.settle()

    expect(written.filter(one => one.path.endsWith(`${SESSIONS}/own-session.json`)).length).toBe(2)
    expect(lastWrite(written, 'own-session').status).toBe('closed')
  })

  test('after /exit, a heartbeat before the process ends writes nothing', async ($, on) => {
    const { written, clock } = world(on, { windows: false })
    await $.session.start(START)
    await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'own-session' } as Parameters<
      typeof $.session.end
    >[0])
    const writes = written.length

    await clock.advance(2 * MINUTE)

    expect(written.length).toBe(writes)
    expect(lastWrite(written, 'own-session').status).toBe('closed')
  })

  test('a session /clear left, then resumed in the same process, is tracked again and offered when cut off', async ($, on) => {
    const { written, session, clock } = world(on, { windows: false })
    type End = Parameters<typeof $.session.end>[0]
    await $.session.start(START)
    await clock.settle()

    await $.session.end({ reason: 'clear', sessionId: 'own-session' } as End)
    session.id = 'second'
    await clock.advance(MINUTE)
    await $.session.end({ reason: 'resume', sessionId: 'second' } as End)
    session.id = 'own-session'
    await $.classic.SessionStart({ source: 'resume' })
    await clock.settle()
    await $.session.end({ reason: 'other', sessionId: 'own-session' } as End)
    await clock.settle()

    expect(lastWrite(written, 'second').status).toBe('closed')
    expect(lastWrite(written, 'own-session').status).toBe('interrupted')
  })

  test("after a /resume in this process, the picked session's record is written as soon as it is in place", async ($, on) => {
    const { written, session, clock } = world(on, { windows: false })
    await $.session.start(START)
    await clock.settle()

    await $.session.end({ reason: 'resume', sessionId: 'own-session' } as Parameters<typeof $.session.end>[0])
    session.id = 'picked'
    await $.classic.SessionStart({ source: 'resume' })
    await clock.settle()

    expect(lastWrite(written, 'picked').status).toBe('open')
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

  test('a process lookup that keeps failing is tried at minutes 0, 1, 3, 7 and 15, then no more (#4)', async ($, on) => {
    const { lookupsAt, clock } = world(on)
    await $.session.start(START)
    await clock.settle()
    await clock.advance(30 * MINUTE)

    expect(lookupsAt.map(at => (at - NOW) / MINUTE)).toEqual([0, 1, 3, 7, 15])
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

    expect(text).toBe('Reopened 1 session.')
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
    expect(logs.slice(-2)).toEqual(['Reopened 1 session.', '1 session was no longer cut off, so it was left alone.'])
    await band.unmount()
  })

  test('the band leaves alone a session resumed by hand: its record is open, and its process runs (#2)', async ($, on) => {
    const { files, written, logs, session, clock } = world(on, {
      files: { 'cut-1.json': record('cut-1'), 'cut-2.json': record('cut-2') },
    })
    await $.session.start(START)
    await clock.settle()
    // The person resumed cut-1 in another terminal: its record is open again, under a claude that runs.
    files['cut-1.json'] = record('cut-1', { status: 'open', pid: 42, pidStarted: '2026-10-28T10:00:00.0000000Z' })
    session.alive = '42 2026-10-28T10:00:00.0000000Z'

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'restore-all' })
    await clock.settle()

    const plan = JSON.parse(written.find(one => one.path.endsWith('/launch.json'))?.text ?? '{}')
    expect(plan.consoles.map((one: { dir: string }) => one.dir)).toEqual(['D:\\repos\\cut-2'])
    expect(logs.at(-1)).toBe('1 session was no longer cut off, so it was left alone.')
    await band.unmount()
  })

  test("the band's Dismiss scans first: a session restored elsewhere keeps its mark (#2)", async ($, on) => {
    const { files, written, clock } = world(on, {
      files: { 'cut-1.json': record('cut-1'), 'cut-2.json': record('cut-2') },
    })
    await $.session.start(START)
    await clock.settle()
    files['cut-1.json'] = record('cut-1', { status: 'restored' })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'dismiss' })
    await clock.settle()

    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-1.json`))).toBe(false)
    expect(lastWrite(written, 'cut-2').status).toBe('dismissed')
    await band.unmount()
  })

  test('two restores at once open each session once: the second scans after the first marked them', async ($, on) => {
    const { ran, clock } = world(on, { files: { 'cut-1.json': record('cut-1') } })
    await $.session.start(START)
    await clock.settle()

    const run = { command: 'restore', args: 'all' } as Parameters<typeof $.command.run>[0]
    const [first, second] = await Promise.all([$.command.run(run), $.command.run(run)])
    await clock.settle()

    expect(ran.filter(argv => scriptOf(argv).includes('Start-Process')).length).toBe(1)
    expect([first.text, second.text].sort()).toEqual([
      '1 session was no longer cut off, so it was left alone.',
      'Reopened 1 session.',
    ])
  })

  test('/restore 1,1 names one session twice, and reopens it once without saying any was left alone', async ($, on) => {
    const { ran, clock } = world(on, { files: { 'cut-1.json': record('cut-1') } })
    await $.session.start(START)
    await clock.settle()

    const run = { command: 'restore', args: '1,1' } as Parameters<typeof $.command.run>[0]
    const { text } = await $.command.run(run)

    expect(text).toBe('Reopened 1 session.')
    expect(ran.filter(argv => scriptOf(argv).includes('Start-Process')).length).toBe(1)
  })

  test('off Windows, a click with no commands to run says so without a toast about commands', async ($, on) => {
    const { files, logs, toasts, clock } = world(on, { windows: false, files: { 'cut-1.json': record('cut-1') } })
    await $.session.start(START)
    await clock.settle()
    // The person resumed cut-1 by hand: its record is open and fresh, so it is no longer cut off.
    files['cut-1.json'] = record('cut-1', { status: 'open', lastSeen: NOW })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'restore-all' })
    await clock.settle()

    expect(logs.at(-1)).toBe('1 session was no longer cut off, so it was left alone.')
    expect(toasts.includes('The commands to reopen them are in the transcript')).toBe(false)
    await band.unmount()
  })

  test("off Windows, the band's Restore all puts the commands in the transcript and marks nothing (#1)", async ($, on) => {
    const { written, logs, toasts, clock } = world(on, { windows: false, files: { 'cut-1.json': record('cut-1') } })
    await $.session.start(START)
    await clock.settle()

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'restore-all' })
    await clock.settle()

    expect(logs.slice(-2)).toEqual([
      'Run these to reopen them:',
      "cd 'D:\\repos\\cut-1' && claude --resume cut-1 --model opus",
    ])
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

describe('restoring on macOS and Linux', () => {
  const RUN = { command: 'restore', args: 'all' }
  const LINUX = { name: 'Linux', env: { DISPLAY: ':0' } } as const
  const unixRecord = (id: string, over: Partial<SessionRecord> = {}) =>
    record(id, {
      cwd: `/home/test/r&d x'$(calc)'/${id}`,
      exe: '/home/test/.local/share/claude/versions/2.1.306',
      ...over,
    })
  const scriptOf = (written: readonly Written[], id: string) =>
    written.find(one => one.path.endsWith(`/session-restore/launch/${id}.sh`))?.text ?? ''

  test('on a Linux desktop, the first terminal installed opens a script that cds and resumes, started apart', async ($, on) => {
    const { written, ran, clock } = world(on, {
      unix: LINUX,
      installed: 'x-terminal-emulator',
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])
    await clock.settle()

    expect(text).toBe('Reopened 1 session in x-terminal-emulator.')
    const script = scriptOf(written, 'cut-1')
    expect(script.split('\n')[0]).toBe("cd '/home/test/r&d x'\\''$(calc)'\\''/cut-1' || exit 1")
    expect(script).toContain('/home/test/.local/bin/claude --resume cut-1 --model opus\n')
    expect(script).toContain(`exec "\${SHELL:-/bin/sh}" -l`)
    const launch = ran.at(-1) ?? []
    expect(launch.slice(0, 4)).toEqual(['/bin/sh', '-c', launch[2] ?? '', 'sh'])
    expect(launch[2]).toContain('setsid -f "$@"')
    expect(launch.slice(4, 7)).toEqual(['x-terminal-emulator', '-e', '/bin/sh'])
    expect(launch.at(-1)?.endsWith('/session-restore/launch/cut-1.sh')).toBe(true)
    expect(launch.some(part => part.includes('r&d'))).toBe(false)
    expect(lastWrite(written, 'cut-1').status).toBe('restored')
  })

  test('inside tmux, a new tmux window, with no folder flag tmux would read as a format', async ($, on) => {
    const { ran, clock } = world(on, {
      unix: { name: 'Linux', env: { TMUX: '/tmp/tmux-1/default,1,0' } },
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    const launch = ran.at(-1) ?? []
    expect(launch.slice(0, 3)).toEqual(['tmux', 'new-window', '/bin/sh'])
    expect(launch.length).toBe(4)
  })

  test('on macOS, Terminal, or iTerm2 when this session runs in it; the script path reaches AppleScript as argv', async ($, on) => {
    const { ran, clock } = world(on, {
      unix: { name: 'Darwin', env: { TERM_PROGRAM: 'iTerm.app' } },
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect(text).toBe('Reopened 1 session in iTerm2.')
    const launch = ran.at(-1) ?? []
    expect(launch[0]).toBe('osascript')
    expect(launch).toContain('tell application "iTerm2"')
    expect(launch.slice(0, -1).some(part => part.includes('cut-1') || part.includes('r&d'))).toBe(false)
  })

  test('over SSH, or with no display, the commands are printed and nothing is marked', async ($, on) => {
    const { written, clock } = world(on, {
      unix: { name: 'Linux', env: { DISPLAY: ':0', SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } },
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect((text ?? '').split('\n').slice(0, 2)).toEqual([
      'No terminal opened: this session runs over SSH, and a window would open on the other machine.',
      'Run these to reopen them:',
    ])
    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-1.json`))).toBe(false)
  })

  test('the terminal option print prints the commands', { options: { terminal: 'print' } }, async ($, on) => {
    const { clock } = world(on, { unix: LINUX, installed: 'xterm', files: { 'cut-1.json': unixRecord('cut-1') } })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect((text ?? '').split('\n')[0]).toBe('No terminal opened: the terminal option is print.')
  })

  test(
    'a terminal the option names but this system lacks prints the commands and says why',
    { options: { terminal: 'iterm' } },
    async ($, on) => {
      const { clock } = world(on, { unix: LINUX, files: { 'cut-1.json': unixRecord('cut-1') } })
      await $.session.start(START)
      await clock.settle()

      const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

      expect((text ?? '').split('\n')[0]).toBe('No terminal opened: iTerm2 runs only on macOS.')
    },
  )

  test('each session is marked once its own window opened; one that failed is named with its command', async ($, on) => {
    const { written, toasts, clock } = world(on, {
      unix: LINUX,
      installed: 'xterm',
      files: { 'cut-1.json': unixRecord('cut-1'), 'cut-2.json': unixRecord('cut-2') },
      failsFor: 'cut-2',
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect(lastWrite(written, 'cut-1').status).toBe('restored')
    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-2.json`))).toBe(false)
    expect(text).toContain('Reopened 1 session in xterm.')
    expect(text).toContain('Could not open xterm for "cut-2": exit 1: no window')
    expect(text).toContain("  Run: cd '/home/test/r&d x'\\''$(calc)'\\''/cut-2' && claude --resume cut-2 --model opus")
    expect(toasts).toContain('Could not reopen some sessions: see the transcript')
  })

  test('the restoring session keeps its config folder in the window, so --resume finds the session', async ($, on) => {
    const { written, clock } = world(on, {
      unix: { name: 'Linux', env: { DISPLAY: ':0', CLAUDE_CONFIG_DIR: "/home/test/.claude work's" } },
      installed: 'xterm',
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect(scriptOf(written, 'cut-1')).toContain("export CLAUDE_CONFIG_DIR='/home/test/.claude work'\\''s'")
  })

  test('the lookup off Windows records the process, its start and, on Linux, its flags', async ($, on) => {
    const args = btoa(['/home/test/.local/bin/claude', '--model', 'opus', 'fix it', ''].join('\0'))
    const lookup = `pid 4242\nstarted b00t:123\nexe64 ${btoa('/home/test/.local/share/claude/versions/2.1.306')}\nargs64 ${args}\n`
    const { written, clock } = world(on, { unix: LINUX, lookup })
    await $.session.start(START)
    await clock.settle()

    const own = lastWrite(written, 'own-session')
    expect(own.pid).toBe(4242)
    expect(own.pidStarted).toBe('b00t:123')
    expect(own.flags).toEqual(['--model', 'opus'])
  })

  test('a session whose process still runs is not offered off Windows, asleep or not', async ($, on) => {
    const live = unixRecord('cut-1', { status: 'open', pid: 42, pidStarted: 'b00t:7', lastSeen: NOW - 30 * MINUTE })
    const { session, clock } = world(on, { unix: LINUX, files: { 'cut-1.json': live } })
    session.alive = '42 b00t:7\n43 b00t:9\n'
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run({ command: 'restore', args: '' } as Parameters<typeof $.command.run>[0])

    expect(text).toBe('No interrupted sessions.')
  })
})

describe('choosing where a session opens, off Windows', () => {
  const RUN = { command: 'restore', args: 'all' }
  const unixRecord = (id: string, over: Partial<SessionRecord> = {}) =>
    record(id, { cwd: `/home/test/${id}`, exe: '/home/test/.local/share/claude/versions/2.1.306', ...over })

  test('Linux with no display and no SSH prints the commands: there is no display', async ($, on) => {
    const { clock } = world(on, {
      unix: { name: 'Linux' },
      installed: 'xterm',
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect((text ?? '').split('\n')[0]).toBe('No terminal opened: there is no display.')
  })

  test('a terminal the option names needs a display too', { options: { terminal: 'xterm' } }, async ($, on) => {
    const { written, clock } = world(on, {
      unix: { name: 'Linux', env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } },
      installed: 'xterm',
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect((text ?? '').split('\n')[0]).toBe('No terminal opened: there is no display.')
    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-1.json`))).toBe(false)
  })

  test('a terminal the option names but not installed says so', { options: { terminal: 'xterm' } }, async ($, on) => {
    const { clock } = world(on, {
      unix: { name: 'Linux', env: { DISPLAY: ':0' } },
      installed: 'kitty',
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect((text ?? '').split('\n')[0]).toBe('No terminal opened: xterm is not installed.')
  })

  test('inside tmux over SSH, tmux opens the window: it runs on the machine the person is on', async ($, on) => {
    const env = { TMUX: '/tmp/tmux-1/default,1,0', SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' }
    const { ran, clock } = world(on, { unix: { name: 'Linux', env }, files: { 'cut-1.json': unixRecord('cut-1') } })
    await $.session.start(START)
    await clock.settle()

    await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect((ran.at(-1) ?? []).slice(0, 2)).toEqual(['tmux', 'new-window'])
  })

  test('on macOS, iTerm2 is known by LC_TERMINAL too, which survives tmux and SSH', async ($, on) => {
    const { ran, clock } = world(on, {
      unix: { name: 'Darwin', env: { LC_TERMINAL: 'iTerm2' } },
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect(ran.at(-1)).toContain('tell application "iTerm2"')
  })

  test('a session whose claude no longer runs is printed, not opened and not marked', async ($, on) => {
    const { written, ran, clock } = world(on, {
      unix: { name: 'Linux', env: { DISPLAY: ':0' } },
      installed: 'xterm',
      noClaude: true,
      files: { 'cut-1.json': unixRecord('cut-1') },
    })
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run(RUN as Parameters<typeof $.command.run>[0])

    expect(text).toContain('Could not open "cut-1": no claude this session can run')
    expect(text).toContain('  Run: cd /home/test/cut-1 && claude --resume cut-1 --model opus')
    expect(ran.some(argv => argv.at(-1)?.endsWith('.sh'))).toBe(false)
    expect(written.some(one => one.path.endsWith(`${SESSIONS}/cut-1.json`))).toBe(false)
  })

  test('an empty process listing is no listing: a session is then judged by its heartbeat', async ($, on) => {
    const quiet = unixRecord('cut-1', { status: 'open', pid: 42, pidStarted: 'm|7', lastSeen: NOW - 30_000 })
    const { session, clock } = world(on, { unix: { name: 'Linux' }, files: { 'cut-1.json': quiet } })
    session.alive = ''
    await $.session.start(START)
    await clock.settle()

    const { text } = await $.command.run({ command: 'restore', args: '' } as Parameters<typeof $.command.run>[0])

    expect(text).toBe('No interrupted sessions.')
  })
})
