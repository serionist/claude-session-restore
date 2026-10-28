import type { SessionRecord, SessionStatus } from '../types'

export const HEARTBEAT_MS = 60_000
/** Process lookups a session tries, at heartbeats 0, 1, 3, 7 and 15: the minutes its MCP servers may take to start. */
export const LOOKUP_TRIES = 5
/** Without a process to check, a session silent this long is taken as gone. */
export const STALE_MS = 5 * 60_000
/** Sessions cut off longer ago than this are no longer offered. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** Restored tabs all land in one Windows Terminal window of this name. */
export const WT_WINDOW = 'claude-restore'

export type Shell = 'powershell' | 'pwsh' | 'cmd' | 'none'

/**
 * Running processes: pid to start. On Windows the start time (ISO, UTC); on macOS and Linux `<machine>|<start>`,
 * where the machine (a boot, and on Linux a pid namespace) tells apart a record of another machine sharing the folder.
 */
export type Liveness = ReadonlyMap<number, string>

/** The machine a start names, `<machine>|...`; undefined for a start that names none (Windows). */
export function machineOf(started: string): string | undefined {
  const bar = started.indexOf('|')

  return bar < 0 ? undefined : started.slice(0, bar)
}

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
    // A record from another machine sharing the folder (an NFS home, a container mounting ~/.claude): its pid means
    // nothing in this listing, so its heartbeat decides.
    const machine = machineOf(rec.pidStarted)
    const here = machine === undefined || [...alive.values()].some(started => machineOf(started) === machine)
    if (here) return alive.get(rec.pid) !== rec.pidStarted
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
  if (/^[A-Za-z]:[\\/]$/.test(dir)) return dir
  // `/` alone stays: without it, the root would become no folder at all.
  return dir.replace(/[\\/]+$/, '') || dir
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

/** Parses `<pid> <start time>` lines into Liveness; a start time may hold spaces, as `ps` writes it off Windows. */
export function parseLiveness(stdout: string): Map<number, string> {
  const alive = new Map<number, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) alive.set(Number(match[1]), squeeze(match[2]))
  }

  return alive
}

