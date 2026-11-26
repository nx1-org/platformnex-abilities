import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { ApiFailure, KEY_REFUSED, byRepo, call, checkAccess, createDraftRelease, forgetToken, mcpCall, recentReleases, releaseDetail, signIn, signinToken, systemHealth, type Cfg, type CheckStep, type SigninCfg } from './api'
import {
  ago,
  bar,
  baseName,
  cap,
  cleanRemote,
  dedupeByRemote,
  deploySteps,
  envRows,
  healthLabel,
  healthTone,
  isAbsolutePath,
  isDeploying,
  isOpenRelease,
  isRepoUrl,
  liveRelease,
  nextItems,
  normalizePath,
  normalizeRepoUrl,
  parseByRepo,
  parseHealth,
  parsePhases,
  parseReleases,
  phaseLabel,
  releaseBlock,
  reviewProgress,
  reviewRelease,
  rootContaining,
  safeBaseUrl,
  scannedRepo,
  systemPath,
  took,
  type ParsedMatch,
  type ScannedRepo,
} from './lib'
import { badge, devStatus, logLines, rowOf, visibleJobs } from './devcycle'
import { POLL_MS, forgetDevCycles, pollDevCycles, pollSoon, readDevCycles } from './devcyclePoll'
import { OWN_PREFIX, handoffUrl, parseAsk, pickActiveMatch, pushAsk, scrub } from './skills'
import { ENVIRONMENTS, FIND_CLAUDE, PLUGIN_ID, apiKeysUrl, baseOf, configureInput, environmentOf, extractKey, type EnvironmentId } from './setup'
import { LOGIN_START, MIN_PNX_SIGNIN, SIGNED_OUT, countdown, deviceName, endLoginState, isSignedOutLine, lineSplitter, loginArgv, loginView, logoutArgv, nextLoginState, parseLoginLine, pnxProblem, type LoginState } from './signin'
import { ALREADY_RUNNING_EXIT, FIND_DEVICE, FIND_NEEDS, FIND_PNX, MIN_PNX, MISSING_RETRY_MS, RETRY_MS, WANT_PNX, catalogUrlOf, devCycleSteps, endedNote, isAtLeast, isTakingJobs, lineNote, parseDeviceId, parseFind, parseNeeds, sessionEndAction, wantPnx } from './worker'
import type { Ask, Asks, CheckGroup, ClaudeCode, Data, Match, Release, RepoView, SigninView, Ui, View } from '../types'

const PANE = 'pnx-context'
const TITLE = 'PlatformNEX'
const TICK_MS = 15_000
const DETAIL_MS = 120_000
// While a deploy runs its release is read again this often; everything else keeps DETAIL_MS.
const LIVE_MS = 15_000
const LOOKUP_MS = 30 * 60_000
const LOOKUP_RETRY_MS = 60_000
const SCAN_MS = 10 * 60_000
const MAX_LOOKUPS = 40
const MAX_MATCHES = 3
const PAGE_SIZE = 8
const EMPTY_DATA: Data = { at: 0, status: 'unconfigured', repos: [] }
const EMPTY_UI: Ui = {}
const EMPTY_ASKS: Asks = { items: [] }

// Change a tag when the stored fields change: it declines what an earlier version stored.
const data = atom({ plugin: 'pnx-context', key: 'data' } as const, EMPTY_DATA, { shape: 'data-3' })
const ui = atom({ plugin: 'pnx-context', key: 'ui' } as const, EMPTY_UI, { shape: 'ui-8' })
// The change plans Claude asked for lately, cut down to what the pane draws.
const asks = atom({ plugin: 'pnx-context', key: 'asks' } as const, EMPTY_ASKS, { shape: 'asks-2' })
// Whether this machine's Claude Code takes dev-cycle jobs now (one line in the pane), and why the last try stopped (for the check).
const claudeCode = atom({ plugin: 'pnx-context', key: 'claudeCode' } as const, { status: 'connecting' } as ClaudeCode, { shape: 'claude-code-1' })

// The repository scan: no shell (Windows has no `sh` on PATH), only the file system and `git` itself, which every OS
// runs directly. A folder holding `.git` (a folder, or a worktree's file) is a repository, looked for two folders deep
// under the session's folder, as `find -maxdepth 3 -name .git` did.
const SCAN_DEPTH = 2
const MAX_REPOS = 80
// A broad folder (a home folder, a drive) must not hold the refresh: at most this many folders read, for this long.
const MAX_SCAN_DIRS = 500
const SCAN_BUDGET_MS = 10_000
const SCAN_SKIP = new Set(['.git', 'node_modules', '.terraform'])
// Repositories read by git at once: enough to be quick, few enough not to flood a slow machine.
const GIT_BATCH = 8

// Held in the module (a hot reload starts them over, which only costs one refresh).
let scan: { cwd: string; at: number; repos: ScannedRepo[] } | undefined
const lookups = new Map<string, { at: number; matches?: ParsedMatch[]; failed?: string }>()
const details = new Map<string, { at: number; match: Match }>()
let isBusy = false
// Counts the connections dropped (a switch or Disconnect): a refresh started under an earlier one writes nothing, so the
// old environment's repositories, details and status never land after the new one's.
let connection = 0
// A forced refresh asked for while another ran (connect, Disconnect, ⟳): it runs as soon as that one ends, unless the
// connection was dropped meanwhile (that drop's own refresh comes after it).
let queued: { cfg: Cfg | undefined; at: number } | undefined
// PlatformNEX refused the key in use at the last refresh: the pane asks for a new one, so dev cycles don't start with
// it and Claude isn't pointed at the plan tool. Refreshes still sign in, so a key that works again counts again.
let isRefused = false

const readCfg = (options: Readonly<Record<string, unknown>>): Cfg | undefined => {
  const base = safeBaseUrl(options['baseUrl'])
  const key = typeof options['apiKey'] === 'string' ? options['apiKey'].trim() : ''

  // A key that is not a PlatformNEX key counts as not set: the pane asks for one instead of claiming a connection.
  return base === undefined || !key.startsWith('pnx_') ? undefined : { mode: 'key', base, key }
}

const failure = (error: unknown): string => (error instanceof ApiFailure ? error.reason : 'something went wrong')

// The worker this module started: ending its loop stops the child (pnx). A reload starts over, and so does the worker.
let stopWorker: (() => void) | undefined
let isWorkerBusy = false
let isStopping = false
// The device id the running worker took jobs as: what leaving Claude Code marks offline.
let workerDevice: string | undefined
let nextWorkerTry = 0
// The key saved from the pane this session: counts at once, before (or without) the plugin reloading with it. In
// memory only, never in state; a restart reads the saved settings instead.
let liveCfg: Cfg | undefined
// True after Disconnect in the pane: the saved settings stop counting for this session until a key is connected again.
let isDisconnected = false
// Set while the pane switches or drops the connection: the stopped worker may start again at once, on the new settings.
let isRestarting = false
// What is typed in the terminal's key field, for its connect button: memory only (never state, a file or a log), and
// emptied once a key is saved, the CONNECTION panel closes or Disconnect runs.
let draftKey = ''

// The worker runs quietly: the pane shows one Dev cycles line; what it does goes to the debug log (claude --debug).
const logWorker = ($: EngineInterface, text: string) => $.ui.log(`PlatformNEX dev cycles: ${text}`, { to: 'debug' })
const setClaudeCode = ($: EngineInterface, status: ClaudeCode['status'], note?: string) => update($, claudeCode, () => ({ status, note }))

/**
 * Starts `pnx claude run --allow-codegen --auto-link` with the plugin's key and address, unless one already runs here
 * or it is too soon to try again. The loop is the child's life; it ends with the child or when this session ends.
 */
const startWorker = async ($: EngineInterface, cfg: Cfg): Promise<void> => {
  if (isWorkerBusy || isStopping) return
  const now = await $.clock.now()
  if (now < nextWorkerTry) return
  isWorkerBusy = true
  const started = connection
  try {
    const found = await $.process
      .run(['node', '-e', FIND_PNX], { timeoutMs: 20_000 })
      .then(r => parseFind(r.stdout))
      .catch((): { cli?: string; version?: string } => ({}))
    // The connection was dropped (a switch or Disconnect) while pnx was looked up, before there was a worker to stop:
    // never start it with the old key. The next tick starts it for the connection in use, if any.
    if (started !== connection) return
    // pnx is installed and kept current by the pnx-fast-dev Ability; until it is, this waits and tries again.
    if (found.cli === undefined || !isAtLeast(found.version)) {
      nextWorkerTry = now + MISSING_RETRY_MS
      const why = found.cli === undefined ? 'pnx is not installed' : `pnx ${found.version} is too old (needs ${MIN_PNX}+)`
      logWorker($, why)
      // Tells pnx-fast-dev which pnx is needed, so it checks at every start until it has it, not once a day.
      await $.process.run(['node', '-e', WANT_PNX], { timeoutMs: 10_000 }).catch(() => undefined)
      await setClaudeCode($, 'offline', why)

      return
    }
    // In sign-in mode there is no key: pnx reads the sign-in session itself.
    const child = $.process.spawn({ argv: ['node', found.cli, 'claude', 'run', '--allow-codegen', '--auto-link'], env: { PNX_CATALOG_URL: catalogUrlOf(cfg.base), ...(cfg.mode === 'key' && { PNX_API_KEY: cfg.key }) } })
    const pieces = child[Symbol.asyncIterator]()
    stopWorker = () => void pieces.return?.({ code: null, signal: null })
    let lastError: string | undefined
    for (;;) {
      const piece = await pieces.next()
      if (piece.done === true) {
        const ended = piece.value as { code?: number | null } | undefined
        stopWorker = undefined
        workerDevice = undefined
        const wasRestarting = isRestarting
        isRestarting = false
        nextWorkerTry = wasRestarting ? 0 : (await $.clock.now()) + RETRY_MS
        if (!isStopping && !wasRestarting) {
          logWorker($, endedNote(ended?.code ?? null, lastError))
          // Another Claude Code window on this machine runs it: this machine is still online.
          await setClaudeCode($, ended?.code === ALREADY_RUNNING_EXIT ? 'online' : 'offline', lastError ?? `stopped (exit ${ended?.code ?? 'signal'})`)
        }

        return
      }
      const note = lineNote(piece.value.text)
      if (piece.value.stream === 'stderr' && note !== undefined) lastError = note
      if (isTakingJobs(piece.value.text)) {
        logWorker($, 'online, taking PlatformNEX jobs')
        await setClaudeCode($, 'online')
        // pnx has saved its machine link by now (it links before taking jobs).
        workerDevice = await $.process
          .run(['node', '-e', FIND_DEVICE], { timeoutMs: 10_000 })
          .then(r => parseDeviceId(r.stdout, catalogUrlOf(cfg.base)))
          .catch(() => undefined)
      }
    }
  } catch (error) {
    stopWorker = undefined
    workerDevice = undefined
    nextWorkerTry = (await $.clock.now()) + RETRY_MS
    const why = `could not start pnx (${error instanceof Error ? lineNote(error.message) ?? 'unknown error' : 'unknown error'})`
    logWorker($, why)
    await setClaudeCode($, 'offline', why).catch(() => undefined)
  } finally {
    isWorkerBusy = false
  }
}

/**
 * The folders under `dir` (itself included) that hold `.git`, SCAN_DEPTH folders deep, at most MAX_REPOS. One level at
 * a time, so the folders right under `dir` (where repositories usually are) are read first; it stops at MAX_SCAN_DIRS
 * folders read or SCAN_BUDGET_MS, keeping what it found.
 */
