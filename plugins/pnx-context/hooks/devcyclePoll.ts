// The engine side of the Dev cycles view: reads this machine's `pnx activity --json` and the server's live runs on a
// schedule and keeps the cut-down result in one atom. Nothing from pnx or the server is kept beyond devcycle.ts's fields.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DevCycles } from '../types'
import { call, type Cfg } from './api'
import { finishedNotice, parseActivity, parseLive } from './devcycle'
import { FIND_PNX, MIN_ACTIVITY_PNX, MISSING_RETRY_MS, WANT_ACTIVITY_PNX, isAtLeast, parseFind } from './worker'

/** How often the pane's timer calls pollDevCycles; each source keeps its own pace below. */
export const POLL_MS = 3_000
const LOCAL_BUSY_MS = 3_000
const LOCAL_IDLE_MS = 15_000
const CLOUD_BUSY_MS = 15_000
const CLOUD_IDLE_MS = 60_000

const EMPTY: DevCycles = { local: 'unknown', jobs: [], events: [], cloud: [] }
export const devCycles = atom({ plugin: 'pnx-context', key: 'devCycles' } as const, EMPTY, { shape: 'devcycles-1' })

let pnx: { cli?: string; version?: string; at: number } | undefined
let lastLocal = 0
let lastCloud = 0
let isPolling = false

/** Reads both sources at the next tick (a refresh, a new connection) and looks pnx up again. */
export const pollSoon = (): void => {
  pnx = undefined
  lastLocal = 0
  lastCloud = 0
}

/** A connection was dropped: nothing of it stays on screen. */
export function forgetDevCycles($: EngineInterface): Promise<unknown> {
  pollSoon()

  return update($, devCycles, () => EMPTY)
}

async function readLocal($: EngineInterface, now: number): Promise<Pick<DevCycles, 'local' | 'jobs' | 'events'>> {
  if (pnx === undefined || now - pnx.at >= MISSING_RETRY_MS) {
    const found = await $.process.run(['node', '-e', FIND_PNX], { timeoutMs: 20_000 }).then(r => parseFind(r.stdout)).catch((): { cli?: string; version?: string } => ({}))
    pnx = { ...found, at: now }
    // Tells pnx-fast-dev which pnx the log needs, so it checks at every start until it has it.
    if (found.cli === undefined || !isAtLeast(found.version, MIN_ACTIVITY_PNX)) await $.process.run(['node', '-e', WANT_ACTIVITY_PNX], { timeoutMs: 10_000 }).catch(() => undefined)
  }
  if (pnx.cli === undefined || !isAtLeast(pnx.version, MIN_ACTIVITY_PNX)) return { local: 'old', jobs: [], events: [] }
  // The command needs no key and makes no network call. Its text is parsed, never shown.
  const out = await $.process.run(['node', pnx.cli, 'activity', '--json'], { timeoutMs: 10_000 }).then(r => (r.exitCode === 0 ? parseActivity(r.stdout) : undefined)).catch(() => undefined)

  return out === undefined ? { local: 'failed', jobs: [], events: [] } : { local: 'ok', ...out }
}

/**
 * Reads whichever source is due: this machine's log every 3 s while a job runs or the Dev cycles view is open, else every
 * 15 s; the server's live runs every 15 s while one is live, else every 60 s. `notify` gets one line when a job seen
 * running here has finished or failed. Never throws.
 */
export async function pollDevCycles($: EngineInterface, cfg: Cfg, o: { isDevOpen: boolean; isCurrent: () => boolean; notify: (text: string, tone: 'success' | 'error') => Promise<unknown> }): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const now = await $.clock.now()
    const before = await read($, devCycles)
    const isLocalDue = now - lastLocal >= (o.isDevOpen || before.jobs.some(j => j.state === 'running') ? LOCAL_BUSY_MS : LOCAL_IDLE_MS)
    const isCloudDue = now - lastCloud >= (before.cloud.length > 0 ? CLOUD_BUSY_MS : CLOUD_IDLE_MS)
    if (!isLocalDue && !isCloudDue) return
    let next = before
    if (isLocalDue) {
      lastLocal = now
      next = { ...next, ...(await readLocal($, now)) }
    }
    if (isCloudDue) {
      lastCloud = now
      // A refused or failed read shows no cloud rows rather than old ones.
      next = { ...next, cloud: await call($, cfg, 'GET', '/api/catalog/catalog/dev-cycles/codegen/live').then(r => parseLive(r.data)).catch(() => []) }
    }
    if (!o.isCurrent() || JSON.stringify(next) === JSON.stringify(before)) return
    await update($, devCycles, () => next)
    const done = before.local === 'ok' ? finishedNotice(before.jobs, next.jobs) : undefined
    if (done !== undefined) await o.notify(done.text, done.tone)
  } catch {
    // The view is an extra: a failed poll leaves what was shown.
  } finally {
    isPolling = false
  }
}
