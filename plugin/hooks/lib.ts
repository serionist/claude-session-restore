import type { SessionRecord, SessionStatus } from '../types'

export const HEARTBEAT_MS = 60_000
/** Without a process to check, a session silent this long is taken as gone. */
export const STALE_MS = 5 * 60_000
/** Sessions cut off longer ago than this are no longer offered. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** Restored tabs all land in one Windows Terminal window of this name. */
export const WT_WINDOW = 'claude-restore'

export type Shell = 'powershell' | 'pwsh' | 'cmd' | 'none'

/** Running claude processes: pid to process start time (ISO, UTC). */
export type Liveness = ReadonlyMap<number, string>

/**
 * `other` is a signal (SIGHUP when the terminal closes, SIGTERM at
 * shutdown); every other reason is the person leaving on purpose.
 */
export function statusForEnd(reason: string): SessionStatus {
  return reason === 'other' ? 'interrupted' : 'closed'
}

/**
 * Whether a session should be offered for restore: it ended on a signal, or
 * it never ended and its process is gone. A pid alone is not proof, since
 * Windows reuses them; the process start time must match too.
 */
export function isInterrupted(rec: SessionRecord, now: number, alive: Liveness | null): boolean {
  if (now - rec.lastSeen > MAX_AGE_MS) return false
  if (rec.status === 'interrupted') return true
  if (rec.status !== 'open') return false
  if (alive !== null && rec.pid !== undefined && rec.pidStarted !== undefined) {
    return alive.get(rec.pid) !== rec.pidStarted
  }

  return now - rec.lastSeen > STALE_MS
}

/** Splits a Windows command line the way the C runtime does. */
export function splitCommandLine(line: string): string[] {
  const args: string[] = []
  let current = ''
  let isQuoted = false
  let hasArg = false

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') {
      let count = 0
      while (line[i] === '\\') {
        count++
        i++
      }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) current += '"'
        else isQuoted = !isQuoted
      } else {
        current += '\\'.repeat(count)
        i--
      }
      hasArg = true
    } else if (c === '"') {
      isQuoted = !isQuoted
      hasArg = true
    } else if (!isQuoted && (c === ' ' || c === '\t')) {
      if (hasArg) args.push(current)
      current = ''
      hasArg = false
    } else {
      current += c
      hasArg = true
    }
  }
  if (hasArg) args.push(current)

  return args
}

const SWITCH_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--chrome',
  '--no-chrome',
  '--strict-mcp-config',
  '--verbose',
])
const VALUE_FLAGS = new Set([
  '--model',
  '--fallback-model',
  '--permission-mode',
  '--agent',
  '--settings',
  '--plugin-dir',
])
const LIST_FLAGS = new Set([
  '--add-dir',
  '--mcp-config',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
])

/**
 * Keeps the launch flags that shape a session and are safe to repeat on
 * resume; drops the rest (a first prompt, -c, --resume, -p, ...).
 */
export function pickResumeFlags(args: readonly string[]): string[] {
  const kept: string[] = []
  let i = 0

  while (i < args.length) {
    const arg = args[i++] ?? ''
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg

    if (SWITCH_FLAGS.has(name)) {
      kept.push(arg)
      continue
    }
    if (!VALUE_FLAGS.has(name) && !LIST_FLAGS.has(name)) continue
    if (eq > 0) {
      kept.push(arg)
      continue
    }

    const values: string[] = []
    let value = args[i]
    while (value !== undefined && !value.startsWith('-') && (values.length === 0 || LIST_FLAGS.has(name))) {
      values.push(value)
      value = args[++i]
    }
    if (values.length > 0) kept.push(name, ...values)
  }

  return kept
}

/**
 * The claude command line that resumes a record. Flags come back only with the path of the claude that had them: a
 * bare `claude` may be npm's `claude.cmd`, through which cmd would read them.
 */
export function claudeArgv(rec: SessionRecord): string[] {
  return rec.exe === undefined ? ['claude', '--resume', rec.id] : [rec.exe, '--resume', rec.id, ...(rec.flags ?? [])]
}

/**
 * A PowerShell expression whose value is the text. The text travels as base64, which holds no quote, `$`, `;` or
 * space, so no character of a folder, a flag or a path is ever read as PowerShell. Doubling `'` is not enough:
 * PowerShell takes the curly quotes U+2018 to U+201B for quotes too.
 */