const findRepos = async ($: EngineInterface, dir: string): Promise<string[]> => {
  const found: string[] = []
  const deadline = (await $.clock.now()) + SCAN_BUDGET_MS
  let reads = 0
  let level = [normalizePath(dir)]
  for (let depth = 0; depth <= SCAN_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const path of level) {
      const left = deadline - (await $.clock.now())
      if (found.length >= MAX_REPOS || reads >= MAX_SCAN_DIRS || left <= 0) return found
      reads += 1
      // One read can hang (a cloud-synced or network folder): it gets only the time left, then the search ends there.
      const stop = new AbortController()
      const timeUp = $.clock.sleep(left, { signal: stop.signal }).then(() => undefined, () => undefined)
      // A folder that can't be read (no access, gone meanwhile) is skipped, as find skipped it.
      const entries = await Promise.race([$.fs.list(path).catch(() => []), timeUp])
      stop.abort()
      if (entries === undefined) return found
      if (entries.some(e => e.name === '.git')) found.push(path)
      // Symbolic links are `other`, so they are not followed, as find does not follow them.
      if (depth < SCAN_DEPTH) for (const e of entries) if (e.kind === 'dir' && !SCAN_SKIP.has(e.name)) next.push(`${path === '/' || path.endsWith(':/') ? path : `${path}/`}${e.name}`)
    }
    level = next
  }

  return found
}

/** One repository's remote, branch and short commit, from git run directly (no shell); a part git can't answer is left out. */
const readRepo = async ($: EngineInterface, root: string): Promise<ScannedRepo> => {
  const git = (...args: string[]) =>
    $.process
      .run(['git', '-C', root, ...args], { timeoutMs: 10_000 })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''))
      .catch(() => '')
  const [remote, branch, head] = await Promise.all([git('remote', 'get-url', 'origin'), git('rev-parse', '--abbrev-ref', 'HEAD'), git('rev-parse', '--short', 'HEAD')])

  return scannedRepo(root, remote, branch, head)
}

const discover = async ($: EngineInterface, force: boolean): Promise<{ cwd: string; repos: ScannedRepo[] }> => {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  if (!force && scan !== undefined && scan.cwd === cwd && now - scan.at < SCAN_MS) return { cwd, repos: scan.repos }

  // In a repository, only that one; else every repository under the folder.
  const repo = await $.session.repo()
  const roots = repo === null ? await findRepos($, cwd) : [repo.root]
  const found: ScannedRepo[] = []
  for (let i = 0; i < roots.length; i += GIT_BATCH) found.push(...(await Promise.all(roots.slice(i, i + GIT_BATCH).map(root => readRepo($, root)))))
  const repos = dedupeByRemote(found, cwd)
  scan = { cwd, at: now, repos }

  return { cwd, repos }
}

/** Which Components a remote belongs to, remembered for a while. A failure is remembered only briefly. */
const lookup = async ($: EngineInterface, cfg: Cfg, remote: string, force: boolean, started: number): Promise<{ matches?: ParsedMatch[]; failed?: string }> => {
  const key = normalizeRepoUrl(remote)
  const now = await $.clock.now()
  const known = lookups.get(key)
  if (!force && known !== undefined && now - known.at < (known.failed === undefined ? LOOKUP_MS : LOOKUP_RETRY_MS)) return known
  try {
    const reply = await byRepo($, cfg, cleanRemote(remote))
    const entry = { at: now, matches: parseByRepo(reply.data) }
    if (started === connection) lookups.set(key, entry)

    return entry
  } catch (error) {
    const entry = { at: now, failed: error instanceof ApiFailure && error.status === 404 ? "this PlatformNEX can't look up repos yet" : failure(error) }
    if (started === connection) lookups.set(key, entry)

    return entry
  }
}

/** The component's latest releases, with the phases of the one the Release view shows (one more read, only then). */
const loadReleases = async ($: EngineInterface, cfg: Cfg, entityRef: string): Promise<Release[]> => {
  const list = parseReleases((await recentReleases($, cfg, entityRef)).data)
  const shown = reviewRelease(list)
  if (shown === undefined) return list
  const phases = await releaseDetail($, cfg, shown.id).then(reply => parsePhases(reply.data)).catch(() => undefined)

  return list.map(r => (r.id === shown.id ? { ...r, phases } : r))
}

const loadDetail = async ($: EngineInterface, cfg: Cfg, match: ParsedMatch, force: boolean, started: number): Promise<Match> => {
  const now = await $.clock.now()
  const known = details.get(match.entityRef)
  if (!force && known !== undefined && now - known.at < DETAIL_MS) {
    // A deploy under way moves faster than the rest: only its releases are read again.
    const isLive = (known.match.releases ?? []).some(isDeploying)
    if (!isLive || now - (known.match.releasesAt ?? 0) < LIVE_MS) return known.match
    const releases = await loadReleases($, cfg, match.entityRef).catch(() => undefined)
    const next: Match = releases === undefined ? known.match : { ...known.match, releases, releasesAt: now }
    if (started === connection) details.set(match.entityRef, { at: known.at, match: next })

    return next
  }

  const out: Match = { ...match, detailAt: now }
  const notes: string[] = []
  const system = match.systemRefs.map(systemPath).find((p): p is string => p !== undefined)
  const [health, releases] = await Promise.allSettled([
    system === undefined ? Promise.reject(new ApiFailure('not part of a System')) : systemHealth($, cfg, system),
    loadReleases($, cfg, match.entityRef),
  ])

  if (health.status === 'fulfilled') out.health = parseHealth(health.value.data, match.entityRef)
  else notes.push(`health: ${failure(health.reason)}`)

  if (releases.status === 'fulfilled') {
    out.releases = releases.value
    out.releasesAt = now
  } else notes.push(`releases: ${failure(releases.reason)}`)

  out.detailNote = notes.length === 0 ? undefined : cap(notes.join('; '), 160)
  if (started === connection) details.set(match.entityRef, { at: now, match: out })

  return out
}

// "refreshing…" in the pane, worked out when the write is applied, not when it was asked for: a refresh running or one
// waiting. So writes that land out of order still end on what is true, and the last refresh's own write clears it.
const showRefreshing = ($: EngineInterface) => update($, ui, u => ({ ...u, isRefreshing: isBusy || queued !== undefined })).catch(() => undefined)

const refresh = async ($: EngineInterface, cfg: Cfg | undefined, force: boolean): Promise<void> => {
  if (isBusy) {
    // A tick can wait for the next one; a forced refresh (a new connection, ⟳) must not be lost, and shows as waiting.
    if (force) {
      queued = { cfg, at: connection }
      await showRefreshing($)
    }

    return
  }
  isBusy = true
  const started = connection
  // The pane says "refreshing…" until this ends, so a ⟳ press shows at once even when nothing on screen changes.
  await showRefreshing($)
  try {
    const now = await $.clock.now()
    if (cfg === undefined) {
      await update($, data, (): Data => ({ at: now, status: 'unconfigured', repos: [] }))
      $.ui.status(undefined)

      return
    }

    const { cwd, repos: scanned } = await discover($, force)
    const state = await read($, ui)
    const views: RepoView[] = []
    let failed: string | undefined
    let hasAsked = false
    for (const repo of scanned.slice(0, MAX_LOOKUPS)) {
      const base = { root: repo.root, name: baseName(repo.root), remote: repo.remote, branch: repo.branch, head: repo.head }
      if (repo.remote === undefined || !isRepoUrl(repo.remote)) {
        views.push({ ...base, lookup: 'none', matches: [] })
        continue
      }
      hasAsked = true
      const found = await lookup($, cfg, repo.remote, force, started)
      if (found.failed !== undefined) failed = found.failed
      views.push({ ...base, lookup: found.failed !== undefined ? 'error' : (found.matches ?? []).length > 0 ? 'found' : 'none', matches: (found.matches ?? []) as Match[] })
    }
    // With nothing to look up the key would go untried: sign in (one request, then the token is reused) so the pane
    // never says Connected for a key PlatformNEX refuses.
    if (!hasAsked) await signIn($, cfg).catch((error: unknown) => {
      failed = failure(error)
    })

    // Only the repository on screen is read in detail; the rest wait until the person picks them.
    const roots = views.map(v => v.root)
    const activeRoot = [state.chosenRoot, rootContaining(cwd, roots), state.touchedRoot].find(r => r !== undefined && roots.includes(r)) ?? views.find(v => v.matches.length > 0)?.root
    const filled = await Promise.all(
      views.map(async v =>
        v.root === activeRoot && v.matches.length > 0
          ? { ...v, matches: await Promise.all(v.matches.slice(0, MAX_MATCHES).map(m => loadDetail($, cfg, m as ParsedMatch, force, started))) }
          : v,
      ),
    )
    // The connection changed while this ran: what it read belongs to the old one.
    if (started !== connection) return

    const result: Data = { at: now, status: failed !== undefined && filled.every(v => v.lookup !== 'found') ? 'error' : 'ok', error: failed, repos: filled }
    isRefused = result.status === 'error' && (result.error === KEY_REFUSED || result.error === SIGNED_OUT)
    await update($, data, () => result)

    const active = filled.find(v => v.root === activeRoot)?.matches[0]
    $.ui.status(active === undefined ? undefined : `${active.name} · ${healthLabel(active.health?.status ?? 'unknown')}`)
  } catch (error) {
    if (started === connection) await update($, data, (before): Data => ({ ...before, status: 'error', error: failure(error) })).catch(() => undefined)
  } finally {
    isBusy = false
    const next = queued
    queued = undefined
    if (next !== undefined && next.at === connection) void refresh($, next.cfg, true)
    else await showRefreshing($)
  }
}

const setupNote = ($: EngineInterface, text: string, tone: 'error' | 'info', busy = false) => update($, ui, u => ({ ...u, setupBusy: busy, setupNote: { text, tone } }))
// One step of connecting that went well, shown with a ✓ under step 2.
const setupDone = ($: EngineInterface, text: string) => update($, ui, u => ({ ...u, setupDone: [...(u.setupDone ?? []), text] }))

/**
 * Setup from the pane: checks the pasted key with the chosen PlatformNEX, then saves it and the address the way
 * `claude plugin configure --values-stdin` does (the key only on stdin). The key is never kept in state, shown or logged.
 */
const saveKey = async ($: EngineInterface, pasted: string, env: EnvironmentId, previous?: Cfg): Promise<boolean> => {
  await update($, ui, u => ({ ...u, setupDone: [] }))
  const key = extractKey(pasted)
  if (key === undefined) {
    await setupNote($, "That doesn't look like a PlatformNEX key (it starts with pnx_). Copy it again.", 'error')

    return false
  }
  const base = baseOf(env)
  const label = ENVIRONMENTS.find(e => e.id === env)?.label ?? env
  await setupNote($, `Checking the key with ${label}…`, 'info', true)
  try {
    const accepted = (await checkAccess($, { mode: 'key', base, key })).find(s => s.label === 'key accepted')
    if (accepted?.ok !== true) {
      await setupNote($, `${label} didn't accept this key (${accepted?.detail ?? 'could not check'}). Create a new key there and paste it again.`, 'error')

      return false
    }
    await setupDone($, `Key accepted by ${label}`)
    await setupNote($, 'Saving it for this plugin…', 'info', true)
    const found = await $.process.run(['node', '-e', FIND_CLAUDE], { timeoutMs: 10_000 }).catch(() => undefined)
    const claude = found?.stdout.trim() || 'claude'
    const saved = await $.process.run([claude, 'plugin', 'configure', PLUGIN_ID, '--values-stdin'], { stdin: configureInput(key, base), timeoutMs: 30_000 })
    if (saved.exitCode !== 0) {
      await setupNote($, `The key works but could not be saved: ${lineNote(saved.stderr || saved.stdout) ?? 'claude plugin configure failed'}`, 'error')

      return false
    }
    // Everything counts at once, with no restart: the pane switches to the connected view, Claude gets the plan tool
    // from the next prompt, and the check that follows starts the dev-cycle connection. A restart reads the saved settings.
    // Switching from a connection: the old one's dev cycles stop and its data goes before the new one is drawn.
    const next: Cfg = { mode: 'key', base, key }
    if (previous !== undefined) await dropConnection($, previous, next)
    await update($, ui, u => ({ ...u, signin: undefined, signinEmail: undefined, setupBusy: false, setupNote: undefined, connOpen: false, confirmDisconnect: false, check: undefined, setupDone: [...(u.setupDone ?? []), 'Saved for this plugin', 'Connected, opening the component view…'] }))
    liveCfg = next
    isDisconnected = false
    draftKey = ''
    void refresh($, liveCfg, true).catch(() => undefined)
    void registerPlanTool($)

    return true
  } catch (error) {
    await setupNote($, `Setup didn't finish: ${error instanceof Error ? lineNote(error.message) ?? 'unknown error' : 'unknown error'}`, 'error')

    return false
  }
}

