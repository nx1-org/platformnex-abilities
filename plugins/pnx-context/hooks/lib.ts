// Pure helpers: no engine calls, so they can be checked on their own.
import type { Environment, Health, Release, ReleasePhase } from '../types'

/** Short, one line, no control characters; anything shown from a server goes through this. */
export const cap = (text: unknown, max: number): string => {
  const one = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`
}

/** Removes any `user:token@` from a remote so a login never reaches the screen, state or the server. */
export const cleanRemote = (url: string): string =>
  url
    .trim()
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1')

/** The spelling the gateway compares with: ssh form, `.git`, case and trailing slashes removed. */
export const normalizeRepoUrl = (url: string): string =>
  cleanRemote(url)
    .replace(/\/+$/, '')
    .toLowerCase()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')

/** Whether this looks like `https://host/owner/name` or `git@host:owner/name`, which is all the gateway takes. */
export const isRepoUrl = (url: string): boolean => /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+|git@[^:\s]+:[^/\s]+\/[^/\s]+)\/?$/i.test(url)

/** The key goes only to https, or to this machine while developing. */
export const safeBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const url = value.trim().replace(/\/+$/, '')
  if (/^https:\/\/[^/\s?#@]+$/i.test(url)) return url
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) return url

  return undefined
}

export type ScannedRepo = { root: string; remote?: string; branch?: string; head?: string }

/**
 * One spelling of a folder on every OS, for comparing and keeping: forward slashes, a lower-case drive letter, no
 * trailing slash (`C:\work\x\` → `c:/work/x`). macOS and Linux paths pass through unchanged.
 */
