/**
 * open: the session's process is (or was last seen) running.
 * closed: the person left on purpose (/exit, ctrl+c, /clear, /resume, logout).
 * interrupted: the session ended on a signal (terminal closed, shutdown).
 * restored: reopened by this mod; the resumed process marks it open again.
 * dismissed: the person chose not to restore it.
 */
export type SessionStatus = 'open' | 'closed' | 'interrupted' | 'restored' | 'dismissed'

/** One session as written to `<config>/session-restore/sessions/<id>.json`. */
export type SessionRecord = {
  id: string
  cwd: string
  title?: string
  status: SessionStatus
  startedAt: number
  lastSeen: number
  endedAt?: number
  endReason?: string
  /** The claude process, so a later scan can tell whether it still runs. */
  pid?: number
  pidStarted?: string
  exe?: string
  /** Launch flags worth repeating on resume (--model, --add-dir, ...). */
  flags?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-restore': { interrupted: SessionRecord[] }
  }
}