// The sign-in running now (one at a time). stop() ends pnx quietly: Cancel.
let signinRun: { stop: () => void } | undefined
// True while signinEnded drops the connection, so the offline call's own signed-out answer does not start it twice.
let isEnding = false

const HOSTNAME_JS = "process.stdout.write(require('os').hostname())"

const showSignin = ($: EngineInterface, view: SigninView | undefined) => update($, ui, u => ({ ...u, signin: view }))

/** pnx as pnx-fast-dev installed it, or nothing found. */
const findPnx = ($: EngineInterface) =>
  $.process
    .run(['node', '-e', FIND_PNX], { timeoutMs: 20_000 })
    .then(r => parseFind(r.stdout))
    .catch((): { cli?: string; version?: string } => ({}))

/**
 * Sign in from the pane: runs `pnx login --json` (pnx opens the portal's approve page in the browser, code filled in), shows
 * the code while the person signs in and approves there, then connects with the sign-in. The plugin never sees the device code, a refresh token or a key: only pnx's
 * own events (the short code, the link, who signed in) and, later, short-lived access tokens from `pnx token`.
 */
const startSignin = async ($: EngineInterface, env: EnvironmentId, previous?: Cfg): Promise<boolean> => {
  if (signinRun !== undefined) return false
  const base = baseOf(env)
  let isCancelled = false
  let stopChild: (() => void) | undefined
  const run = {
    stop: () => {
      isCancelled = true
      stopChild?.()
    },
  }
  signinRun = run
  await update($, ui, u => ({ ...u, setupNote: undefined, setupDone: [], signinEmail: undefined, signin: { phase: 'starting' as const } }))
  try {
    const found = await findPnx($)
    if (isCancelled) return false
    const problem = pnxProblem(found)
    const cli = found.cli
    if (problem !== undefined || cli === undefined) {
      // Tells pnx-fast-dev which pnx is needed, so it checks at the next start.
      await $.process.run(['node', '-e', wantPnx(MIN_PNX_SIGNIN)], { timeoutMs: 10_000 }).catch(() => undefined)
      await showSignin($, { phase: 'failed', message: problem ?? 'Sign in needs pnx.' })

      return false
    }
    const name = deviceName(await $.process.run(['node', '-e', HOSTNAME_JS], { timeoutMs: 10_000 }).then(r => r.stdout).catch(() => undefined))
    const child = $.process.spawn({ argv: loginArgv(cli, base, name) })
    const pieces = child[Symbol.asyncIterator]()
    stopChild = () => void pieces.return?.({ code: null, signal: null })
    if (isCancelled) stopChild()

    let state: LoginState = LOGIN_START
    const current = (): LoginState => state
    let isTicking = false
    // The countdown redraws every second while the code waits; a code that ran out a while ago ends it here, even if pnx said nothing.
    const tick = async (): Promise<void> => {
      while (signinRun === run && current().phase === 'waiting') {
        await $.clock.sleep(1000).catch(() => undefined)
        const now = await $.clock.now()
        const s = current()
        if (s.phase !== 'waiting' || isCancelled) return
        if (now > s.expiresAt + 10_000) {
          state = { phase: 'failed', code: 'expired' }
          stopChild?.()
          await showSignin($, loginView(state, now))

          return
        }
        await update($, ui, u => (u.signin?.phase === 'waiting' ? { ...u, signin: { ...u.signin, at: now } } : u))
      }
    }
    const apply = async (list: string[]): Promise<void> => {
      for (const line of list) {
        const event = parseLoginLine(line)
        if (event === undefined || isCancelled) continue
        const now = await $.clock.now()
        state = nextLoginState(state, event, { now, base })
        await showSignin($, loginView(state, now))
        if (state.phase === 'waiting' && !isTicking) {
          isTicking = true
          void tick().catch(() => undefined)
        }
      }
    }
    const lines = lineSplitter()
    let ended: number | null = null
    for (;;) {
      const piece = await pieces.next()
      if (piece.done === true) {
        ended = (piece.value as { code?: number | null } | undefined)?.code ?? null
        break
      }
      // Only stdout carries events; what pnx says on stderr is never shown.
      if (piece.value.stream === 'stdout') await apply(lines.feed(piece.value.text))
    }
    await apply(lines.flush())
    if (isCancelled) return false
    state = endLoginState(state, ended)
    if (state.phase !== 'approved') {
      await showSignin($, loginView(state, await $.clock.now()))

      return false
    }

    // Approved, and pnx exited 0 with the sign-in saved: the first token proves it works before the pane says connected.
    const next = signinCfgOf($, base, cli)
    try {
      await signinToken($, next)
    } catch (error) {
      await showSignin($, { phase: 'failed', message: `Signed in, but it can't be used yet: ${failure(error)}. Try again, or use an API key.` })

      return false
    }
    if (previous !== undefined) await dropConnection($, previous, next)
    await update($, ui, u => ({ ...u, signin: undefined, signinEmail: state.phase === 'approved' ? state.email : undefined, connOpen: false, confirmDisconnect: false, check: undefined, setupNote: undefined, setupDone: undefined }))
    liveCfg = next
    isDisconnected = false
    draftKey = ''
    void refresh($, liveCfg, true).catch(() => undefined)
    void registerPlanTool($)

    return true
  } catch (error) {
    if (!isCancelled) await showSignin($, { phase: 'failed', message: `Sign-in didn't finish: ${failure(error)}` }).catch(() => undefined)

    return false
  } finally {
    if (signinRun === run) signinRun = undefined
  }
}

/**
 * Cancel: ends pnx and clears the sign-in panel. If the person approved at the very moment they cancelled, pnx may have
 * saved the session just before it ended: the next start then reconnects with it (probeSignin).
 */
const cancelSignin = async ($: EngineInterface): Promise<void> => {
  const run = signinRun
  signinRun = undefined
  run?.stop()
  await showSignin($, undefined)
}

/**
 * At Claude Code's start with no key saved: a sign-in made earlier (pnx keeps it) connects again by itself. Asks pnx for
 * a token; if there is none (signed out, no pnx, too old) nothing changes and the pane asks as before.
 */
const probeSignin = async ($: EngineInterface, base: string | undefined): Promise<void> => {
  if (base === undefined || liveCfg !== undefined || isDisconnected || signinRun !== undefined) return
  const started = connection
  const found = await findPnx($)
  const cli = found.cli
  if (cli === undefined || pnxProblem(found) !== undefined) return
  const next = signinCfgOf($, base, cli)
  try {
    await signinToken($, next)
  } catch {
    return
  }
  if (started !== connection || liveCfg !== undefined || isDisconnected || signinRun !== undefined) return
  liveCfg = next
  void refresh($, liveCfg, true).catch(() => undefined)
  void registerPlanTool($)
}

/** A sign-in connection whose tokens come from pnx; when pnx says the sign-in ended, the pane returns to setup (signinEnded). */
const signinCfgOf = ($: EngineInterface, base: string, cli: string): SigninCfg => {
  const cfg: SigninCfg = { mode: 'signin', base, cli, tokens: { onSignedOut: () => void signinEnded($, cfg).catch(() => undefined) } }

  return cfg
}

/** The sign-in ended (portal sign-out, the 12 hour limit, revoked): pnx has dropped it, so the pane returns to setup and says so. */
const signinEnded = async ($: EngineInterface, cfg: SigninCfg): Promise<void> => {
  if (liveCfg !== cfg || isEnding) return
  isEnding = true
  try {
    await dropConnection($, cfg, undefined)
  } finally {
    isEnding = false
  }
  liveCfg = undefined
  isDisconnected = false
  draftKey = ''
  await update($, ui, u => ({ ...u, connOpen: false, confirmDisconnect: false, check: undefined, pending: undefined, notice: undefined, signin: undefined, signinEmail: undefined, setupBusy: false, setupDone: undefined, setupNote: { tone: 'error' as const, text: SIGNED_OUT } }))
  await refresh($, undefined, true)
}

/**
 * Ends what a connection left behind: stops the dev-cycle worker (telling PlatformNEX this machine is offline, as
 * leaving Claude Code does) and forgets the repositories and details read with it, so nothing of it stays on screen.
 */
const dropConnection = async ($: EngineInterface, cfg: Cfg, next: Cfg | undefined): Promise<void> => {
  if (stopWorker !== undefined) {
    const device = workerDevice
    isRestarting = true
    stopWorker()
    if (device !== undefined) await call($, cfg, 'POST', `/api/catalog/devices/${encodeURIComponent(device)}/offline`, {}).catch(() => undefined)
  }
  // The switch itself, in one step with no wait between: work started before it sees the counter move, and work
  // started after it already uses the next connection (none, for Disconnect), never the old key under the new count.
  connection += 1
  liveCfg = next
  isDisconnected = next === undefined
  nextWorkerTry = 0
  isRefused = false
  forgetToken()
  lookups.clear()
  details.clear()
  // Nothing read yet, not "not set up": a switch stays in the connected view until its refresh lands (Disconnect's own
  // refresh, with no connection, then shows setup).
  const now = await $.clock.now()
  await update($, data, (): Data => ({ at: now, status: 'ok', repos: [] }))
  await update($, asks, (): Asks => ({ ...EMPTY_ASKS }))
  await setClaudeCode($, 'connecting')
  await forgetDevCycles($)
  $.ui.status(undefined)
}

/**
 * The pane's Disconnect: drops the connection, stops using the key in this session and asks the plugin settings to
 * forget it. If they can't, the note says the saved key comes back when Claude Code restarts.
 */
const disconnect = async ($: EngineInterface, cfg: Cfg | undefined): Promise<void> => {
  if (cfg !== undefined) await dropConnection($, cfg, undefined)
  liveCfg = undefined
  isDisconnected = true
  draftKey = ''
  // A sign-in is ended by pnx (it tells PlatformNEX and deletes what it saved); a key is cleared from the settings.
  const signedOut = cfg?.mode === 'signin' ? await $.process.run(logoutArgv(cfg.cli, cfg.base), { timeoutMs: 90_000 }).then(r => isSignedOutLine(r.stdout), () => false) : undefined
  const found = signedOut === undefined ? await $.process.run(['node', '-e', FIND_CLAUDE], { timeoutMs: 10_000 }).catch(() => undefined) : undefined
  const claude = found?.stdout.trim() || 'claude'
  const cleared = signedOut === undefined ? await $.process.run([claude, 'plugin', 'configure', PLUGIN_ID, '--values-stdin'], { stdin: JSON.stringify({ apiKey: '' }), timeoutMs: 30_000 }).catch(() => undefined) : undefined
  await update($, ui, u => ({
    ...u,
    connOpen: false,
    confirmDisconnect: false,
    check: undefined,
    pending: undefined,
    notice: undefined,
    setupBusy: false,
    setupDone: undefined,
    setupEnv: undefined,
    signin: undefined,
    signinEmail: undefined,
    setupNote:
      signedOut === undefined
        ? {
            tone: 'info' as const,
            text: cleared?.exitCode === 0 ? 'Disconnected. Sign in or paste a key to connect again.' : 'Disconnected for this session. The saved key connects again when Claude Code restarts.',
          }
        : signedOut
          ? { tone: 'info' as const, text: 'Signed out. Sign in again, or paste a key.' }
          : { tone: 'error' as const, text: 'Disconnected for this session, but pnx could not end the sign-in. Run pnx logout in a terminal.' },
  }))
  await refresh($, undefined, true)
}

/** Starts the worker when it should run here and isn't running yet (startWorker decides when to try again). */
const keepWorker = ($: EngineInterface, workerCfg: Cfg | undefined): void => {
  if (workerCfg !== undefined) void startWorker($, workerCfg).catch(() => undefined)
}

const portalLink = (cfg: Cfg, entityRef: string, sessionId: string): string | undefined => {
  const hit = /^component:([^/\s]+)\/([^/\s]+)$/i.exec(entityRef)

  return hit === null ? undefined : `${cfg.base}/catalog/component/${encodeURIComponent(hit[1] ?? '')}/${encodeURIComponent(hit[2] ?? '')}/releases/${encodeURIComponent(sessionId)}`
}