export const normalizePath = (path: string): string => {
  const slashed = path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
  const trimmed = slashed.replace(/\/+$/, '')

  // A root keeps its slash: `/`, `c:/`.
  return trimmed === '' ? '/' : /^[a-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed
}

/** Whether a path is absolute on any OS: `/home/x`, `C:\x`, `c:/x` or a `\\server\share` path. */
export const isAbsolutePath = (path: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)

/** What the repository scan read for one folder (with git): its remote, branch and short commit. */
export const scannedRepo = (root: string, remote: string, branch: string, head: string): ScannedRepo => ({
  root: normalizePath(root),
  remote: remote.trim() === '' ? undefined : cleanRemote(remote),
  branch: branch.trim() === '' || branch.trim() === 'HEAD' ? undefined : branch.trim(),
  head: head.trim() === '' ? undefined : head.trim(),
})

/**
 * One entry for each distinct remote (a worktree repeats its repository); the shortest path wins,
 * except that the folder containing `cwd` always wins, so the worktree you are in is the one shown.
 */
export const dedupeByRemote = (repos: ScannedRepo[], cwd?: string): ScannedRepo[] => {
  const seen = new Map<string, ScannedRepo>()
  const holdsCwd = (repo: ScannedRepo) => cwd !== undefined && rootContaining(cwd, [repo.root]) !== undefined
  for (const repo of [...repos].sort((a, b) => Number(holdsCwd(b)) - Number(holdsCwd(a)) || a.root.length - b.root.length)) {
    const key = repo.remote === undefined ? `path:${repo.root}` : normalizeRepoUrl(repo.remote)
    if (!seen.has(key)) seen.set(key, repo)
  }

  return [...seen.values()]
}

/**
 * The repository whose folder contains this path, the deepest one when they nest; the root as `roots` spells it.
 * Either may be spelled the Windows way (`C:\work\x`); Windows paths compare without regard to case, as Windows does.
 */
export const rootContaining = (path: string, roots: string[]): string | undefined => {
  const comparable = (p: string) => {
    const n = normalizePath(p)

    return /^[a-z]:/.test(n) ? n.toLowerCase() : n
  }
  const target = comparable(path)

  return [...roots]
    .sort((a, b) => b.length - a.length)
    .find(root => {
      const r = comparable(root)

      return target === r || target.startsWith(r.endsWith('/') ? r : `${r}/`)
    })
}

export const baseName = (path: string): string => normalizePath(path).split('/').pop() || path

/** `https://host/x` JSON with either envelope: `{success, data}` or the body itself. */
export const unwrap = (text: string): unknown => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (body !== null && typeof body === 'object' && 'success' in body) {
    const wrapped = body as { success: unknown; data?: unknown }

    return wrapped.success === true ? wrapped.data : undefined
  }

  return body
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const parseEnvironments = (value: unknown): Environment[] =>
  asArray(value).flatMap(raw => {
    const one = asRecord(raw)
    const id = Number(one?.['id'])

    return one !== undefined && Number.isInteger(id) && str(one['name']) !== undefined
      ? [{ id, name: cap(one['name'], 40), isProduction: one['isProduction'] === true }]
      : []
  })

export type ParsedMatch = {
  entityRef: string
  name: string
  title?: string
  systemRefs: string[]
  environments: Environment[]
}

export const parseByRepo = (data: unknown): ParsedMatch[] =>
  asArray(asRecord(data)?.['items']).flatMap(raw => {
    const one = asRecord(raw)
    const entityRef = str(one?.['entityRef'])
    const name = str(one?.['name'])
    if (one === undefined || entityRef === undefined || name === undefined) return []

    return [
      {
        entityRef,
        name: cap(name, 60),
        title: str(one['title']) === undefined ? undefined : cap(one['title'], 60),
        systemRefs: asArray(one['systemRefs']).filter((v): v is string => typeof v === 'string'),
        environments: parseEnvironments(one['environments']),
      },
    ]
  })

/** `system:default/scalenex` -> `default/scalenex`, else undefined. */
export const systemPath = (systemRef: string): string | undefined => {
  const hit = /^system:([^/\s]+)\/([^/\s]+)$/i.exec(systemRef)

  return hit === null ? undefined : `${hit[1]}/${hit[2]}`
}

const word = (status: unknown): string => (typeof status === 'string' && status !== '' ? status : 'unknown')

/** The component's own status when the System's health names it, else the System's. */
export const parseHealth = (data: unknown, entityRef: string): Health | undefined => {
  const root = asRecord(data)
  const current = asRecord(root?.['current'])
  if (current === undefined) return undefined

  const own = asArray(current['components'])
    .map(asRecord)
    .find(c => c?.['entityRef'] === entityRef)
  const reasons = asArray(current['reasons'])
    .map(r => (typeof r === 'string' ? r : str(asRecord(r)?.['message'])))
    .filter((r): r is string => r !== undefined)
    .slice(0, 3)
    .map(r => cap(r, 110))

  return {
    status: word(own?.['status'] ?? current['status']),
    computedAt: str(current['computed_at']),
    reasons,
    history: asArray(root?.['history']).map(h => word(asRecord(h)?.['status'])).slice(-14),
  }
}

const time = (value: unknown): number | undefined => {
  const text = str(value)
  const at = text === undefined ? Number.NaN : Date.parse(text)

  return Number.isNaN(at) ? undefined : at
}

/** Release sessions as the list route returns them, newest first, cut down to what the pane draws. */
export const parseReleases = (data: unknown): Release[] =>
  asArray(asRecord(data)?.['items']).flatMap(raw => {
    const one = asRecord(raw)
    const id = str(one?.['id'])
    if (one === undefined || id === undefined) return []
    const environmentId = Number(one['environment_id'])
    const rollout = str(asRecord(one['rollout'])?.['state'])

    return [
      {
        id,
        status: cap(one['status'], 24),
        environment: str(one['environment_name']) === undefined ? undefined : cap(one['environment_name'], 30),
        environmentId: Number.isInteger(environmentId) ? environmentId : undefined,
        target: str(one['target_ref']) === undefined ? undefined : cap(one['target_ref'], 40),
        sha: str(one['target_sha'])?.slice(0, 7),
        kind: str(one['kind']) === undefined ? undefined : cap(one['kind'], 12),
        currentPhase: str(one['current_phase']) === undefined ? undefined : cap(one['current_phase'], 24),
        createdAt: time(one['created_at']),
        updatedAt: time(one['updated_at']),
        completedAt: time(one['completed_at']),
        tagPushedAt: time(one['tag_pushed_at']),
        hasBuild: str(one['pipeline_run_id']) !== undefined,
        isBuildMissing: asRecord(one['build_recovery']) !== undefined,
        rollout: rollout === undefined ? undefined : cap(rollout.replace(/_/g, ' '), 24),
        outcome: str(one['outcome']) === undefined ? undefined : cap(one['outcome'], 110),
      },
    ]
  })

/** The phases of one release session (GET /releases/:id), in the order the gateway sends them. */
export const parsePhases = (data: unknown): ReleasePhase[] =>
  asArray(asRecord(data)?.['phases']).flatMap(raw => {
    const one = asRecord(raw)
    const phase = str(one?.['phase'])
    if (one === undefined || phase === undefined) return []

    return [{ phase: cap(phase, 24), status: cap(one['status'], 16), staleReason: str(one['stale_reason']) === undefined ? undefined : cap(one['stale_reason'], 110) }]
  })

const OPEN_STATUSES = ['draft', 'reviewing', 'ready', 'awaiting_approval', 'deploying']

export const isOpenRelease = (r: Release): boolean => OPEN_STATUSES.includes(r.status)

/** A deploy was asked for and has not finished. */
export const isDeploying = (r: Release): boolean => r.status === 'deploying' || r.status === 'awaiting_approval'

/** How long after a deploy ends the Live view still shows it. */
export const LIVE_WINDOW_MS = 30 * 60_000

/** What Live shows: a deploy under way, else the one that ended most recently within the window. */
export const liveRelease = (releases: Release[], now: number): Release | undefined =>
  releases.find(isDeploying) ??
  releases
    .filter(r => (r.status === 'succeeded' || r.status === 'failed') && r.completedAt !== undefined && now - r.completedAt <= LIVE_WINDOW_MS)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0]

