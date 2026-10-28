import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { SessionRecord } from '../types'
import type { Liveness, Shell } from './lib'
import {
  ago,
  encodePowerShell,
  HEARTBEAT_MS,
  isInterrupted,
  labelOf,
  launchPlan,
  launchScript,
  manualCommand,
  parseLiveness,
  pickResumeFlags,
  psString,
  splitCommandLine,
  statusForEnd,
  titleFromPrompt,
  UTF8_OUTPUT,
} from './lib'

type Engine = EngineInterface

/** What this process knows about itself; module variables, so a reload starts it over. */
type Ctx = {
  shell: Shell
  dir: string | null
  isWindows: boolean
  isTracking: boolean
  facts: Pick<SessionRecord, 'pid' | 'pidStarted' | 'exe' | 'flags'>
  /** This process's current session; /clear and /resume move it to a new id. */
  tracked: SessionRecord | null
}

const PANE = 'interrupted-sessions'
const SHELLS: readonly Shell[] = ['powershell', 'pwsh', 'cmd', 'none']
const interrupted = atom({ plugin: 'session-restore', key: 'interrupted' } as const, [])

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

async function setup($: Engine, ctx: Ctx): Promise<string> {
  if (ctx.dir !== null) return ctx.dir
  ctx.isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  ctx.dir = `${config}/session-restore/sessions`.replace(/\\/g, '/')

  return ctx.dir
}

async function save($: Engine, ctx: Ctx, rec: SessionRecord): Promise<void> {
  await $.fs.write(`${await setup($, ctx)}/${rec.id}.json`, JSON.stringify(rec, null, 2))
}

function runPowerShell($: Engine, script: string) {
  const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  const encoded = encodePowerShell(`${UTF8_OUTPUT}\n${script}`)

  return $.process.run([...argv, '-EncodedCommand', encoded], { timeoutMs: 30_000 })
}

async function firstPrompt($: Engine): Promise<string | undefined> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return undefined
  const first = messages.find(m => m.role === 'user' && m.text.trim() !== '' && !m.text.trimStart().startsWith('<'))

  return first === undefined ? undefined : titleFromPrompt(first.text)
}

/** Writes this session's record; a session with no prompt yet has no transcript to resume. */
async function sync($: Engine, ctx: Ctx): Promise<void> {
  if (!ctx.isTracking) return
  const id = await $.session.id()
  if (ctx.tracked?.id === id && ctx.tracked.status !== 'open') return
  if ((await $.session.turns()) === 0) return

  const now = await $.clock.now()
  if (ctx.tracked === null || ctx.tracked.id !== id) {
    // The project root, not cwd(): a shell `cd` in a tool moves cwd, and `claude --resume` finds the session only
    // from the folder it started in.
    ctx.tracked = { id, cwd: await $.session.root(), status: 'open', startedAt: now, lastSeen: now }
  }
  const title = ctx.tracked.title ?? (await firstPrompt($))
  ctx.tracked = { ...ctx.tracked, ...ctx.facts, title, status: 'open', lastSeen: now }
  await save($, ctx, ctx.tracked)
}

/**
 * Finds this session's claude process (its pid, start time and launch
 * flags) and prunes records untouched for two weeks. Windows only.
 */
async function identify($: Engine, ctx: Ctx): Promise<void> {
  if (!ctx.isWindows) return
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"`,
    `$found = $null`,
    `for ($i = 0; $i -lt 12 -and $p; $i++) {`,
    `  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"`,
    `  if ($p -and $p.Name -like 'claude*') { $found = $p } elseif ($found) { break }`,
    `}`,
    `if ($found) {`,
    `  $started = $found.CreationDate.ToUniversalTime().ToString('o')`,
    `  [pscustomobject]@{ pid = [int]$found.ProcessId; started = $started; exe = $found.ExecutablePath; cmd = $found.CommandLine } | ConvertTo-Json -Compress`,
    `}`,
    `$cut = (Get-Date).AddDays(-14)`,
    `Get-ChildItem -LiteralPath ${psString(await setup($, ctx))} -Filter *.json -ErrorAction SilentlyContinue |`,
    `  Where-Object { $_.LastWriteTime -lt $cut } | Remove-Item -ErrorAction SilentlyContinue`,
  ].join('\n')

  const { exitCode, stdout, stderr } = await runPowerShell($, script)
  const line = stdout.split(/\r?\n/).find(one => one.startsWith('{'))
  if (exitCode !== 0 || line === undefined) {
    $.ui.log(`session-restore: no claude process found (exit ${exitCode}): ${stdout.trim()} ${stderr.trim()}`, {
      to: 'debug',
    })
    return
  }
  const found = JSON.parse(line) as { pid: number; started: string; exe: string | null; cmd: string | null }
  ctx.facts = {
    pid: found.pid,
    pidStarted: found.started,
    exe: found.exe ?? undefined,
    flags: found.cmd === null ? [] : pickResumeFlags(splitCommandLine(found.cmd).slice(1)),
  }
}