/** The one write: a DRAFT release session. If one is already open for that environment, it is reused. */
const confirmDraft = async ($: EngineInterface, cfg: Cfg, pending: NonNullable<Ui['pending']>): Promise<void> => {
  const started = connection
  try {
    const open = parseReleases((await recentReleases($, cfg, pending.entityRef)).data).filter(isOpenRelease)
    const existing = open.find(r => r.environment === pending.environmentName)
    if (existing !== undefined) {
      await update($, ui, u => ({ ...u, pending: undefined, notice: { text: `A release to ${pending.environmentName} is already open (${existing.status}).`, url: portalLink(cfg, pending.entityRef, existing.id) } }))

      return
    }
    const reply = await createDraftRelease($, cfg, { entityRef: pending.entityRef, environmentId: pending.environmentId, targetKind: 'branch', targetRef: pending.branch })
    const body = reply.data as { session?: { id?: unknown }; id?: unknown } | undefined
    const id = typeof body?.session?.id === 'string' ? body.session.id : typeof body?.id === 'string' ? body.id : undefined
    await update($, ui, u => ({
      ...u,
      pending: undefined,
      notice: {
        text: id === undefined ? 'Draft release opened. Find it in the portal.' : `Draft release opened for ${pending.environmentName}. Review and deploy it in the portal.`,
        url: id === undefined ? undefined : portalLink(cfg, pending.entityRef, id),
      },
    }))
  } catch (error) {
    await update($, ui, u => ({ ...u, pending: undefined, notice: { text: `Could not open a draft release: ${failure(error)}` } }))
  }
  // Not with a connection dropped while the draft was opened: that drop's own refresh shows the new one.
  if (started === connection) void refresh($, cfg, true).catch(() => undefined)
}


// Narrow on purpose: PlatformNEX is an optional extra, so Claude uses the plan tool only when the person asks for it.
const ROUTING =
  'PlatformNEX: when the person asks you to plan a change in a PlatformNEX System using PlatformNEX, call pnx_plan_change. ' +
  'It only plans and creates nothing, so say that. Name a System as system:default/<name>, e.g. system:default/speakupnex. ' +
  'The plan also appears in the PlatformNEX pane. For ordinary coding requests, follow the repository\'s own rules and do not call it.'

// Whether Claude has the plan tool in this session: at start when a key was saved, else once the pane saves one.
let hasPlanTool = false

/** The model's way to ask PlatformNEX for a change plan. Read-only; the plan is also drawn in the pane. Never throws. */
const registerPlanTool = ($: EngineInterface): Promise<void> =>
  $.tool
    .register({
      name: 'pnx_plan_change',
      isDeferred: false,
      description:
        "Plan a change in a PlatformNEX System, e.g. 'create a change for me in speakupnex'. Use it only when the person asks to plan the change in PlatformNEX. Returns the steps in order, starting with a ServiceNEX ticket, plus the System's environments and approval gates. It is a plan only: nothing is created, so tell the person and let them decide. The plan also appears in the PlatformNEX pane. The result ends with a link to PlatformNEX Agent mode, where the real plan is made: give that link to the person.",
      inputSchema: {
        type: 'object',
        properties: { systemRef: { type: 'string', description: "The System's ref, e.g. system:default/speakupnex" }, summary: { type: 'string', description: 'What the change is, in one sentence' } },
        required: ['systemRef', 'summary'],
      },
    })
    .then(() => {
      hasPlanTool = true
    })
    .catch(() => undefined)

/** Keeps one plan (or why asking failed) for the pane and brings the pane up. It never throws. */
const record = async ($: EngineInterface, tool: string, input: unknown, text: string | undefined, isError: boolean): Promise<void> => {
  const ask = parseAsk(tool, input, text, isError, await $.clock.now())
  if (ask === undefined) return
  await update($, asks, a => ({ items: pushAsk(a.items, ask) }))
  await update($, ui, u => ({ ...u, askHidden: undefined, askOpen: false }))
  void $.ui
    .open({ id: PANE, title: TITLE })
    .then(() => $.ui.scroll({ in: PANE, to: 'start' }))
    .catch(() => undefined)
}

type Options = Readonly<Record<string, unknown>>

const keyOf = (options: Options): string => (typeof options['apiKey'] === 'string' ? options['apiKey'].trim() : '')
const urlOf = (options: Options): string => (typeof options['baseUrl'] === 'string' ? options['baseUrl'].trim() : '')

/** What to run to save the key, as plain text for the transcript so it can be copied. Never contains a key. */
const setupText = (options: Options): string => {
  const url = urlOf(options)

  return [
    'Set up PlatformNEX (pnx-context)',
    '',
    `Easiest: open the pane (/pnx-context) and press Sign in (needs pnx ${MIN_PNX_SIGNIN} or newer). Or use an API key:`,
    '',
    `1. Create a personal API key in the portal: user menu, API keys${safeBaseUrl(url) === undefined ? '' : ` (${safeBaseUrl(url)}/account/api-keys)`}.`,
    '   It starts with pnx_. Do not paste it into chat or a file.',
    '',
    '2. Save it. In your own terminal, this keeps the key out of your shell history:',
    '',
    `   read -rs K && printf '{"apiKey":"%s"}' "$K" | claude plugin configure pnx-context@platformnex-abilities --values-stdin; unset K`,
    '',
    '   Or inside Claude Code: /plugin configure pnx-context@platformnex-abilities',
    '',
    '3. Restart Claude Code, then run /pnx-context check.',
    '',
    url === '' ? 'Portal address: not set (add "baseUrl" to the same JSON).' : `Portal address: ${url}. To use another, add "baseUrl" to the same JSON.`,
  ].join('\n')
}

const formatSteps = (steps: CheckStep[]): string =>
  steps
    .flatMap(step => [
      `  ${step.ok === true ? '✓' : step.ok === false ? '✗' : '·'} ${step.label.padEnd(14)}${step.detail}`,
      ...(step.ok === false && step.fix !== undefined ? [`    -> ${step.fix}`] : []),
    ])
    .join('\n')

/** `/pnx-context check`: each step in order, with what to do about the first one that fails. The key is never shown. */
const checkText = async ($: EngineInterface, options: Options): Promise<string> => {
  const r = await checkResult($, options)
  const all = [...r.key, ...r.lookup]
  const summary = ['PlatformNEX check', '', formatSteps(all), '', r.isReady ? 'Ready. Open the pane with /pnx-context.' : 'Not ready yet: fix the first ✗ above, then run /pnx-context check again.']

  return (r.dev === undefined ? summary : [...summary, '', 'Dev cycles', formatSteps(r.dev), ...(r.isRetrying ? ['  · connecting now'] : [])]).join('\n')
}

/** The check's steps in three groups (the key, the lookup route, dev cycles), for the text above and the pane's CHECK. */
type CheckResult = { key: CheckStep[]; lookup: CheckStep[]; dev?: CheckStep[]; isReady: boolean; isRetrying: boolean; keyGroup?: string }

const checkResult = async ($: EngineInterface, options: Options): Promise<CheckResult> => {
  // Connected by sign-in: no URL or key to check, only whether the sign-in works and the lookup answers.
  const live = liveCfg
  if (live?.mode === 'signin') {
    const rest = await checkAccess($, live)
    const result = { key: rest.filter(s => s.label !== 'lookup route'), lookup: rest.filter(s => s.label === 'lookup route'), isReady: rest.every(s => s.ok === true), isRetrying: false, keyGroup: 'sign-in' }
    if (!result.isReady) return result
    const dev = await devCycleCheck($, live, options['devCycles'] === 'off')

    return { ...result, dev: dev.steps, isRetrying: dev.isRetrying }
  }
  const url = urlOf(options)
  const key = keyOf(options)
  const base = safeBaseUrl(url)
  const steps: CheckStep[] = [
    { label: 'URL set', ok: url !== '', detail: url === '' ? 'not set' : url, fix: url === '' ? 'run /pnx-context setup' : undefined },
    { label: 'URL is https', ok: url === '' ? undefined : base !== undefined, detail: base !== undefined ? 'yes' : url === '' ? 'skipped' : 'it must look like https://host, with no path', fix: url !== '' && base === undefined ? 'run /pnx-context setup' : undefined },
    { label: 'API key set', ok: key !== '', detail: key === '' ? 'not set' : '(hidden)', fix: key === '' ? 'run /pnx-context setup' : undefined },
    { label: 'key format', ok: key === '' ? undefined : key.startsWith('pnx_'), detail: key === '' ? 'skipped' : key.startsWith('pnx_') ? 'looks right' : 'a personal key starts with pnx_', fix: key !== '' && !key.startsWith('pnx_') ? 'create a key in the portal (user menu, API keys)' : undefined },
  ]
  const cfg = readCfg(options)
  const stop = steps.some(s => s.ok === false)
  const rest = stop || cfg === undefined ? [{ label: 'key accepted', ok: undefined, detail: 'skipped until the steps above pass' } as CheckStep, { label: 'lookup route', ok: undefined, detail: 'skipped' } as CheckStep] : await checkAccess($, cfg)
  const all = [...steps, ...rest]
  const isReady = all.every(s => s.ok === true)
  const keySteps = [...steps, ...rest.filter(s => s.label !== 'lookup route')]
  const lookup = rest.filter(s => s.label === 'lookup route')
  if (cfg === undefined || !isReady) return { key: keySteps, lookup, isReady, isRetrying: false }
  const dev = await devCycleCheck($, cfg, options['devCycles'] === 'off')

  return { key: keySteps, lookup, dev: dev.steps, isReady, isRetrying: dev.isRetrying }
}

/** The check's Dev cycles part: what the worker needs and what is missing. When it is offline, it also tries again now. */
const devCycleCheck = async ($: EngineInterface, cfg: Cfg, isOff: boolean): Promise<{ steps: CheckStep[]; isRetrying: boolean }> => {
  const started = connection
  const cc = await read($, claudeCode)
  if (isOff || cc.status === 'online') return { steps: devCycleSteps({ isOff, status: cc.status, pnx: {} }), isRetrying: false }
  const [needs, pnx] = await Promise.all([
    $.process.run(['node', '-e', FIND_NEEDS], { timeoutMs: 30_000 }).then(r => parseNeeds(r.stdout)).catch(() => undefined),
    $.process.run(['node', '-e', FIND_PNX], { timeoutMs: 20_000 }).then(r => parseFind(r.stdout)).catch((): { cli?: string; version?: string } => ({})),
  ])
  // Pressing check after installing what was missing should not wait for the next try; not with a connection that
  // was dropped while it looked.
  if (started === connection) {
    nextWorkerTry = 0
    keepWorker($, cfg)
  }

  return { steps: devCycleSteps({ isOff, status: cc.status, note: cc.note, needs, pnx }), isRetrying: true }
}

/** The pane's Check button: the same steps as /pnx-context check, kept for the pane to show (never the key). */
const runCheck = async ($: EngineInterface, options: Options): Promise<void> => {
  const started = connection
  await update($, ui, u => ({ ...u, check: { groups: [], isReady: false, isChecking: true } }))
  try {
    const r = await checkResult($, options)
    const groups = [{ name: r.keyGroup ?? 'key', steps: r.key }, { name: 'lookup', steps: r.lookup }, ...(r.dev === undefined ? [] : [{ name: 'dev cycles', steps: r.dev }])]
    // A check of a connection dropped meanwhile is not this one's: the pane shows none rather than that.
    await update($, ui, u => ({ ...u, check: started === connection ? { groups, isReady: r.isReady } : undefined }))
  } catch {
    await update($, ui, u => ({ ...u, check: started === connection ? { groups: [], isReady: false, note: "The check couldn't run. Press k to try again." } : undefined }))
  }
}

/** The Agent mode link for a plan, naming the component the pane has identified. Never throws. */
async function handoff($: EngineInterface, cfg: Cfg, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const system = typeof args['systemRef'] === 'string' ? args['systemRef'].replace(/^system:/i, '') : undefined
    const asked = typeof args['summary'] === 'string' ? args['summary'] : undefined
    const match = pickActiveMatch(await read($, data), await read($, ui), await $.session.cwd())

    return handoffUrl(cfg.base, system, asked, match === undefined ? undefined : { ref: match.entityRef, systemRefs: match.systemRefs })
  } catch {
    return undefined
  }
}