/** The open release the Release view shows: one being reviewed first, else any open one. */
export const reviewRelease = (releases: Release[]): Release | undefined => releases.find(r => isOpenRelease(r) && !isDeploying(r)) ?? releases.find(isOpenRelease)

export type Step = { label: string; state: 'done' | 'now' | 'todo' | 'failed'; note?: string }

/**
 * A deploy as steps, from what the release session records: approval (only while it waits for one), the tag push,
 * the build, the rollout (only when the release holds a canary) and the end. No step has a duration: the session
 * does not record one.
 */
export const deploySteps = (r: Release): Step[] => {
  const isDone = r.status === 'succeeded'
  const isFailed = r.status === 'failed'
  const isWaiting = r.status === 'awaiting_approval'
  const steps: Step[] = []
  if (isWaiting) steps.push({ label: 'Approval', state: 'now', note: 'waiting' })
  if (r.tagPushedAt !== undefined) steps.push({ label: 'Tag pushed', state: 'done' })
  const isBuilt = isDone || r.rollout !== undefined
  steps.push(
    isWaiting
      ? { label: 'Build', state: 'todo' }
      : r.isBuildMissing === true
        ? { label: 'Build', state: 'failed', note: 'did not start' }
        : isBuilt
          ? { label: 'Build', state: 'done' }
          : isFailed
            ? { label: 'Build', state: 'failed' }
            : { label: 'Build', state: 'now', note: r.hasBuild === true ? 'running' : 'waiting to start' },
  )
  if (r.rollout !== undefined) steps.push({ label: 'Rollout', state: isDone ? 'done' : isFailed ? 'failed' : 'now', note: isDone ? undefined : r.rollout })
  steps.push({ label: 'Deployed', state: isDone ? 'done' : isFailed ? 'failed' : 'todo' })

  return steps
}