async function liveness($: Engine, ctx: Ctx): Promise<Liveness | null> {
  if (!ctx.isWindows) return null
  const script = [
    `Get-CimInstance Win32_Process -Filter "Name like 'claude%'" | ForEach-Object {`,
    `  '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o')`,
    `}`,
  ].join('\n')
  try {
    const { exitCode, stdout } = await runPowerShell($, script)

    return exitCode === 0 ? parseLiveness(stdout) : null
  } catch {
    return null
  }
}

/** Reads every record and publishes the sessions that were cut off. */
async function scan($: Engine, ctx: Ctx): Promise<SessionRecord[]> {
  const folder = await setup($, ctx)
  const entries = await $.fs.list(folder).catch(() => [])
  const records: SessionRecord[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    try {
      records.push(JSON.parse(String(await $.fs.read(`${folder}/${entry.name}`))) as SessionRecord)
    } catch {
      // A record mid-write by another session; the next scan reads it.
    }
  }

  const ownId = await $.session.id()
  const others = records.filter(rec => rec.id !== ownId && rec.id !== ctx.tracked?.id)
  const alive = others.some(rec => rec.status === 'open') ? await liveness($, ctx) : null
  const now = await $.clock.now()
  const list = others.filter(rec => isInterrupted(rec, now, alive)).sort((a, b) => b.lastSeen - a.lastSeen)
  await update($, interrupted, () => list)

  return list
}

/**
 * Writes the plan beside the records and runs the launcher on it: the plan goes to PowerShell as a file, so no
 * folder or flag is ever part of a script, and many sessions don't make a command line too long to start.
 */
async function launch($: Engine, ctx: Ctx, recs: readonly SessionRecord[]): Promise<void> {
  const plan = `${(await setup($, ctx)).replace(/\/sessions$/, '')}/launch.json`
  await $.fs.write(plan, JSON.stringify(launchPlan(recs, ctx.shell), null, 2))
  const ran = await runPowerShell($, launchScript(plan))
  if (ran.exitCode !== 0) throw new Error(`exit ${ran.exitCode}: ${ran.stderr.trim().slice(0, 300)}`)
}