/** Asks the gateway as the person for a change plan, keeps it for the pane, and answers the model with it. */
async function serve($: EngineInterface, cfg: Cfg | undefined, name: string, args: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  if (cfg === undefined) return { deny: 'PlatformNEX is not set up. Run /pnx-context setup.' }
  try {
    const reply = await mcpCall($, cfg, name, args)
    await record($, `${OWN_PREFIX}${name}`, args, reply.text, reply.isError).catch(() => undefined)
    if (reply.isError) return { deny: scrub(reply.text === '' ? 'the tool reported an error' : reply.text, 300) }
    const link = await handoff($, cfg, args)
    const answer = reply.text === '' ? 'No answer.' : reply.text

    return { result: link === undefined ? answer : `${answer}\n\nTo plan this for real, open PlatformNEX Agent mode (nothing is sent until the person sends it): ${link}` }
  } catch (error) {
    const reason = `PlatformNEX: ${failure(error)}`
    // The pane shows it too, or a failed ask would leave nothing on screen.
    await record($, `${OWN_PREFIX}${name}`, args, reason, true).catch(() => undefined)

    return { deny: reason }
  }
}

export const register: Register = (on, options) => {
  const fromOptions = readCfg(options)
  // The key connected from the pane this session (it wins: it may be a switch away from the saved one), else the saved
  // settings; nothing after Disconnect.
  const activeCfg = (): Cfg | undefined => (isDisconnected ? undefined : liveCfg ?? fromOptions)
  // The worker runs once the key and address are set, unless the person turned it off.
  const activeWorkerCfg = (): Cfg | undefined => (options['devCycles'] === 'off' || isRefused ? undefined : activeCfg())
  // What the check reads: the same connection the pane uses.
  const checkOptions = (): Options => (liveCfg !== undefined ? { ...options, apiKey: liveCfg.mode === 'key' ? liveCfg.key : '', baseUrl: liveCfg.base } : isDisconnected ? { ...options, apiKey: '' } : options)

  // Leaving Claude Code stops the worker and tells PlatformNEX at once (/clear and /resume keep Claude Code, and it).
  // One request from here, not a pnx command: it fits session.end's short budget, and on Windows the stopped worker
  // can't say it itself.
  on('session.end', async ($, e, next) => {
    const workerCfg = activeWorkerCfg()
    const action = sessionEndAction(e.reason)
    if (action !== 'keep' && stopWorker !== undefined && workerCfg !== undefined) {
      isStopping = true
      const device = workerDevice
      stopWorker()
      if (device !== undefined) await call($, workerCfg, 'POST', `/api/catalog/devices/${encodeURIComponent(device)}/offline`, {}).catch(() => undefined)
      // Claude Code may go on (a logout, or a reason it adds later): the next tick starts the worker again.
      if (action === 'pause') {
        isStopping = false
        await setClaudeCode($, 'connecting').catch(() => undefined)
      }
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pnx-context', description: 'Show the PlatformNEX component, health and releases for this repo' })
    void $.ui.open({ id: PANE, title: TITLE })
    if (activeCfg() !== undefined) void registerPlanTool($)
    void refresh($, activeCfg(), true).catch(() => undefined)
    keepWorker($, activeWorkerCfg())
    // No key saved: a sign-in made earlier (pnx keeps it) connects again by itself.
    if (fromOptions === undefined) void probeSignin($, safeBaseUrl(options['baseUrl'])).catch(() => undefined)
    $.clock.every(TICK_MS, () => {
      void refresh($, activeCfg(), false).catch(() => undefined)
      keepWorker($, activeWorkerCfg())
    })
    // Each source keeps its own pace; one not due is skipped.
    $.clock.every(POLL_MS, () => {
      const cfg = activeCfg()
      const started = connection
      if (cfg !== undefined) void read($, ui).then(u => pollDevCycles($, { isDevOpen: u.view === 'dev', isCurrent: () => started === connection, notify: (text, tone) => update($, ui, x => ({ ...x, notice: { text, tone, title: 'Dev cycle' } })) })).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'pnx-context' }, async ($, e) => {
    const word = e.args.trim()
    const cfg = activeCfg()
    if (word === 'setup') return { text: setupText(options) }
    if (word === 'check') return { text: await checkText($, checkOptions()) }
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($, cfg, e.args.trim() === 'refresh').catch(() => undefined)

    return { text: cfg === undefined ? 'PlatformNEX pane opened, but it is not set up yet. Run /pnx-context setup.' : 'PlatformNEX pane opened. If it shows an error, run /pnx-context check.' }
  })

  // Tells the model when to use the plan tool, once configured.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // Only once Claude has the plan tool, and not after Disconnect or while the key is refused.
    if (!hasPlanTool || activeCfg() === undefined || isRefused) return composed

    return { sections: [...composed.sections, { id: 'pnx-context-routing', text: ROUTING, scope: 'session' as const }] }
  })

  const fields = (e: unknown): Record<string, unknown> => (e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {})

  on('tool.call', { tool: `${OWN_PREFIX}pnx_plan_change` }, async ($, e) => {
    const input = fields(e)
    const systemRef = typeof input['systemRef'] === 'string' ? input['systemRef'].trim() : ''
    const summary = typeof input['summary'] === 'string' ? input['summary'].trim() : ''
    if (systemRef === '' || summary.length < 3) return { deny: 'Both systemRef and summary are needed.' }

    return serve($, activeCfg(), 'plan_propose', { systemRef: systemRef.slice(0, 120), summary: summary.slice(0, 500) })
  })

  // Notes which repository Claude's own file reads and edits touch, so the pane can follow the work. The call itself is never changed.
  on('tool.call', async ($, e, next) => {
    try {
      const path = (e as unknown as { file_path?: unknown }).file_path
      if (typeof path === 'string' && isAbsolutePath(path)) {
        const root = rootContaining(path, (await read($, data)).repos.map(r => r.root))
        if (root !== undefined && root !== (await read($, ui)).touchedRoot) await update($, ui, u => ({ ...u, touchedRoot: root }))
      }
    } catch {
      // Never let the pane get in the way of a tool call.
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Input } = $.ui.resolve(e)
    // The terminal draws a Button's hotkey itself (`k: check`) and a link's address under its label; elsewhere neither
    // is drawn, so the hotkey goes in the label and a link keeps a short label.
    const isTerminal = e.surface === 'terminal'
    const lead = (key: string, label: string): string => (isTerminal ? label : `${key} ${label}`)
    // The saved settings, or the key just saved from this pane.
    const cfg = activeCfg()
    const d = await read($, data)
    const u = await read($, ui)
    const heard = await read($, asks)
    const dc = await readDevCycles($)
    const cc = await read($, claudeCode)
    const columns = Math.max(24, e.props.bodyColumns ?? 40)
    // Room inside a panel: the border and one space of padding on each side.
    const inner = Math.max(16, columns - 4)
    const now = await $.clock.now()
    const act = (run: () => Promise<unknown>) => () => void run().catch(() => undefined)
    const rule = <Text dimColor>{'─'.repeat(Math.max(10, columns))}</Text>
    // The Check: one summary line (✓ key  ✓ lookup  ✗ dev cycles), then only what failed, each with its fix. The full
    // step-by-step list stays in /pnx-context check.
    const groupMark = (g: CheckGroup): '✓' | '✗' | '·' => (g.steps.some(s => s.ok === false) ? '✗' : g.steps.length > 0 && g.steps.every(s => s.ok === true) ? '✓' : '·')
    const checkState = (c: NonNullable<Ui['check']>): { text: string; tone: string } =>
      c.isChecking === true
        ? { text: 'checking…', tone: 'warning' }
        : c.note !== undefined || !c.isReady || c.groups.some(g => groupMark(g) === '✗')
          ? { text: '✗ not ready', tone: 'warning' }
          : { text: '✓ ready', tone: 'success' }
    const checkBody = (c: NonNullable<Ui['check']>) => (
      <Box flexDirection="column">
        {c.note !== undefined && <Text color="error">{cap(`✗ ${c.note}`, inner)}</Text>}
        {c.groups.length > 0 && (
          <Box flexDirection="row" gap={3} flexWrap="wrap">
            {c.groups.map(g => {
              const mark = groupMark(g)

              return (
                <Text key={`check-group-${g.name}`} color={mark === '✓' ? 'success' : mark === '✗' ? 'error' : undefined} dimColor={mark === '·'}>
                  {`${mark} ${g.name}`}
                </Text>
              )
            })}
          </Box>
        )}
        {c.groups
          .filter(g => groupMark(g) === '✗')
          .flatMap(g =>
            g.steps.flatMap((s, n) =>
              s.ok === false
                ? [
                    <Text key={`check-fail-${g.name}-${n}`} color="error">
                      {cap(`✗ ${s.label} · ${s.detail}`, inner * 2)}
                    </Text>,
                    ...(s.fix === undefined
                      ? []
                      : [
                          <Text key={`check-fix-${g.name}-${n}`} dimColor>
                            {cap(`  → ${s.fix}`, inner * 2)}
                          </Text>,
                        ]),
                  ]
                : s.label === 'last try'
                  ? [
                      <Text key={`check-note-${g.name}-${n}`} dimColor>
                        {cap(`  last try: ${s.detail}`, inner * 2)}
                      </Text>,
                    ]
                  : [],
            ),
          )}
      </Box>
    )

    // One bordered panel: title and a short summary on the first row, both in the panel's colour.
    const panel = (title: string, accent: string, right: JSX.Element | undefined, body: JSX.Element) => (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={accent}>
            {cap(title, Math.max(8, inner - 14))}
          </Text>
          {right}
        </Box>
        {body}
      </Box>
    )

    // Pick an environment, open its API keys page, paste a key and connect: the first setup, and a switch from the
    // connection in use (`previous`), which stays as it is unless the new key is accepted and saved.
    const setupForm = (env: EnvironmentId, previous: Cfg | undefined, why?: string) => {
      // What the person did here last wins; else why the saved key does not connect.
      const note = u.setupNote ?? (why === undefined ? undefined : { text: why, tone: 'error' as const })
      // Enter in the field and the connect button both land here; once connected the check runs by itself. draftKey is
      // kept: after a failed try the field still shows the key, so connect can be pressed again.
      const connect = (value: string) => {
        if (u.setupBusy === true || value.trim() === '') return
        void saveKey($, value, env, previous).then(isSaved => (isSaved ? runCheck($, checkOptions()) : undefined)).catch(() => undefined)
      }
      const connectLabel = u.setupBusy === true ? 'checking…' : 'connect'
      const s = u.signin
      const startSigninNow = () => void startSignin($, env, previous).then(isSaved => (isSaved ? runCheck($, checkOptions()) : undefined)).catch(() => undefined)
      const signinBlock = (
        <Box flexDirection="column">
          {(s === undefined || s.phase === 'failed') && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Button key="signin-start" variant="primary" onPress={startSigninNow}>
                Sign in
              </Button>
              <Text dimColor>with your PlatformNEX account</Text>
            </Box>
          )}
          {s?.phase === 'failed' && <Text color="error">{cap(`✗ ${s.message ?? 'Sign-in did not finish.'}`, inner * 3)}</Text>}
          {s?.phase === 'starting' && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text dimColor>{s.message ?? 'Starting sign-in…'}</Text>
              <Button key="signin-cancel" onPress={act(() => cancelSignin($))}>
                Cancel
              </Button>
            </Box>
          )}
          {s?.phase === 'waiting' && s.link !== undefined && s.userCode !== undefined && (
            <Box flexDirection="column">
              <Text>Sign in on the PlatformNEX page that just opened. This connects by itself.</Text>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>Code on that page:</Text>
                <Text bold>{s.userCode}</Text>
              </Box>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Text dimColor>Page did not open?</Text>
                {isTerminal ? <Text dimColor>{s.link}</Text> : <Link href={s.link}>↗ open the sign-in page</Link>}
                <Button key="signin-copy-link" plain onPress={press => void $.ui.copy({ text: s.link ?? '', surface: press.surface }).catch(() => undefined)}>
                  copy link
                </Button>
              </Box>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text dimColor>{`Waiting for you · ${s.expiresAt === undefined ? '' : `${countdown(s.expiresAt, now)} left`}`}</Text>
                <Button key="signin-cancel" onPress={act(() => cancelSignin($))}>
                  Cancel
                </Button>
              </Box>
            </Box>
          )}
          <Text> </Text>
          <Text dimColor>Or use an API key</Text>
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text dimColor>Environment:</Text>
            {ENVIRONMENTS.map(e => (
              <Button key={`env-${e.id}`} {...(e.id === env ? {} : { plain: true as const })} onPress={act(() => update($, ui, x => ({ ...x, setupEnv: e.id, setupNote: undefined, setupDone: undefined })))}>
                {`${e.id === env ? '●' : '○'} ${e.label}`}
              </Button>
            ))}
          </Box>
          <Text> </Text>
          {signinBlock}
          <Text>1  Create an API key</Text>
          <Box flexDirection="row">
            <Text>{'   '}</Text>
            {isTerminal ? (
              // The address once, dim so it reads as secondary. A Link can't be dimmed, so it is plain text here: most
              // terminals (VS Code's, Windows Terminal) still make an address clickable themselves.
              <Text dimColor>{apiKeysUrl(baseOf(env))}</Text>
            ) : (
              <Link href={apiKeysUrl(baseOf(env))}>{`↗ open API keys (${ENVIRONMENTS.find(e => e.id === env)?.label ?? env})`}</Link>
            )}
          </Box>
          <Text> </Text>
          <Text>2  Paste it here and press connect</Text>
          {isTerminal ? (
            // The terminal draws a bare line for a field and no button for its submit: a box around it, and a real
            // connect button (it inverts under the pointer) beside it.
            <Box flexDirection="row" alignItems="center">
              {/* The label outside the box, so only the key is inside it. The field has no label of its own: even a blank
                  one is drawn with a colon. */}
              <Text>{'   API key  '}</Text>
              <Box borderStyle="round" paddingX={1}>
                <Input
                  key="setup-key"
                  placeholder="pnx_…"
                  value=""
                  submitLabel={connectLabel}
                  onInput={value => {
                    draftKey = value
                  }}
                  onSubmit={value => connect(value)}
                />
              </Box>
              <Text> </Text>
              <Button key="setup-connect" variant="primary" onPress={() => connect(draftKey)}>
                {connectLabel}
              </Button>
            </Box>
          ) : (
            <Input
              key="setup-key"
              label="   API key"
              placeholder="pnx_…"
              value=""
              submitLabel={connectLabel}
              onSubmit={value => connect(value)}
            />
          )}
          {(u.setupDone ?? []).map((text, n) => (
            <Text key={`setup-done-${n}`} color="success">
              {cap(`   ✓ ${text}`, inner)}
            </Text>
          ))}
          {note !== undefined && (
            <Text color={note.tone === 'error' ? 'error' : undefined} dimColor={note.tone === 'info'}>
              {cap(`   ${note.tone === 'error' ? '✗' : '·'} ${note.text}`, inner * 3)}
            </Text>
          )}
          <Text> </Text>
          <Text dimColor>Saved for this plugin only, never sent to the chat.</Text>
        </Box>
      )
    }

    const labelOf = (base: string): string => ENVIRONMENTS.find(x => x.base === base)?.label ?? base.replace(/^https:\/\//, '')
    // A saved key that is not a PlatformNEX key counts as not set (readCfg); say so rather than just asking for one.
    const savedKey = keyOf(options)
    const isSavedKeyMalformed = cfg === undefined && !isDisconnected && savedKey !== '' && !savedKey.startsWith('pnx_')
    // PlatformNEX refused the key in use (revoked or expired): that is no connection, so the pane asks for a new key.
    const isKeyRefused = cfg !== undefined && d.status === 'error' && d.error === KEY_REFUSED

    if (d.status === 'unconfigured' || cfg === undefined || isKeyRefused) {
      // The environment picked here, else the key's or the saved address's, else production.
      const env: EnvironmentId = u.setupEnv ?? environmentOf(cfg?.base ?? safeBaseUrl(urlOf(options))) ?? 'prod'
      const why = isKeyRefused
        ? `Your API key no longer works on ${labelOf(cfg.base)} (expired or revoked). Create a new one and paste it here.`
        : isSavedKeyMalformed
          ? "The saved API key isn't a PlatformNEX key (it starts with pnx_). Paste a new one."
          : undefined

      return panel(
        'SET UP PLATFORMNEX',
        'warning',
        undefined,
        <Box flexDirection="column">
          {setupForm(env, isKeyRefused ? cfg : undefined, why)}
          <Text dimColor>Closed this panel? Reopen it with /pnx-context.</Text>
        </Box>,
      )
    }

    // Which PlatformNEX the key in use is for.
    const envLabel = labelOf(cfg.base)
    const roots = d.repos.map(r => r.root)
    const cwdRoot = d.repos.length === 0 ? undefined : rootContaining(await $.session.cwd(), roots)
    const activeRoot = [u.chosenRoot, cwdRoot, u.touchedRoot].find(r => r !== undefined && roots.includes(r)) ?? d.repos.find(r => r.matches.length > 0)?.root
    const active = d.repos.find(r => r.root === activeRoot)
    const matched = d.repos.filter(r => r.matches.length > 0).length
    const shown = active === undefined ? [] : active.matches.slice(0, MAX_MATCHES)
    const current = shown.find(m => m.entityRef === u.activeEntity) ?? shown[0]
    const currentStatus = current?.health?.status ?? 'unknown'

    // Catalog repositories first (the sort is stable, so the scan order holds within each group).
    const ordered = [...d.repos].sort((a, b) => Number(b.matches.length > 0) - Number(a.matches.length > 0))
    const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE))
    const page = Math.min(Math.max(0, u.page ?? 0), pages - 1)
    const pageRepos = ordered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

    const newest: Ask | undefined = heard.items.find(a => a.id !== u.askHidden)
    const askOpen = u.askOpen === true
    const planUrl = newest?.kind === 'plan' ? handoffUrl(cfg.base, newest.system, newest.asked, current === undefined ? undefined : { ref: current.entityRef, systemRefs: current.systemRefs }) : undefined
    const expandable = (k: Ask): boolean => k.kind === 'plan' && ((k.steps ?? []).length > 1 || (k.evidence ?? []).length > 0)
    const askPanel = (k: Ask) => {
      if (k.kind === 'error') return panel(k.title, 'error', <Text dimColor>{ago(k.at, now)}</Text>, <Text>{cap(k.note ?? 'The tool reported an error.', inner * 2)}</Text>)

      const steps = k.steps ?? []
      const first = steps[0]
      const rest = steps.slice(1)

      return panel(
        k.title,
        'claude',
        <Text dimColor>{k.risk === undefined ? '' : `risk ${k.risk}`}</Text>,
        askOpen ? (
          <Box flexDirection="column">
            <Text dimColor>{cap(k.note ?? 'Plan only. Nothing has been created.', inner)}</Text>
            {steps.map((st, n) => (
              <Box flexDirection="column" key={`ask-step-${n}`}>
                <Text bold={n === 0} color={n === 0 ? 'claude' : undefined}>{cap(`${n === 0 ? '▸' : ' '} ${n + 1} ${st.label}`, inner)}</Text>
                {n === 0 && <Text dimColor>{cap(`    ${st.detail}`, inner)}</Text>}
              </Box>
            ))}
            {(k.evidence ?? []).map(ev => (
              <Text dimColor>{cap(`${ev.k}  ${ev.v}`, inner)}</Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{cap(k.note ?? 'Plan only. Nothing has been created.', inner)}</Text>
            {first !== undefined && <Text bold color="claude">{cap(`▸ 1 ${first.label}`, inner)}</Text>}
            {rest.length > 0 && <Text dimColor>{cap(`  then: ${rest.map(st => st.label).join(' · ')}`, inner)}</Text>}
            {(k.evidence ?? []).length > 0 && <Text dimColor>{cap((k.evidence ?? []).map(ev => `${ev.k} ${ev.v}`).join('   '), inner)}</Text>}
          </Box>
        ),
      )
    }

    const releases = current?.releases ?? []
    const live = liveRelease(releases, now)
    const review = reviewRelease(releases)
    const needs = current === undefined ? [] : nextItems(current.title ?? current.name, current.health, releases, now)
    // The view the person picked, else Live while a deploy runs and Next otherwise.
    const view: View = u.view ?? (releases.some(isDeploying) ? 'live' : 'next')
    const isDev = view === 'dev'
    const devRows = visibleJobs(dc.jobs, now)
    const devLog = logLines(dc.events, u.logOpen === true ? 30 : 12, columns)
    const devBadge = badge(dc.jobs, u.devSeenAt, isDev, now)
    // Names from the longest to the shortest; the strip takes the first set that fits (Environments needs 48 columns).
    const viewsOf = (envs: string, dev: string): { id: View; label: string }[] => [
      { id: 'live', label: 'Live' },
      { id: 'next', label: needs.length === 0 ? 'Next' : `Next ${needs.length}` },
      { id: 'release', label: 'Release' },
      { id: 'envs', label: envs },
      { id: 'dev', label: devBadge === '' ? dev : `${dev} ${devBadge}` },
    ]
    const stripOf = [viewsOf('Environments', 'Dev cycles'), viewsOf('Environments', 'Dev'), viewsOf('Envs', 'Dev cycles'), viewsOf('Envs', 'Dev')].filter((_, n) => n >= 2 || columns >= 48)
    const fitsStrip = (vs: { label: string }[]) => vs.reduce((w, v, i) => w + lead(String(i + 1), v.label).length + 2, 0) <= columns - 2
    const VIEWS = stripOf.find(fitsStrip) ?? stripOf[stripOf.length - 1]!
    // Leaving the Dev cycles view marks what happened so far as seen (the ✕ badge clears).
    const showView = (id: View) => update($, ui, x => ({ ...x, view: id, devSeenAt: x.view === 'dev' ? now : x.devSeenAt }))
    const row = (left: JSX.Element, right?: JSX.Element) => (
      <Box flexDirection="row" justifyContent="space-between">
        {left}
        {right}
      </Box>
    )
    const releaseLink = (r: Release, label: string) => {
      const url = current === undefined ? undefined : portalLink(cfg, current.entityRef, r.id)

      return url === undefined ? undefined : <Link href={url}>{`↗ ${label}`}</Link>
    }
    const target = (r: Release): string => [r.kind !== undefined && r.kind !== 'release' ? r.kind : undefined, r.target, r.sha].filter((x): x is string => x !== undefined).join(' · ')
    // Puts a line into the chat as a prompt of its own; nothing is sent to PlatformNEX.
    const ask = (text: string) => act(async () => void (await $.prompt.submit({ text })))

    const liveView = () => {
      if (live === undefined) return <Text dimColor>No deploy running.</Text>
      const where = live.environment ?? 'an environment'
      const isFailed = live.status === 'failed'
      const title = live.status === 'succeeded' ? `Deployed to ${where}` : isFailed ? `Deploy to ${where} failed` : live.status === 'awaiting_approval' ? `Waiting for approval · ${where}` : `Deploying to ${where}`
      const when = live.completedAt !== undefined ? ago(live.completedAt, now) : took(live.tagPushedAt, now)
      const failed = needs.find(n => n.id === `failed-${live.id}`)

      return (
        <Box flexDirection="column">
          {row(<Text bold color={isFailed ? 'error' : undefined}>{cap(title, Math.max(12, columns - 12))}</Text>, <Text dimColor>{when}</Text>)}
          {target(live) !== '' && <Text dimColor>{cap(target(live), columns)}</Text>}
          <Text> </Text>
          {deploySteps(live).map(st =>
            row(
              <Box flexDirection="row" key={`step-${st.label}`}>
                <Text color={st.state === 'done' ? 'success' : st.state === 'now' ? 'warning' : st.state === 'failed' ? 'error' : undefined} dimColor={st.state === 'todo'}>
                  {st.state === 'done' ? '✓ ' : st.state === 'now' ? '● ' : st.state === 'failed' ? '✗ ' : '○ '}
                </Text>
                <Text bold={st.state === 'now'} dimColor={st.state === 'todo'}>
                  {st.label}
                </Text>
              </Box>,
              st.note === undefined ? undefined : <Text color={st.state === 'failed' ? 'error' : st.state === 'now' ? 'warning' : undefined}>{st.note}</Text>,
            ),
          )}
          {isFailed && live.outcome !== undefined && <Text dimColor>{cap(live.outcome, columns * 2)}</Text>}
          <Text> </Text>
          {failed !== undefined && failed.action.kind === 'prompt' && (
            <Button key="live-fix" variant="primary" hotkey="f" onPress={ask(failed.action.text)}>
              {lead('f', failed.action.label)}
            </Button>
          )}
          {releaseLink(live, 'logs and details')}
        </Box>
      )
    }

    const SHOWN = 3
    const nextView = () => {
      if (needs.length === 0) return <Text color="success">✓ Nothing needs you</Text>

      return (
        <Box flexDirection="column">
          {needs.slice(0, SHOWN).map((item, n) => {
            const key = String.fromCharCode(97 + n)
            const action = item.action

            return (
              <Box flexDirection="column" key={`next-${item.id}`}>
                <Box flexDirection="row">
                  <Text color={item.tone}>{item.tone === 'error' ? '✗ ' : '⚠ '}</Text>
                  <Text bold>{cap(item.title, Math.max(12, columns - 2) * 2)}</Text>
                </Box>
                {item.detail !== undefined && <Text dimColor>{cap(`  ${item.detail}`, columns * 2)}</Text>}
                <Box flexDirection="row">
                  <Text>{'  '}</Text>
                  {action.kind === 'prompt' ? (
                    <Button key={`next-act-${item.id}`} {...(n === 0 ? { variant: 'primary' as const } : {})} hotkey={key} onPress={ask(action.text)}>
                      {lead(key, action.label)}
                    </Button>
                  ) : (
                    releaseLink({ id: action.releaseId, status: '' }, action.label)
                  )}
                </Box>
                {n < Math.min(SHOWN, needs.length) - 1 && <Text> </Text>}
              </Box>
            )
          })}
          {needs.length > SHOWN && <Text dimColor>{`+${needs.length - SHOWN} more`}</Text>}
        </Box>
      )
    }

    const releaseView = (m: Match, repo: RepoView) => {
      const choices = m.environments.map(env => ({ env, block: releaseBlock(env, repo.branch) }))
      const progress = review?.phases === undefined ? undefined : reviewProgress(review.phases)
      const step = progress?.current

      return (
        <Box flexDirection="column">
          {review === undefined && <Text dimColor>No open release.</Text>}
          {review !== undefined && (
            <Box flexDirection="column">
              {row(<Text bold>{cap(`Release to ${review.environment ?? 'an environment'}`, Math.max(12, columns - 20))}</Text>, <Text color="warning">{review.status.replace(/_/g, ' ')}</Text>)}
              {target(review) !== '' && <Text dimColor>{cap(target(review), columns)}</Text>}
              <Text> </Text>
              {progress !== undefined && progress.total > 0 && (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text color="success">{bar(progress.done, progress.total).replace(/▱/g, '')}</Text>
                    <Text dimColor>{`${bar(progress.done, progress.total).replace(/▰/g, '')} ${progress.done} of ${progress.total}`}</Text>
                  </Box>
                  <Text> </Text>
                  {progress.done > 0 && (
                    <Box flexDirection="row">
                      <Text color="success">✓ </Text>
                      <Text>{`${progress.done} phase${progress.done === 1 ? '' : 's'} reviewed`}</Text>
                    </Box>
                  )}
                  {step !== undefined &&
                    row(
                      <Box flexDirection="row">
                        <Text color="warning">● </Text>
                        <Text bold>{phaseLabel(step.phase)}</Text>
                      </Box>,
                      <Text color={step.status === 'stale' ? 'error' : 'warning'}>{step.status === 'stale' ? 'stale' : step.status === 'computed' ? 'to review' : 'not ready yet'}</Text>,
                    )}
                  {step?.staleReason !== undefined && <Text dimColor>{cap(`  ${step.staleReason}`, columns * 2)}</Text>}
                  {progress.rest.length > 0 && <Text dimColor>{cap(`○ ${progress.rest.map(p => phaseLabel(p.phase)).join(' · ')}`, columns * 2)}</Text>}
                  {step === undefined && <Text color="success">All phases reviewed.</Text>}
                </Box>
              )}
              {progress === undefined && review.currentPhase !== undefined && <Text>{`at ${phaseLabel(review.currentPhase)}`}</Text>}
              <Text> </Text>
              {releaseLink(review, 'open release')}
            </Box>
          )}
          <Text> </Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text dimColor>open a draft:</Text>
            {choices
              .filter(c => c.block === undefined)
              .map(({ env }) => (
                <Button
                  key={`rel-${m.entityRef}-${env.id}`}
                  onPress={act(() => update($, ui, x => ({ ...x, notice: undefined, pending: { entityRef: m.entityRef, environmentId: env.id, environmentName: env.name, branch: repo.branch ?? '', head: repo.head } })))}
                >
                  {env.name}
                </Button>
              ))}
            {m.environments.length === 0 && <Text dimColor>no environments set up</Text>}
          </Box>
          {choices
            .filter(c => c.block !== undefined)
            .map(({ env, block }) => (
              <Text dimColor>{cap(`${env.name}: ${env.isProduction ? 'in the portal' : block}`, inner)}</Text>
            ))}
        </Box>
      )
    }

    const envsView = (m: Match, repo: RepoView) => {
      const rows = envRows(m.environments, releases)
      const wide = Math.max(8, ...rows.map(r => r.name.length), 'your branch'.length) + 2

      return (
        <Box flexDirection="column">
          {repo.branch !== undefined &&
            row(
              <Box flexDirection="row">
                <Text color="claude">◆ </Text>
                <Text bold>{'your branch'.padEnd(wide)}</Text>
                <Text>{repo.head ?? ''}</Text>
              </Box>,
              <Text dimColor>{cap(repo.branch, Math.max(8, columns - wide - 12))}</Text>,
            )}
          {rows.map(r =>
            row(
              <Box flexDirection="row" key={`env-row-${r.name}`}>
                <Text color={r.open !== undefined ? 'warning' : r.target !== undefined ? 'success' : undefined} dimColor={r.open === undefined && r.target === undefined}>
                  {r.open !== undefined ? '◐ ' : r.target !== undefined ? '● ' : '○ '}
                </Text>
                <Text bold>{cap(r.name, wide - 1).padEnd(wide)}</Text>
                <Text>{cap(r.target ?? '', 18)}</Text>
              </Box>,
              <Text color={r.open !== undefined ? 'warning' : undefined} dimColor={r.open === undefined}>
                {r.open !== undefined ? `release ${r.open.status.replace(/_/g, ' ')}` : r.at !== undefined ? ago(r.at, now) : 'no release yet'}
              </Text>,
            ),
          )}
          {rows.length === 0 && <Text dimColor>No environments set up.</Text>}
          <Text> </Text>
          <Text dimColor>● deployed · ◐ release open · ○ nothing yet</Text>
        </Box>
      )
    }

    const devState = devStatus({ isOff: options['devCycles'] === 'off', cc, width: columns })
    const devView = () => (
      <Box flexDirection="column">
        {devState !== undefined && <Text color={devState.tone} dimColor={devState.tone === undefined}>{devState.text}</Text>}
        {devState === undefined && devRows.length === 0 && <Text dimColor>No dev cycle running. Start one in PlatformNEX.</Text>}
        {devRows.slice(0, 5).map(j => {
          const r = rowOf(j, now, columns)

          return (
            <Box flexDirection="column" key={`dev-${j.id}`}>
              {row(<Text color={r.tone}>{r.left}</Text>, <Text color={r.tone} dimColor={r.tone === undefined}>{r.right}</Text>)}
              <Text dimColor>{r.sub}</Text>
            </Box>
          )
        })}
        {devRows.length > 5 && <Text dimColor>{`+${devRows.length - 5} more`}</Text>}
        <Button key="log-toggle" plain hotkey="l" onPress={act(() => update($, ui, x => ({ ...x, logOpen: x.logOpen !== true })))}>
          {lead('l', u.logOpen === true ? 'short log' : 'full log')}
        </Button>
        {devLog.map((l, n) => (
          <Text key={`dev-log-${n}`} color={l.level === 'error' ? 'error' : l.level === 'warn' ? 'warning' : undefined} dimColor={l.level === 'info'}>
            {l.text}
          </Text>
        ))}
        {dc.local === 'old' && <Text dimColor>Update pnx for the live log on this machine</Text>}
        {dc.local === 'failed' && <Text dimColor>Log unavailable on this machine</Text>}
        {u.notice?.title === 'Dev cycle' && <Text color={u.notice.tone === 'error' ? 'error' : 'success'}>{cap(u.notice.text, columns * 2)}</Text>}
      </Box>
    )

    const checkStatus = checkState(u.check ?? { groups: [], isReady: false })
    const title = current === undefined ? 'PLATFORMNEX' : current.title ?? current.name

    return (
      <Box flexDirection="column">
        {/* Header: the component and its health on the left, icon buttons on the right; under it, dim, which
            PlatformNEX, then which repository and branch and how fresh. Problems only below that: an error, dev cycles offline. */}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text bold>{cap(title, Math.max(10, columns - 14)).toUpperCase()}</Text>
            {current !== undefined && <Text color={healthTone(currentStatus)}>{` ● ${healthLabel(currentStatus)}`}</Text>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button
              key="refresh"
              plain
              dimColor={u.isRefreshing === true}
              hotkey="r"
              onPress={act(async () => {
                // A fresh connection: sign in again with the key (a refused one goes back to setup) and read everything
                // again. Dev cycles that are not running start again now, with what they need looked up afresh (after
                // installing pnx or gh, say), not at the next retry. Running ones are left alone: a job may be under way.
                forgetToken()
                pollSoon()
                if (stopWorker === undefined && activeWorkerCfg() !== undefined) {
                  nextWorkerTry = 0
                  await setClaudeCode($, 'connecting')
                  keepWorker($, activeWorkerCfg())
                }
                await refresh($, cfg, true)
              })}
            >
              ⟳
            </Button>
            <Button
              key="check"
              plain
              hotkey="k"
              onPress={act(async () => {
                await update($, ui, x => ({ ...x, connOpen: false, confirmDisconnect: false }))
                await runCheck($, checkOptions())
              })}
            >
              ✓
            </Button>
            {u.connOpen !== true && (
              <Button
                key="conn-open"
                plain
                hotkey="s"
                onPress={act(() => update($, ui, x => ({ ...x, connOpen: true, confirmDisconnect: false, check: undefined, setupEnv: undefined, setupNote: undefined, setupDone: undefined })))}
              >
                ⚙
              </Button>
            )}
          </Box>
        </Box>
        {/* The terminal draws each hotkey beside its icon (r: ⟳); elsewhere one dim line says what the icons do. */}
        {!isTerminal && <Text dimColor>{cap(`r refresh · k check${isDev ? ' · l log' : ''}${u.connOpen === true ? '' : ' · s change'}`, columns)}</Text>}
        <Text dimColor>{cap(`connected to ${envLabel}`, columns)}</Text>
        {cfg.mode === 'signin' && <Text dimColor>{cap(u.signinEmail === undefined ? 'connected via sign-in' : `connected as ${u.signinEmail} via sign-in`, columns * 2)}</Text>}
        <Text dimColor>
          {cap(
            `${active === undefined ? '' : `${active.name}${active.branch === undefined ? '' : ` · ${cap(active.branch, 30)}`} · `}${matched} of ${d.repos.length} repos · ${u.isRefreshing === true ? 'refreshing…' : `updated ${ago(d.at, now)}`}`,
            columns * 2,
          )}
        </Text>
        {d.status === 'error' && d.error !== undefined && <Text color="error">{cap(d.error, columns * 2)}</Text>}
        {options['devCycles'] !== 'off' && cc.status === 'offline' && <Text color="warning">{cap(`○ Dev cycles offline · ${isTerminal ? 'k' : 'press k'} to see why`, columns * 2)}</Text>}
        {current?.detailNote !== undefined && <Text dimColor>{cap(current.detailNote, columns * 2)}</Text>}
        {/* Another component of this repository, or another repository: only when there is one to switch to. */}
        {(shown.length > 1 || d.repos.length > 1) && (
          <Box flexDirection="row" gap={2}>
            {shown.length > 1 && current !== undefined && (
              <Button
                key="next-component"
                plain
                hotkey="t"
                onPress={act(() => update($, ui, x => ({ ...x, activeEntity: shown[(shown.indexOf(current) + 1) % shown.length]?.entityRef })))}
              >
                {lead('t', `component ${shown.indexOf(current) + 1}/${shown.length}`)}
              </Button>
            )}
            {d.repos.length > 1 && (
              <Button key="repos-toggle" plain hotkey="w" onPress={act(() => update($, ui, x => ({ ...x, reposOpen: x.reposOpen !== true })))}>
                {lead('w', u.reposOpen === true ? 'hide repos' : 'switch repo')}
              </Button>
            )}
          </Box>
        )}
        {active !== undefined && active.matches.length > MAX_MATCHES && <Text dimColor>+{active.matches.length - MAX_MATCHES} more components in this repository</Text>}
        {rule}
        {/* Change the connection: another environment or key, or Disconnect. The one in use stays until a new key connects. */}
        {u.connOpen === true && (
          <Box flexDirection="column">
            {panel(
              'CONNECTION',
              'claude',
              <Button
                key="conn-close"
                plain
                hotkey="q"
                onPress={act(() => {
                  draftKey = ''

                  return update($, ui, x => ({ ...x, connOpen: false, confirmDisconnect: false, setupEnv: undefined, setupNote: undefined, setupDone: undefined }))
                })}
              >
                {lead('q', 'close')}
              </Button>,
              <Box flexDirection="column">
                {setupForm(u.setupEnv ?? environmentOf(cfg.base) ?? 'prod', cfg)}
                <Text> </Text>
                {u.confirmDisconnect === true ? (
                  <Box flexDirection="column">
                    <Text color="warning">{cap(`Disconnect from ${envLabel}?`, inner)}</Text>
                    <Text dimColor>{cap(cfg.mode === 'signin' ? 'Dev cycles stop, pnx signs out on this machine and the pane goes back to setup.' : 'Dev cycles stop and the pane goes back to setup.', inner * 2)}</Text>
                    <Box flexDirection="row" gap={1}>
                      <Button key="disconnect-yes" variant="primary" onPress={act(() => disconnect($, cfg))}>
                        Yes, disconnect
                      </Button>
                      <Button key="disconnect-no" onPress={act(() => update($, ui, x => ({ ...x, confirmDisconnect: false })))}>
                        No
                      </Button>
                    </Box>
                  </Box>
                ) : (
                  <Button key="disconnect" plain onPress={act(() => update($, ui, x => ({ ...x, confirmDisconnect: true })))}>
                    ⏻ disconnect
                  </Button>
                )}
              </Box>,
            )}
            {rule}
          </Box>
        )}
        {u.check !== undefined && (
          <Box flexDirection="column">
            {panel(
              'CHECK',
              checkStatus.tone,
              <Box flexDirection="row" gap={2}>
                <Text color={checkStatus.tone}>{checkStatus.text}</Text>
                <Button key="check-dismiss" plain hotkey="q" onPress={act(() => update($, ui, x => ({ ...x, check: undefined })))}>
                  {lead('q', 'close')}
                </Button>
              </Box>,
              checkBody(u.check),
            )}
            {rule}
          </Box>
        )}

        {/* The newest change plan Claude asked PlatformNEX for (or why that failed), with a link to Agent mode. */}
        {newest !== undefined && (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{cap(`ASK · ${newest.asked ?? newest.system ?? newest.title.toLowerCase()}`, Math.max(12, columns - 6))}</Text>
              <Box flexDirection="row" gap={1}>
                {expandable(newest) && (
                  <Button key="ask-toggle" plain hotkey="m" onPress={act(() => update($, ui, x => ({ ...x, askOpen: x.askOpen !== true })))}>
                    {lead('m', askOpen ? 'collapse' : 'expand')}
                  </Button>
                )}
                <Button key="ask-dismiss" plain hotkey="x" onPress={act(() => update($, ui, x => ({ ...x, askHidden: newest.id, askOpen: false })))}>
                  {isTerminal ? 'dismiss' : 'x'}
                </Button>
              </Box>
            </Box>
            {askPanel(newest)}
            {newest.kind === 'plan' && planUrl !== undefined && (
              <Link href={planUrl}>↗ Plan this in PlatformNEX (Agent mode)</Link>
            )}
            {rule}
          </Box>
        )}

        {/* Every repository found here, catalog ones first, a page at a time. Letters pick one, n and p turn the page. Shown only while open (w). */}
        {u.reposOpen === true && d.repos.length > 1 && (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>REPOSITORIES · {d.repos.length}</Text>
              {pages > 1 && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>
                    {page + 1}/{pages}
                  </Text>
                  <Button key="page-prev" plain hotkey="p" onPress={act(() => update($, ui, x => ({ ...x, page: Math.max(0, page - 1) })))}>
                    {isTerminal ? '‹' : '‹ p'}
                  </Button>
                  <Button key="page-next" plain hotkey="n" onPress={act(() => update($, ui, x => ({ ...x, page: Math.min(pages - 1, page + 1) })))}>
                    {isTerminal ? '›' : 'n ›'}
                  </Button>
                </Box>
              )}
            </Box>
            {pageRepos.map((r, i) => {
              const isActive = r.root === activeRoot
              const inCatalog = r.matches.length > 0
              const dot = isActive ? healthTone(currentStatus) : undefined
              const first = r.matches[0]
              const label = cap(`${first?.title ?? first?.name ?? r.name}${r.matches.length > 1 ? ` +${r.matches.length - 1}` : ''}`, Math.max(8, inner - 22))
              const where = inCatalog ? cap((first?.systemRefs[0] ?? 'no System').replace(/^system:/, ''), 16) : 'not in catalog'
              const letter = String.fromCharCode(97 + i)

              return (
                <Box flexDirection="row" justifyContent="space-between" key={`row-${r.root}`}>
                  {isActive ? (
                    <Box flexDirection="row">
                      <Text bold>{`▸ ${letter} `}</Text>
                      <Text color={dot}>● </Text>
                      <Text bold>{label}</Text>
                    </Box>
                  ) : (
                    <Button
                      key={`pick-${r.root}`}
                      plain
                      hotkey={letter}
                      onPress={act(async () => {
                        await update($, ui, x => ({ ...x, chosenRoot: r.root, reposOpen: false, activeEntity: undefined, pending: undefined, notice: undefined }))
                        await refresh($, cfg, true)
                      })}
                    >
                      {isTerminal ? `${inCatalog ? '●' : '○'} ${label}` : `  ${letter} ${inCatalog ? '●' : '○'} ${label}`}
                    </Button>
                  )}
                  <Text dimColor>{where}</Text>
                </Box>
              )
            })}
            {rule}
          </Box>
        )}

        {u.notice !== undefined && !(isDev && u.notice.title === 'Dev cycle') && (
          <Box flexDirection="column">
            {panel(
              u.notice.title ?? 'Release',
              u.notice.tone ?? (u.notice.text.startsWith('Could not') ? 'error' : 'success'),
              undefined,
              <Box flexDirection="column">
                <Text>{cap(u.notice.text, inner * 2)}</Text>
                {u.notice.url !== undefined && <Link href={u.notice.url}>Open in the portal</Link>}
              </Box>,
            )}
            {rule}
          </Box>
        )}

        {u.pending !== undefined && (
          <Box flexDirection="column">
            {panel(
              'Open a draft release?',
              'warning',
              undefined,
              <Box flexDirection="column">
                <Text>{cap(`${u.pending.entityRef.replace(/^component:/, '')} to ${u.pending.environmentName}`, inner)}</Text>
                <Text>{cap(`branch ${u.pending.branch}${u.pending.head === undefined ? '' : ` (local ${u.pending.head})`}`, inner)}</Text>
                <Text dimColor>This opens a draft. It does not deploy.</Text>
                <Text> </Text>
                <Box flexDirection="row" gap={1}>
                  <Button key="confirm" variant="primary" onPress={act(() => confirmDraft($, cfg, u.pending!))}>
                    Open draft
                  </Button>
                  <Button key="cancel" onPress={act(() => update($, ui, x => ({ ...x, pending: undefined })))}>
                    Cancel
                  </Button>
                </Box>
              </Box>,
            )}
            {rule}
          </Box>
        )}

        {active === undefined && d.repos.length === 0 && <Text dimColor>No git repository found here.</Text>}
        {active !== undefined && active.lookup === 'none' && <Text dimColor>Not in the PlatformNEX catalog, or not visible to you.</Text>}
        {active !== undefined && active.lookup === 'error' && <Text color="error">Couldn't look up this repo. Press ⟳ to try again.</Text>}

        {/* The views: one row to pick, then the view alone. The four of the component need one; Dev cycles does not. */}
        {u.reposOpen !== true && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={2}>
              {VIEWS.map((v, i) =>
                (current !== undefined && active !== undefined) || v.id === 'dev' ? (
                  <Button key={`view-${v.id}`} {...(v.id === view ? {} : { plain: true as const })} hotkey={String(i + 1)} onPress={act(() => showView(v.id))}>
                    {current !== undefined && active !== undefined ? lead(String(i + 1), v.label) : v.label}
                  </Button>
                ) : null,
              )}
            </Box>
            {rule}
            {view === 'dev' ? devView() : current === undefined || active === undefined ? undefined : view === 'live' ? liveView() : view === 'next' ? nextView() : view === 'release' ? releaseView(current, active) : envsView(current, active)}
          </Box>
        )}
      </Box>
    )
  })

  // One line above the prompt, pane open or not: a deploy under way, else how many things need the person.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cfg = activeCfg()
    const d = await read($, data)
    if (e.props.hasSurvey || cfg === undefined || d.status !== 'ok') return next(e)
    const u = await read($, ui)
    const roots = d.repos.map(r => r.root)
    const cwdRoot = d.repos.length === 0 ? undefined : rootContaining(await $.session.cwd(), roots)
    const activeRoot = [u.chosenRoot, cwdRoot, u.touchedRoot].find(r => r !== undefined && roots.includes(r)) ?? d.repos.find(r => r.matches.length > 0)?.root
    const shown = d.repos.find(r => r.root === activeRoot)?.matches.slice(0, MAX_MATCHES) ?? []
    const current = shown.find(m => m.entityRef === u.activeEntity) ?? shown[0]
    if (current === undefined) return next(e)
    const now = await $.clock.now()
    const releases = current.releases ?? []
    const deploying = releases.find(isDeploying)
    const needs = nextItems(current.title ?? current.name, current.health, releases, now)
    if (deploying === undefined && needs.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const step = deploying === undefined ? undefined : deploySteps(deploying).find(st => st.state === 'now' || st.state === 'failed')

    return (
      <Box flexDirection="row" gap={1}>
        {deploying !== undefined && (
          <Box flexDirection="row">
            <Text color={step?.state === 'failed' ? 'error' : 'warning'}>● </Text>
            <Text>{cap(`${deploying.environment ?? 'deploy'} · ${step === undefined ? 'deploying' : `${step.label}${step.note === undefined ? '' : ` ${step.note}`}`}`, 60)}</Text>
          </Box>
        )}
        {deploying !== undefined && needs.length > 0 && <Text dimColor>·</Text>}
        {needs.length > 0 && (
          <Box flexDirection="row">
            <Text color={needs[0]?.tone ?? 'warning'}>{needs[0]?.tone === 'error' ? '✗ ' : '⚠ '}</Text>
            <Text>{cap(`${needs.length} need${needs.length === 1 ? 's' : ''} you · ${needs[0]?.title ?? ''}`, 70)}</Text>
          </Box>
        )}
        <Text dimColor>/pnx-context</Text>
      </Box>
    )
  })
}