export function psString(text: string): string {
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(new TextEncoder().encode(text))}')))`
}

/**
 * The script a restored tab's PowerShell runs: into the session's folder, then the program, every part as data, then
 * `after` when given. PowerShell before 7.3, and in Legacy mode, hands a native program its arguments without escaping
 * their double quotes, and without doubling the backslashes that end one it wraps in quotes; the script does both for
 * it, so the program reads each argument back whole.
 */
export function runArgvScript(argv: readonly string[], dir: string, after?: string): string {
  const [exe = 'claude', ...args] = argv

  return [
    // A profile may have moved the shell, and --resume finds a session only from the folder it started in.
    `Set-Location -LiteralPath ${psString(dir)}`,
    `$exe = ${psString(exe)}`,
    // A bare name runs the program on PATH, never npm's claude.ps1, which a Restricted execution policy refuses.
    `if (-not [IO.Path]::IsPathRooted($exe)) {`,
    `  $app = Get-Command $exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `  if ($app) { $exe = $app.Source }`,
    `}`,
    `$rest = @(${args.map(psString).join(', ')})`,
    `$passing = Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue`,
    `if ($null -eq $passing -or $passing -eq 'Legacy') {`,
    `  $rest = @($rest | ForEach-Object {`,
    `    $arg = $_ -replace '(\\\\*)"', '$1$1\\"'`,
    `    if ($arg -match '\\s') { $arg -replace '(\\\\+)$', '$1$1' } else { $arg }`,
    `  })`,
    `}`,
    `& $exe $rest`,
    ...(after === undefined ? [] : [after]),
  ].join('\n')
}

/** What the `cmd` option leaves the tab in once claude exits: cmd, started by the tab's PowerShell. */
const THEN_CMD = `& $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })`

/**
 * The command a restored tab runs: claude inside the chosen shell. Each part is a fixed word or base64, so Windows
 * Terminal and the C runtime pass it through as it is. `cmd` and `none` run claude in a PowerShell without a profile,
 * which then starts cmd or ends with claude: cmd never reads a folder or a flag, nor a line past its 8,191 characters.
 */
export function tabArgv(rec: SessionRecord, shell: Shell): string[] {
  const dir = cleanDir(rec.cwd)
  const argv = claudeArgv(rec)
  if (shell === 'cmd') {
    return ['powershell.exe', '-NoProfile', '-EncodedCommand', encodePowerShell(runArgvScript(argv, dir, THEN_CMD))]
  }
  const encoded = encodePowerShell(runArgvScript(argv, dir))
  if (shell === 'pwsh') return ['pwsh.exe', '-NoExit', '-EncodedCommand', encoded]
  if (shell === 'none') return ['powershell.exe', '-NoProfile', '-EncodedCommand', encoded]

  return ['powershell.exe', '-NoExit', '-EncodedCommand', encoded]
}

/** A drive root keeps its slash; any other folder loses a trailing one. */
export function cleanDir(dir: string): string {
  return /^[A-Za-z]:[\\/]$/.test(dir) ? dir : dir.replace(/[\\/]+$/, '')
}

export function folderName(dir: string): string {
  return cleanDir(dir).split(/[\\/]/).pop() || dir
}

/** One argument as the C runtime and CommandLineToArgvW read it back, the way splitCommandLine does. */
export function crtQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const c of arg) {
    if (c === '\\') {
      slashes++
      continue
    }
    out += c === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${c}`
    slashes = 0
  }

  return `${out}${'\\'.repeat(slashes * 2)}"`
}

/** Windows Terminal splits its own arguments on `;`; `\;` keeps one. */
function wtEscape(arg: string): string {
  return arg.replace(/;/g, '\\;')
}

/** The longest Windows Terminal command line one call takes; CreateProcess allows 32,767 characters. */
export const WT_LINE_MAX = 30_000

/**
 * Windows Terminal's arguments for every session, a tab each in one window: one line per call, so that many sessions
 * take several calls rather than one command line too long to start.
 */