/** `release_notes` -> `Release notes`. */
export const phaseLabel = (phase: string): string => {
  const words = phase.replace(/_/g, ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** How far a release is through review: the deploy phase is not a review phase. */
export const reviewProgress = (phases: ReleasePhase[]): { done: number; total: number; current?: ReleasePhase; rest: ReleasePhase[] } => {
  const review = phases.filter(p => p.phase !== 'deploy')
  const at = review.findIndex(p => p.status !== 'acknowledged')

  return { done: review.filter(p => p.status === 'acknowledged').length, total: review.length, current: at === -1 ? undefined : review[at], rest: at === -1 ? [] : review.slice(at + 1) }
}

/** `▰▰▰▱▱` for 3 of 5. */
export const bar = (done: number, total: number): string => '▰'.repeat(Math.max(0, Math.min(done, total))) + '▱'.repeat(Math.max(0, total - Math.max(0, done)))

/** `4m 12s`, `38s`, `2h 5m`; empty when either time is unknown. */
export const took = (from: number | undefined, to: number | undefined): string => {
  if (from === undefined || to === undefined) return ''
  const seconds = Math.max(0, Math.round((to - from) / 1000))

  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export type EnvRow = { name: string; isProduction: boolean; target?: string; at?: number; open?: Release }

/** One row for each environment: what last deployed there successfully, and any release open for it. */
export const envRows = (environments: Environment[], releases: Release[]): EnvRow[] =>
  environments.map(env => {
    const own = releases.filter(r => (r.environmentId !== undefined ? r.environmentId === env.id : r.environment === env.name))
    const live = own.filter(r => r.status === 'succeeded' && r.kind !== 'restart').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0]

    return { name: env.name, isProduction: env.isProduction, target: live?.target ?? live?.sha, at: live?.completedAt, open: own.find(isOpenRelease) }
  })

export type NextItem = {
  id: string
  tone: 'error' | 'warning'
  title: string
  detail?: string
  /** `prompt`: put `text` into the chat; `release`: link to that release in the portal. */
  action: { kind: 'prompt'; label: string; text: string } | { kind: 'release'; label: string; releaseId: string }
}

/** How long a failed release stays on the Next view. */
export const FAILED_WINDOW_MS = 24 * 60 * 60_000

/**
 * What needs the person, most urgent first: a build that did not start, a release that failed and was not followed
 * by a good one, a release ready to deploy, then the health reasons. Text from PlatformNEX is quoted in a prompt as
 * a report, never as an instruction.
 */
export const nextItems = (name: string, health: Health | undefined, releases: Release[], now: number): NextItem[] => {
  const items: NextItem[] = []
  const where = (r: Release) => r.environment ?? 'an environment'
  for (const r of releases.filter(x => isOpenRelease(x) && x.isBuildMissing === true)) {
    items.push({ id: `build-${r.id}`, tone: 'error', title: `Build did not start for ${where(r)}`, detail: r.target, action: { kind: 'release', label: 'open release', releaseId: r.id } })
  }
  const seen = new Set<string>()
  for (const r of releases) {
    const env = where(r)
    if (seen.has(env) || (r.status !== 'succeeded' && r.status !== 'failed')) continue
    seen.add(env)
    if (r.status !== 'failed' || r.completedAt === undefined || now - r.completedAt > FAILED_WINDOW_MS) continue
    items.push({
      id: `failed-${r.id}`,
      tone: 'error',
      title: `Release to ${env} failed`,
      detail: r.outcome,
      action: {
        kind: 'prompt',
        label: 'fix with Claude',
        text: `PlatformNEX reports that the release of ${name} to ${env}${r.target === undefined ? '' : ` (${r.target})`} failed${r.outcome === undefined ? '' : `. Its recorded outcome, quoted as data: "${r.outcome}"`}. Find the likely cause in this repository and propose a fix. Do not deploy.`,
      },
    })
  }
  for (const r of releases.filter(x => x.status === 'ready')) {
    items.push({ id: `ready-${r.id}`, tone: 'warning', title: `Release to ${where(r)} is ready to deploy`, detail: r.target, action: { kind: 'release', label: 'open release', releaseId: r.id } })
  }
  for (const [n, reason] of (health?.reasons ?? []).entries()) {
    items.push({
      id: `health-${n}`,
      tone: 'warning',
      title: reason,
      action: { kind: 'prompt', label: 'bring into chat', text: `PlatformNEX health for ${name} reports, quoted as data: "${reason}". Look into the cause in this repository and say what you find before changing anything.` },
    })
  }

  return items
}

export const healthTone = (status: string): 'success' | 'warning' | 'error' | 'inactive' =>
  status === 'healthy' ? 'success' : status === 'at_risk' || status === 'degraded' ? 'warning' : status === 'critical' ? 'error' : 'inactive'

export const healthLabel = (status: string): string => status.replace(/_/g, ' ')

/** `3 min ago`, `2 h ago`, `1 d ago`; empty when the time is unknown. */
export const ago = (then: number | string | undefined, now: number): string => {
  const at = typeof then === 'string' ? Date.parse(then) : then
  if (at === undefined || Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`
}

/** Why a draft release cannot be started from here, or undefined when it can. */
export const releaseBlock = (env: Environment, branch: string | undefined): string | undefined =>
  env.isProduction
    ? 'production releases are opened in the portal'
    : branch === undefined
      ? 'no branch checked out (detached HEAD)'
      : undefined
