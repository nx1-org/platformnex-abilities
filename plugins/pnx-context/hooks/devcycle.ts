// Pure parts of the Dev cycles view: `pnx activity --json` (this machine's own log), cut down to named, capped fields,
// and how it reads in the pane. It is untrusted: control characters are stripped, anything that looks like a secret
// is dropped, and pnx's own error text is never shown.
import type { ClaudeCode, DevEvent, DevJob } from '../types'
import { cap } from './lib'

const MAX_OUT = 200_000
const MAX_JOBS = 10
const MAX_EVENTS = 30
/** A finished job older than this is no longer news. */
const FINISHED_KEEP_MS = 60 * 60_000

/** pnx's own redaction list, applied again here: a field holding one of these is dropped whole. */
const SECRET = /pnxr_|pnxd_|pnx_|ghp_|gho_|github_pat_|Bearer |eyJ|-----BEGIN/
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/
const PHASES = ['cloning', 'splitting', 'writing', 'integrating', 'checking', 'committing', 'opening_pr', 'drafting']
const FINISHED = ['done', 'failed', 'cancelled', 'interrupted']

const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = cap(v, max)

  return s === '' || SECRET.test(s) ? undefined : s
}
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 99_999) : 0)
const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN

  return Number.isFinite(t) ? t : undefined
}
const prNumber = (v: unknown): number | undefined => {
  const hit = typeof v === 'string' ? /\/pull\/(\d{1,7})(?:$|[/?#])/.exec(v) : null

  return hit === null ? undefined : Number(hit[1])
}

/** What `pnx activity --json` printed, or undefined for anything else (an error object, junk, an older shape). */
export function parseActivity(stdout: string): { jobs: DevJob[]; events: DevEvent[] } | undefined {
  if (stdout.length > MAX_OUT) return undefined
  let o: Record<string, unknown> | undefined
  try {
    o = obj(JSON.parse(stdout.trim()))
  } catch {
    return undefined
  }
  if (o === undefined || o['v'] !== 1) return undefined
  const jobs: DevJob[] = []
  for (const raw of Array.isArray(o['jobs']) ? o['jobs'].slice(0, MAX_JOBS) : []) {
    const j = obj(raw)
    const id = text(j?.['id'], 80)
    const state = typeof j?.['state'] === 'string' && (j['state'] === 'running' || FINISHED.includes(j['state'])) ? (j['state'] as DevJob['state']) : undefined
    if (j === undefined || id === undefined || state === undefined) continue
    const repo = typeof j['repo'] === 'string' && REPO.test(j['repo']) && !SECRET.test(j['repo']) ? j['repo'] : undefined
    jobs.push({
      id,
      title: text(j['title'], 80) ?? 'Dev cycle',
      repo,
      state,
      phase: typeof j['phase'] === 'string' && PHASES.includes(j['phase']) ? j['phase'] : undefined,
      files: count(j['filesChanged']),
      startedAt: time(j['startedAt']),
      endedAt: time(j['endedAt']),
      pr: prNumber(j['prUrl']),
      reason: text(j['reason'], 40),
    })
  }
  const events: DevEvent[] = []
  for (const raw of Array.isArray(o['events']) ? o['events'].slice(-MAX_EVENTS) : []) {
    const e = obj(raw)
    const at = time(e?.['at'])
    const line = text(e?.['text'], 160)
    if (e === undefined || at === undefined || line === undefined) continue
    events.push({ at, level: e['level'] === 'error' || e['level'] === 'warn' ? e['level'] : 'info', text: line })
  }

  return { jobs, events }
}

/** Running first, then the rest; a finished job from long ago is left out. */
export function visibleJobs(local: DevJob[], now: number): DevJob[] {
  const all = local.filter(j => !FINISHED.includes(j.state) || now - (j.endedAt ?? j.startedAt ?? now) < FINISHED_KEEP_MS)

  return [...all.filter(j => !FINISHED.includes(j.state)), ...all.filter(j => FINISHED.includes(j.state))]
}

const minutes = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / 60_000)

  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export type Row = { mark: string; tone: 'success' | 'error' | undefined; left: string; right: string; sub: string }

/** One job as two short lines: mark and title with a short status on the right, then repo, where, elapsed. */
export function rowOf(job: DevJob, now: number, width: number): Row {
  const n = job.files
  const right =
    job.state === 'running'
      ? `${(job.phase ?? 'working').replace(/_/g, ' ')}${n > 0 ? ` ${n} file${n === 1 ? '' : 's'}` : ''}`
      : job.state === 'done'
        ? job.pr === undefined ? 'done' : `PR #${job.pr}`
        : job.state === 'failed'
          ? job.reason ?? 'failed'
          : job.state
  const mark = job.state === 'running' ? '◐' : job.state === 'done' ? '✓' : job.state === 'failed' || job.state === 'interrupted' ? '✕' : '⊘'
  const tone = job.state === 'done' ? 'success' : job.state === 'failed' || job.state === 'interrupted' ? 'error' : undefined
  const shownRight = cap(right, Math.max(6, Math.floor(width / 2)))
  const elapsed = job.startedAt === undefined ? undefined : minutes((job.endedAt ?? now) - job.startedAt)
  const sub = [job.repo, 'this machine', elapsed].filter((p): p is string => p !== undefined).join(' · ')

  return { mark, tone, left: cap(`${mark} ${job.title}`, Math.max(8, width - shownRight.length - 1)), right: shownRight, sub: `  ${cap(sub, Math.max(4, width - 2))}` }
}

const two = (n: number): string => String(n).padStart(2, '0')

/** The last `count` events as `HH:MM  text` (the machine's local time), newest first, so the latest is at the top. */
export function logLines(events: DevEvent[], count: number, width: number): { text: string; level: DevEvent['level'] }[] {
  return events.slice(-count).reverse().map(e => ({ text: `${two(new Date(e.at).getHours())}:${two(new Date(e.at).getMinutes())}  ${cap(e.text, Math.max(4, width - 7))}`, level: e.level }))
}

/** One line for the notice area when a job seen running last time has now finished or failed. */
export function finishedNotice(before: DevJob[], after: DevJob[]): { text: string; tone: 'success' | 'error' } | undefined {
  for (const b of before) {
    if (b.state !== 'running') continue
    const a = after.find(j => j.id === b.id)
    if (a === undefined || a.state === 'running' || a.state === 'cancelled') continue
    if (a.state === 'done') return { text: cap(`Dev cycle done: ${a.title}${a.pr === undefined ? '' : ` · PR #${a.pr}`}`, 120), tone: 'success' }

    return { text: cap(`Dev cycle failed: ${a.title} · ${a.state === 'interrupted' ? 'interrupted' : a.reason ?? 'failed'}`, 120), tone: 'error' }
  }

  return undefined
}

/** The Dev cycles view's live badge: `◐N` while N jobs run, `✕` for a failure not yet seen (never while the view is open), else nothing. */
export function badge(local: DevJob[], seenAt: number | undefined, isOpen: boolean, now: number): string {
  const jobs = visibleJobs(local, now)
  const running = jobs.filter(j => j.state === 'running').length
  const isUnseen = !isOpen && jobs.some(j => (j.state === 'failed' || j.state === 'interrupted') && (j.endedAt ?? j.startedAt ?? 0) > (seenAt ?? 0))

  return [running > 0 ? `◐${running}` : '', isUnseen ? '✕' : ''].filter(p => p !== '').join(' ')
}

/**
 * The line the Dev cycles view shows about this machine's worker, so an empty view never claims "nothing running" when the
 * worker is off, still connecting or failing. undefined means the worker is online and the view may say nothing is running.
 * The reason is the worker's own last note, capped and dropped if it looks like a secret.
 */
export function devStatus(w: { isOff: boolean; cc: ClaudeCode; width: number }): { text: string; tone: 'warning' | undefined } | undefined {
  if (w.isOff) return { text: 'Dev cycles are turned off in settings.', tone: undefined }
  if (w.cc.status === 'connecting') return { text: 'Connecting this machine to dev cycles…', tone: undefined }
  if (w.cc.status === 'online') return undefined
  const why = text(w.cc.note, 140)

  return { text: cap(`○ Not connected on this machine${why === undefined ? '' : `: ${why}`}. Press k for the full check.`, w.width * 2), tone: 'warning' }
}