export function wtLines(recs: readonly SessionRecord[], shell: Shell): string[] {
  const lines: string[] = []
  let line = ''
  for (const rec of recs) {
    const tab = ['new-tab', '--title', folderName(rec.cwd), '-d', cleanDir(rec.cwd), ...tabArgv(rec, shell)]
    const part = tab.map(arg => crtQuote(wtEscape(arg))).join(' ')
    if (line !== '' && line.length + 3 + part.length > WT_LINE_MAX) {
      lines.push(line)
      line = ''
    }
    line = line === '' ? `-w ${WT_WINDOW} ${part}` : `${line} ; ${part}`
  }
  if (line !== '') lines.push(line)

  return lines
}

/** A session's console window, where there is no Windows Terminal: the program, its arguments, its folder. */
export type ConsoleStart = { file: string; args: string; dir: string }

export function consoleStarts(recs: readonly SessionRecord[], shell: Shell): ConsoleStart[] {
  return recs.map(rec => {
    const [file = 'powershell.exe', ...args] = tabArgv(rec, shell)

    return { file, args: args.map(crtQuote).join(' '), dir: cleanDir(rec.cwd) }
  })
}

/**
 * Variables a session sets for the processes it starts. Windows Terminal
 * hands the caller's environment to new tabs, and a claude that sees them
 * runs as a child session, which keeps no transcript.
 */
export const SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
]

/** What the launcher reads: the variables to clear, Windows Terminal's lines, and the console windows otherwise. */
export type LaunchPlan = { env: string[]; wt: string[]; consoles: ConsoleStart[] }

export function launchPlan(recs: readonly SessionRecord[], shell: Shell): LaunchPlan {
  return { env: SESSION_ENV, wt: wtLines(recs, shell), consoles: consoleStarts(recs, shell) }
}

/**
 * A PowerShell script that opens the plan written at planPath: it clears SESSION_ENV, then starts Windows Terminal
 * once per line, or a console window per session where there is none. Start-Process hands the new processes none of
 * this one's handles, so the call that runs the script returns at once rather than waiting for the sessions to end.
 */
export function launchScript(planPath: string): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  $plan = Get-Content -Raw -Encoding UTF8 -LiteralPath ${psString(planPath)} | ConvertFrom-Json`,
    `  foreach ($name in $plan.env) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }`,
    `  $wt = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `  if ($wt) {`,
    `    foreach ($line in $plan.wt) { Start-Process -FilePath $wt.Source -ArgumentList $line }`,
    `    exit 0`,
    `  }`,
    // Start-Process reads a working directory as a wildcard pattern: `[old] api` would match nothing, or a sibling.
    `  foreach ($one in $plan.consoles) {`,
    `    $dir = [Management.Automation.WildcardPattern]::Escape($one.dir)`,
    `    Start-Process -FilePath $one.file -ArgumentList $one.args -WorkingDirectory $dir`,
    `  }`,
    `} catch {`,
    // Plain text: Windows PowerShell may write an uncaught error as CLIXML, which the message to the person can't use.
    `  [Console]::Error.WriteLine($_.Exception.Message)`,
    `  exit 1`,
    `}`,
  ].join('\n')
}

/** What to type by hand where this mod cannot open a terminal itself. */
export function manualCommand(rec: SessionRecord): string {
  const quote = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

  return `cd ${quote(rec.cwd)} && ${['claude', ...claudeArgv(rec).slice(1)].map(quote).join(' ')}`
}

export function labelOf(rec: SessionRecord): string {
  return rec.title ?? folderName(rec.cwd)
}

/** The first line of a prompt, cut to fit a list row. */
export function titleFromPrompt(text: string): string | undefined {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(part => part.length > 0)
  if (line === undefined) return undefined

  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`

  return `${Math.round(hours / 24)} d ago`
}

/** Parses `<pid> <start time>` lines into Liveness. */
export function parseLiveness(stdout: string): Map<number, string> {
  const alive = new Map<number, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, started] = line.trim().split(' ')
    if (pid && started) alive.set(Number(pid), started)
  }

  return alive
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The first line of every script the plugin runs to read its output. Windows PowerShell writes to a pipe in the
 * console's code page, which turns a path like C:\Users\Sóma into C:\Users\S?ma; UTF-8 output keeps it whole.
 */
export const UTF8_OUTPUT = 'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }'

/** A script as `powershell -EncodedCommand` takes it: UTF-16LE, base64. */
export function encodePowerShell(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes.push(code & 0xff, code >> 8)
  }

  return base64(bytes)
}

function base64(bytes: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }

  return out
}