/** Runs of spaces as one: `ps` pads a day of the month, and two listings must agree to the character. */
export function squeeze(text: string): string {
  return text.trim().split(/\s+/).join(' ')
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

// macOS and Linux: the script a restored window runs, the terminals that open it, and the process lookup. A folder,
// a flag or a path reaches a shell only single-quoted (posixQuote) inside the script, and the script's path reaches
// each terminal as an argument of its own, AppleScript only through its run handler's argument. No terminal gets the
// folder: tmux reads `-c` as a format, where `#(...)` runs a command, and the script's own `cd` sets it anyway.

/**
 * A word as a POSIX shell reads it back whole: a plain word as it is, any other single-quoted, `'` written `'\''`.
 * Nothing else is special inside single quotes.
 */
export function posixQuote(word: string): string {
  return /^[\w./:@=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** What to type by hand where this plugin opens no terminal itself. */
export function manualCommand(rec: SessionRecord): string {
  return `cd ${posixQuote(rec.cwd)} && ${['claude', ...claudeArgv(rec).slice(1)].map(posixQuote).join(' ')}`
}

/** Where a restored session opens off Windows: a terminal the plugin drives, or the commands printed. */
export type Terminal =
  | 'auto'
  | 'terminal'
  | 'iterm'
  | 'tmux'
  | 'x-terminal-emulator'
  | 'gnome-terminal'
  | 'ptyxis'
  | 'konsole'
  | 'kitty'
  | 'wezterm'
  | 'alacritty'
  | 'xterm'
  | 'print'

/** A terminal the plugin opens a window in. */
export type OpenTerminal = Exclude<Terminal, 'auto' | 'print'>

/**
 * The desktop terminals tried on Linux, in this order: Debian's and Ubuntu's own choice first, then GNOME's two (Ptyxis
 * on Ubuntu 25.10 and Fedora 41 and later), KDE's, and the common ones.
 */
export const LINUX_TERMINALS: readonly OpenTerminal[] = [
  'x-terminal-emulator',
  'gnome-terminal',
  'ptyxis',
  'konsole',
  'kitty',
  'wezterm',
  'alacritty',
  'xterm',
]

/** Every value of the `terminal` option, as plugin.json lists them. */
export const TERMINALS: readonly Terminal[] = ['auto', 'terminal', 'iterm', 'tmux', ...LINUX_TERMINALS, 'print']

/** How each terminal is named to the person. */
export function terminalName(terminal: OpenTerminal): string {
  return terminal === 'terminal' ? 'Terminal' : terminal === 'iterm' ? 'iTerm2' : terminal
}

/** What the restoring session knows that a new window doesn't: the claude it runs, and its config folder. */
export type ScriptEnv = { claude?: string; configDir?: string }

/**
 * The script a restored window runs off Windows, as `/bin/sh <script>`: into the session's folder, the session
 * variables cleared (a claude that sees them runs as a child session, with no transcript), the restoring session's
 * config folder kept (else `--resume` looks in `~/.claude` and finds nothing), claude, then the person's login shell
 * unless the shell option is none. The claude is the one on the restoring session's PATH, not the versioned file a
 * lookup finds, which an update replaces.
 */
export function sessionScript(rec: SessionRecord, shell: Shell, env: ScriptEnv = {}): string {
  const argv = claudeArgv(env.claude === undefined ? rec : { ...rec, exe: env.claude })

  return [
    `cd ${posixQuote(cleanDir(rec.cwd))} || exit 1`,
    `unset ${SESSION_ENV.join(' ')}`,
    ...(env.configDir === undefined ? [] : [`export CLAUDE_CONFIG_DIR=${posixQuote(env.configDir)}`]),
    argv.map(posixQuote).join(' '),
    ...(shell === 'none' ? [] : [`exec "\${SHELL:-/bin/sh}" -l`]),
    '',
  ].join('\n')
}

/**
 * The AppleScript that opens a window running `exec /bin/sh <script>`, the script's path given as the run handler's
 * argument: it never enters the source, and `quoted form of` single-quotes it for the shell the window starts.
 */
export function appleScript(app: 'terminal' | 'iterm'): string[] {
  const command = '"exec /bin/sh " & quoted form of (item 1 of argv)'
  const body =
    app === 'terminal'
      ? ['tell application "Terminal"', 'activate', `do script ${command}`, 'end tell']
      : [
          'tell application "iTerm2"',
          'activate',
          'set restored to (create window with default profile)',
          `tell current session of restored to write text ${command}`,
          'end tell',
        ]

  return ['on run argv', ...body, 'end run']
}

/** The process that opens a window running `/bin/sh <script>`: fixed words, and the script's path as one argument. */
export function terminalArgv(terminal: OpenTerminal, script: string): string[] {
  switch (terminal) {
    case 'terminal':
    case 'iterm':
      return ['osascript', ...appleScript(terminal).flatMap(line => ['-e', line]), script]
    case 'tmux':
      return ['tmux', 'new-window', '/bin/sh', script]
    case 'x-terminal-emulator':
      return ['x-terminal-emulator', '-e', '/bin/sh', script]
    case 'gnome-terminal':
      return ['gnome-terminal', '--', '/bin/sh', script]
    case 'ptyxis':
      return ['ptyxis', '--new-window', '--', '/bin/sh', script]
    case 'konsole':
      return ['konsole', '-e', '/bin/sh', script]
    case 'kitty':
      return ['kitty', '/bin/sh', script]
    case 'wezterm':
      return ['wezterm', 'start', '--', '/bin/sh', script]
    case 'alacritty':
      return ['alacritty', '-e', '/bin/sh', script]
    case 'xterm':
      return ['xterm', '-e', '/bin/sh', script]
  }
}

/** Terminals whose command returns once the window is open, and says when it could not open it. */
export function returnsAtOnce(terminal: OpenTerminal): boolean {
  return terminal === 'terminal' || terminal === 'iterm' || terminal === 'tmux'
}

/**
 * Runs its arguments as a program apart from this process and its session, its output nowhere, and returns at once:
 * the desktop terminals run until their window closes (Debian's x-terminal-emulator waits on purpose), and a call
 * held past its time is killed, the restored claude with it. `setsid -f`, else `nohup ... &` where there is no setsid
 * or it has no `-f` (busybox). The program and its arguments arrive as "$@", never as text the shell reads.
 */
export const DETACH =
  'if command -v setsid >/dev/null 2>&1 && setsid -f "$@" </dev/null >/dev/null 2>&1; then :; ' +
  'else nohup "$@" </dev/null >/dev/null 2>&1 & fi'

export function detached(argv: readonly string[]): string[] {
  return ['/bin/sh', '-c', DETACH, 'sh', ...argv]
}

/** Prints the first of its arguments that is a command on PATH. */
export const FIND = 'for t in "$@"; do if command -v "$t" >/dev/null 2>&1; then echo "$t"; exit 0; fi; done'

/** Prints the path of the claude on PATH. */
export const WHICH_CLAUDE = 'command -v claude'

/** Succeeds when its argument is a program this session can run. */
export const RUNNABLE = 'test -x "$1"'

/**
 * Shell functions the lookup and the listing share. A start is `<machine>|<start>`: the machine is the boot and, on
 * Linux, the pid namespace, so a record of another machine sharing the folder (an NFS home, a container mounting
 * ~/.claude) is never judged by this one's pids. On Linux the start is the tick the process started at, from /proc:
 * `ps` derives its start time from the wall clock, so a clock stepped after a laptop wakes would make every running
 * session look gone. On macOS it is `ps`'s start time in UTC, which macOS stores as it was. On Linux nothing here
 * needs `ps`, which slim containers lack.
 */
const SHARED = [
  'machine() {',
  '  if [ -r /proc/sys/kernel/random/boot_id ]; then',
  '    read -r boot < /proc/sys/kernel/random/boot_id',
  '    echo "$boot/$(readlink /proc/self/ns/pid 2>/dev/null)"',
  '  else',
  '    sysctl -n kern.bootsessionuuid 2>/dev/null',
  '  fi',
  '}',
  // The fields of /proc/<pid>/stat after the command's name, field 2, which may hold spaces and parentheses: the
  // fields are counted after its last `) `. `shift` is a special builtin, whose failure would end the script. The
  // field's number is kept first, since `set --` replaces the function's own arguments.
  'field() {',
  '  n=$1',
  '  set -f',
  `  set -- \${2##*) }`,
  '  set +f',
  '  if [ "$#" -ge "$n" ]; then shift $((n - 1)); echo "$1"; fi',
  '}',
  'started() {',
  '  if read -r stat 2>/dev/null < "/proc/$1/stat"; then',
  '    t=$(field 20 "$stat")',
  '    if [ -n "$t" ]; then echo "$(machine)|$t"; fi',
  '  else',
  '    echo "$(machine)|$(TZ=UTC0 LC_ALL=C ps -o lstart= -p "$1")"',
  '  fi',
  '}',
  'parent() {',
  '  if read -r stat 2>/dev/null < "/proc/$1/stat"; then field 2 "$stat"; else ps -o ppid= -p "$1" 2>/dev/null; fi',
  '}',
].join('\n')

/**
 * Finds this session's claude process off Windows, run as `sh -c LOOKUP sh <records folder> <scripts folder>`: walks
 * up from its own pid to the nearest ancestor that is claude (named claude, or a file under `claude/versions/`, where
 * the native installer keeps each version), on through any claude above it, and prints its pid, its start, its path
 * and, where /proc has them, its exact arguments, the last two in base64. Then prunes the records and the scripts
 * untouched for 14 days, the folders given as arguments, never written into the script.
 */
export const LOOKUP = [
  SHARED,
  'p=$$',
  'found=',
  'i=0',
  'while [ "$i" -lt 16 ]; do',
  '  i=$((i + 1))',
  '  p=$(parent "$p" | tr -d " ")',
  '  case "$p" in ""|0|1) break ;; esac',
  '  if [ -r "/proc/$p/exe" ]; then exe=$(readlink "/proc/$p/exe"); else exe=$(ps -o comm= -p "$p"); fi',
  '  case "$exe" in',
  '    claude|*/claude|*/claude/versions/*) found=$p; found_exe=$exe ;;',
  '    *) if [ -n "$found" ]; then break; fi ;;',
  '  esac',
  'done',
  'if [ -n "$found" ]; then',
  '  echo "pid $found"',
  '  echo "started $(started "$found")"',
  '  printf "exe64 %s\\n" "$(printf %s "$found_exe" | base64 | tr -d "\\n")"',
  '  if [ -r "/proc/$found/cmdline" ]; then',
  '    printf "args64 %s\\n" "$(base64 < "/proc/$found/cmdline" | tr -d "\\n")"',
  '  fi',
  'fi',
  'find "$1" -name "*.json" -mtime +14 -exec rm -f {} + 2>/dev/null',
  'find "$2" -name "*.sh" -mtime +14 -exec rm -f {} + 2>/dev/null',
  'exit 0',
].join('\n')

/** Every running process, `<pid> <machine>|<start>`, as LOOKUP writes a start. */
export const PROCESSES = [
  SHARED,
  'm=$(machine)',
  'if [ -r /proc/sys/kernel/random/boot_id ]; then',
  // No subshell per process: a busy machine runs hundreds, and the listing runs at every scan.
  '  for d in /proc/[0-9]*; do',
  '    read -r stat 2>/dev/null < "$d/stat" || continue',
  '    set -f',
  `    set -- \${stat##*) }`,
  '    set +f',
  `    if [ "$#" -ge 20 ]; then shift 19; echo "\${d#/proc/} $m|$1"; fi`,
  '  done',
  'else',
  '  TZ=UTC0 LC_ALL=C ps -A -o pid=,lstart= | while read -r pid rest; do echo "$pid $m|$rest"; done',
  'fi',
  'exit 0',
].join('\n')

/** What LOOKUP found: the claude process, its start time, its path and, on Linux, its arguments past the program. */
export type Lookup = { pid: number; started: string; exe?: string; args?: string[] }

/** Reads LOOKUP's output; undefined when it found no claude. */
export function parseLookup(stdout: string): Lookup | undefined {
  const fields = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\w+) (.*)$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) fields.set(match[1], match[2])
  }
  const pid = Number(fields.get('pid'))
  const started = squeeze(fields.get('started') ?? '')
  if (!Number.isInteger(pid) || pid <= 0 || started === '') return undefined
  const exe64 = fields.get('exe64')
  const args64 = fields.get('args64')
  // /proc's arguments each end with a NUL, the program first.
  const args = args64 === undefined ? undefined : utf8(args64).split('\0').slice(1, -1)

  return { pid, started, exe: exe64 ? utf8(exe64) : undefined, args }
}

function utf8(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))
}