async function restore($: Engine, ctx: Ctx, ids: readonly string[]): Promise<string> {
  const chosen = (await read($, interrupted)).filter(rec => ids.includes(rec.id))
  if (chosen.length === 0) return 'No interrupted sessions to restore.'
  if (!ctx.isWindows) return ['Run these to reopen them:', ...chosen.map(manualCommand)].join('\n')

  const ready: SessionRecord[] = []
  const gone: SessionRecord[] = []
  for (const rec of chosen) ((await $.fs.exists(rec.cwd)) ? ready : gone).push(rec)

  const lines: string[] = []
  if (ready.length > 0) {
    try {
      await launch($, ctx, ready)
      for (const rec of ready) await save($, ctx, { ...rec, status: 'restored' })
      lines.push(`Reopened ${plural(ready.length, 'session')} in Windows Terminal.`)
      $.ui.toast(`Reopened ${plural(ready.length, 'session')}`)
    } catch (err) {
      lines.push(`Could not open a terminal: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const rec of gone) lines.push(`Skipped "${labelOf(rec)}": ${rec.cwd} no longer exists.`)
  await scan($, ctx)

  return lines.join('\n')
}

async function dismiss($: Engine, ctx: Ctx, ids: readonly string[]): Promise<number> {
  const chosen = (await read($, interrupted)).filter(rec => ids.includes(rec.id))
  for (const rec of chosen) await save($, ctx, { ...rec, status: 'dismissed' })
  await scan($, ctx)

  return chosen.length
}

/** Startup is busy (MCP servers spawning), so a lookup that fails is tried again each heartbeat. */
async function beat($: Engine, ctx: Ctx): Promise<void> {
  if (ctx.isWindows && ctx.facts.pid === undefined) {
    await identify($, ctx).catch(err => $.ui.log(`session-restore: identify failed: ${err}`, { to: 'debug' }))
  }
  await sync($, ctx)
}

async function track($: Engine, ctx: Ctx): Promise<void> {
  await setup($, ctx)
  await sync($, ctx)
  await beat($, ctx)
  await scan($, ctx)
  $.clock.every(HEARTBEAT_MS, () => void beat($, ctx).catch(() => undefined))
}

function openPane($: Engine): void {
  void $.ui.open({ id: PANE, title: 'Interrupted sessions' })
}

function listing(list: readonly SessionRecord[], now: number): string {
  const rows = list.map((rec, i) => `  ${i + 1}. ${labelOf(rec)} - ${rec.cwd}, last active ${ago(now - rec.lastSeen)}`)

  return [
    `${plural(list.length, 'interrupted session')}:`,
    ...rows,
    '',
    '/restore all reopens them, /restore 2 (or 1,3) reopens some, /restore forget drops them.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    shell: SHELLS.find(one => one === options.shell) ?? 'powershell',
    dir: null,
    isWindows: false,
    isTracking: false,
    facts: {},
    tracked: null,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'restore',
      description: 'Reopen Claude sessions cut off by a crash, restart or closed terminal',
      argumentHint: '[all | 1,2 | forget]',
    })
    // A session started from another's tool (a nested claude) keeps no transcript to resume.
    const isChild = Boolean(await $.env.get('CLAUDE_CODE_CHILD_SESSION'))
    ctx.isTracking = e.isInteractive && e.surface === 'terminal' && !isChild
    if (ctx.isTracking) void track($, ctx).catch(err => $.ui.log(`session-restore: ${err}`, { to: 'debug' }))

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void sync($, ctx).catch(() => undefined)

    return done
  })

  on('session.end', async ($, e, next) => {
    const rec = ctx.tracked
    if (rec !== null && rec.id === e.sessionId) {
      const now = await $.clock.now()
      ctx.tracked = { ...rec, status: statusForEnd(e.reason), endReason: e.reason, endedAt: now, lastSeen: now }
      await save($, ctx, ctx.tracked).catch(() => undefined)
      if (e.reason === 'clear' || e.reason === 'resume') ctx.tracked = null
    }

    return next(e)
  })

  on('command.run', { command: 'restore' }, async ($, e) => {
    const list = await scan($, ctx)
    const now = await $.clock.now()
    const arg = e.args.trim().toLowerCase()
    if (list.length === 0) return { text: 'No interrupted sessions.' }
    if (arg === 'all')
      return {
        text: await restore(
          $,
          ctx,
          list.map(rec => rec.id),
        ),
      }
    if (arg === 'forget') {
      const count = await dismiss(
        $,
        ctx,
        list.map(rec => rec.id),
      )

      return { text: `Forgot ${plural(count, 'interrupted session')}.` }
    }
    if (arg !== '') {
      const ids = arg
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(pick => (/^\d+$/.test(pick) ? list[Number(pick) - 1]?.id : list.find(rec => rec.id.startsWith(pick))?.id))
      if (ids.some(id => id === undefined))
        return { text: `No interrupted session matches "${arg}".\n\n${listing(list, now)}` }

      return { text: await restore($, ctx, ids as string[]) }
    }

    openPane($)

    return { text: listing(list, now) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, interrupted)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const ids = list.map(rec => rec.id)
    const names = list.slice(0, 3).map(labelOf).join(' · ')
    const more = list.length > 3 ? ` · +${list.length - 3} more` : ''

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color="warning">
            {list.length === 1 ? '1 Claude session was' : `${list.length} Claude sessions were`} cut off
          </Text>
          <Button key="restore-all" variant="primary" label="Restore all" onPress={() => void restore($, ctx, ids)} />
          <Button key="choose" label="Choose" onPress={() => openPane($)} />
          <Button key="dismiss" role="dismiss" label="Dismiss" onPress={() => void dismiss($, ctx, ids)} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {names}
          {more}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, interrupted)
    const now = await $.clock.now()
    if (list.length === 0) return <Text dimColor>No interrupted sessions.</Text>
    const ids = list.map(rec => rec.id)

    return (
      <Box flexDirection="column" gap={1}>
        {list.map(rec => (
          <Box key={`row-${rec.id}`} flexDirection="column">
            <Box gap={1}>
              <Button key={`restore-${rec.id}`} label="Restore" onPress={() => void restore($, ctx, [rec.id])} />
              <Text bold wrap="truncate-end">
                {labelOf(rec)}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-middle">
              {rec.cwd} · last active {ago(now - rec.lastSeen)}
              {rec.flags !== undefined && rec.flags.length > 0 ? ` · ${rec.flags.join(' ')}` : ''}
            </Text>
          </Box>
        ))}
        <Box gap={1}>
          <Button key="restore-all" variant="primary" label="Restore all" onPress={() => void restore($, ctx, ids)} />
          <Button key="forget-all" label="Forget all" onPress={() => void dismiss($, ctx, ids)} />
        </Box>
      </Box>
    )
  })
}
