import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { FIND_PNX, MIN_PNX } from '../hooks/worker'

const BASE = 'https://portal.example.test'
const KEY = 'pnx_test_key_do_not_use'
const OPTIONS = { baseUrl: BASE, apiKey: KEY }

const PANE = {
  plugin: 'pnx-context',
  component: 'Pane',
  requestId: 'pnx-context',
  props: { title: 'PlatformNEX', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// A remote carrying a login: it must never leave the machine or reach the screen.
const SCAN = '/w/gateway\thttps://someone:s3cret-token@github.com/ivedha-tech/gateway.git\tfeat/x\tabc1234\n'

const ENV = (id: number, name: string, isProduction: boolean) => ({ id, name, isProduction })
const BY_REPO = {
  success: true,
  data: { items: [{ entityRef: 'component:default/gateway', kind: 'Component', namespace: 'default', name: 'gateway', title: 'Gateway', systemRefs: ['system:default/platform'], environments: [ENV(1, 'staging', false), ENV(2, 'production', true)] }] },
}
const HEALTH = {
  success: true,
  data: {
    current: { status: 'degraded', computed_at: '2026-11-17T09:00:00Z', components: [{ entityRef: 'component:default/gateway', status: 'at_risk' }], reasons: [{ message: 'Build failing on main' }] },
    history: ['healthy', 'healthy', 'at_risk'].map(status => ({ status })),
  },
}
const BATCH = {
  success: true,
  data: {
    entries: [
      { status: 'ok', payload: { pipelines: [{ status: 'SUCCESS', createTime: '1' }, { status: 'FAILURE', createTime: '2' }] } },
      null,
    ],
  },
}
const json = (body: unknown, status = 200) => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) } })

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string }

// A folder as the stub compares it: forward slashes, lower-case drive, no trailing slash (as the plugin keeps it).
const same = (path: string): string => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`).replace(/\/+$/, '')

/** Stubs what sits beneath the mod: the host's network, shell and repo. Records every request. */
const stubWorld = (
  on: On,
  sent: Sent[],
  opts: {
    scan?: string
    releases?: unknown
    created?: unknown
    byRepo?: unknown
    byRepoStatus?: number
    tokenStatus?: number
    tokensBeforeRefusal?: number
    /** The lookup's answer for a host other than BASE, by its address. */
    byRepoAt?: Record<string, unknown>
    /** Holds the repository scan numbered `scan` (from 1) until `until` resolves: a refresh caught mid-way. */
    holdScan?: { scan: number; until: Promise<void> }
    /** What the pnx lookup prints, after `until` resolves: a worker caught while it starts. */
    findPnx?: { stdout: string; until: Promise<void> }
    /** Every process the plugin starts (pnx), recorded and refused. */
    spawned?: (readonly string[])[]
    /** The repository the session is in, as Claude Code names it (`C:\w\gateway` on Windows); absent, none. */
    inRepo?: string
    /** The environment each started process got, in order. */
    spawnEnv?: (Record<string, string> | undefined)[]
    /** Every command the plugin ran to completion (not started), in order. */
    runs?: (readonly string[])[]
    /** What the clipboard was given. */
    copied?: string[]
    /** Every line written to a log. */
    logs?: string[]
    /**
     * A fake pnx for sign in. `login`: what `pnx login` prints, piece by piece (a promise is waited for first), then its
     * exit code. `tokens`: what `pnx token` prints on each call (the last one repeats). `logout`: what `pnx logout` prints.
     */
    pnx?: { login?: (string | Promise<void>)[]; loginExit?: number; tokens?: string[]; logout?: string }
  } = {},
) => {
  let tokens = 0
  let scans = 0
  let tokenCalls = 0
  if (opts.copied !== undefined) on('ui.copy', (_, e) => {
    opts.copied?.push(e.text)

    return { value: { isCopied: true as const } }
  })
  if (opts.logs !== undefined) on('ui.log', (_, e) => {
    opts.logs?.push(JSON.stringify(e))

    return { value: undefined }
  })
  // A started process is recorded and ends at once, printing nothing; the fake pnx's login prints what it was given.
  on('process.spawn', async function* (_, e) {
    opts.spawned?.push(e.argv)
    opts.spawnEnv?.push(e.env)
    if (opts.pnx !== undefined && e.argv[2] === 'login') {
      for (const piece of opts.pnx.login ?? []) {
        if (typeof piece === 'string') yield { stream: 'stdout' as const, text: piece }
        else await piece
      }

      return { value: { code: opts.pnx.loginExit ?? 0, signal: null } }
    }

    return { value: { code: 1, signal: null } }
  })
  on('command.register', () => ({ value: { command: 'pnx-context' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/w/gateway' }))
  // The repositories on disk, from `scan`'s lines (folder, remote, branch, short sha): the folders listed and git's answers.
  const repos = (opts.scan ?? SCAN)
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [root = '', remote = '', branch = '', head = ''] = line.split('\t')

      return { root: same(root), remote, branch, head }
    })
  // Not in a repository unless `inRepo` names one: the plugin then looks through the folders.
  on('session.repo', async () => {
    // Every scan asks this first, once.
    if (++scans === opts.holdScan?.scan) await opts.holdScan.until

    return { value: opts.inRepo === undefined ? null : { root: opts.inRepo, remote: 'x', internal: false, name: null } }
  })
  on('fs.list', (_, e) => {
    const dir = same(e.path)
    const under = (root: string) => (root.startsWith(`${dir}/`) ? root.slice(dir.length + 1).split('/')[0] : undefined)
    const names = [...new Set(repos.map(r => under(r.root)).filter((n): n is string => n !== undefined))]
    const entry = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })

    return { value: [...(repos.some(r => r.root === dir) ? [entry('.git')] : []), ...names.map(entry)] }
  })
  on('process.run', async (_, e) => {
    opts.runs?.push(e.argv)
    if (opts.pnx !== undefined) {
      const done = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      const answers = opts.pnx.tokens ?? []
      if (e.argv[2] === 'token') return done(answers[Math.min(tokenCalls++, answers.length - 1)] ?? '')
      if (e.argv[2] === 'logout') return done(opts.pnx.logout ?? '')
      if (e.argv[2]?.includes('hostname')) return done('dev-laptop')
    }
    if (e.argv[0] === 'git') {
      const repo = repos.find(r => r.root === same(e.argv[2] ?? ''))
      const args = e.argv.slice(3).join(' ')
      const out = repo === undefined ? undefined : args === 'remote get-url origin' ? repo.remote : args === 'rev-parse --abbrev-ref HEAD' ? repo.branch : args === 'rev-parse --short HEAD' ? repo.head : undefined

      return { value: { exitCode: out === undefined || out === '' ? 128 : 0, stdout: out === undefined ? '' : `${out}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (opts.findPnx !== undefined && e.argv[2] === FIND_PNX) {
      await opts.findPnx.until

      return { value: { exitCode: 0, stdout: opts.findPnx.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    return { value: { exitCode: 0, stdout: opts.scan ?? SCAN, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_, e) => {
    sent.push({ url: e.url, method: e.init?.method ?? 'GET', headers: (e.init?.headers ?? {}) as Record<string, string>, body: typeof e.init?.body === 'string' ? e.init.body : undefined })
    if (e.url.endsWith('/auth/api-key-token') && opts.tokensBeforeRefusal !== undefined && ++tokens > opts.tokensBeforeRefusal) return json({ success: false }, 401)
    if (e.url.endsWith('/auth/api-key-token')) return opts.tokenStatus === undefined ? json({ success: true, data: { accessToken: 'short-lived', expiresIn: 900 } }) : json({ success: false, error: { message: 'This API key is invalid, expired or revoked.' } }, opts.tokenStatus)
    const elsewhere = Object.keys(opts.byRepoAt ?? {}).find(host => e.url.startsWith(`${host}/`))
    if (e.url.includes('/entities/by-repo') && elsewhere !== undefined) return json(opts.byRepoAt?.[elsewhere])
    if (e.url.includes('/entities/by-repo')) return opts.byRepoStatus === undefined ? json(opts.byRepo ?? BY_REPO) : json({ success: false }, opts.byRepoStatus)
    if (e.url.includes('/health')) return json(HEALTH)
    if (e.url.endsWith('/dashboard/batch')) return json(BATCH)
    if (e.url.includes('/releases') && (e.init?.method ?? 'GET') === 'POST') return json(opts.created ?? { success: true, data: { session: { id: 'rel-9' }, created: true } }, 201)
    if (e.url.includes('/releases')) return json(opts.releases ?? { success: true, data: { items: [] } })

    return json({ success: false }, 404)
  })
}

test('the pane shows the component, health, builds and releases, and no pull requests, on every surface', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const has = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

    expect(await has(/^GATEWAY$/)).toBe('GATEWAY')
    expect(await has(/platform/)).toMatch(/default\/platform/)
    // The component's own status wins over the System's.
    expect(await has(/at risk/)).toMatch(/● at risk/)
    expect(await has(/Build failing/)).toMatch(/Build failing on main/)
    // Pull requests are not drawn, and not asked for.
    expect(await has(/PULL REQUESTS/)).toBeUndefined()
    expect(await has(/pull requests/)).toBeUndefined()
    expect(await has(/Add by-repo route/)).toBeUndefined()
    expect(await has(/^RELEASES$/)).toBe('RELEASES')
    expect(await has(/^builds/)).toMatch(/^builds ×2/)
    expect(await has(/^health 3d/)).toMatch(/^health 3d/)
    // The short notes beside the gauges.
    expect(await has(/passing/)).toBe('50% passing')
    expect(await has(/at risk$/)).toMatch(/1 day at risk|● at risk/)
    await ui.unmount()
  }

  // The key goes to the configured host only, and only the first call carries it.
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.every(r => r.url.startsWith(`${BASE}/`))).toBe(true)
  expect(sent.filter(r => JSON.stringify(r.headers).includes(KEY)).map(r => r.url)).toEqual([`${BASE}/api/catalog/auth/api-key-token`])
  // The login in the remote is stripped before anything is sent.
  expect(sent.some(r => r.url.includes('s3cret') || r.url.includes('someone'))).toBe(false)
  // Read-only: nothing but reads, plus the cached-snapshot POST.
  expect(sent.filter(r => r.method !== 'GET').map(r => r.url)).toEqual([`${BASE}/api/catalog/auth/api-key-token`, `${BASE}/api/aggregator/dashboard/batch`])
  expect(sent.some(r => r.url.includes('/refresh'))).toBe(false)
})

test('without a URL and key the pane says how to set up and nothing is sent', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  // The default address is set; only the key is missing.
  expect((await ui.find({ type: 'Text', text: /of 2 set/ }))?.text).toBe('1 of 2 set')
  expect(sent).toEqual([])
  await ui.unmount()
})

test('an http URL is refused: the key is never sent over it', { options: { baseUrl: 'http://portal.example.test', apiKey: KEY } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(sent).toEqual([])
})

test('Start a release opens a draft only: confirm first, never production, never deploy', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Production has no button, only the reason.
  expect(await ui.find({ key: 'rel-component:default/gateway-2' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /production: in the portal/ }))?.text).toBeDefined()

  const before = sent.length
  await ui.press({ key: 'rel-component:default/gateway-1' })
  expect((await ui.find({ type: 'Text', text: /Open a draft release\?/ }))?.text).toBe('Open a draft release?')
  expect((await ui.find({ type: 'Text', text: /does not deploy/ }))?.text).toMatch(/It does not deploy/)
  expect((await ui.find({ type: 'Text', text: /branch feat\/x/ }))?.text).toMatch(/branch feat\/x \(local abc1234\)/)
  // Nothing was sent just by asking.
  expect(sent.slice(before).filter(r => r.method === 'POST' && r.url.endsWith('/releases'))).toEqual([])

  await ui.press({ key: 'confirm' })
  await clock.settle()

  const posts = sent.filter(r => r.method === 'POST' && r.url.endsWith('/api/catalog/releases'))
  expect(posts.length).toBe(1)
  expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ entityRef: 'component:default/gateway', environmentId: 1, targetKind: 'branch', targetRef: 'feat/x' })
  expect(sent.some(r => /\/(deploy|rollback|complete|canary|config|proposals)\b/.test(r.url))).toBe(false)
  expect((await ui.find({ type: 'Text', text: /Draft release opened/ }))?.text).toMatch(/Review and deploy it in the portal/)
  await ui.unmount()
})

test('a repository with several components gets a tab for each; the tab chosen decides what is shown', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const second = { ...BY_REPO.data.items[0], entityRef: 'component:default/web', name: 'web', title: 'Web' }
  stubWorld(on, sent, { byRepo: { success: true, data: { items: [BY_REPO.data.items[0], second] } } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'tab-component:default/gateway' })).toBeDefined()
  expect(await ui.find({ key: 'tab-component:default/web' })).toBeDefined()
  // The first component is shown until another tab is chosen.
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')
  expect(await ui.find({ type: 'Text', text: /^WEB$/ })).toBeUndefined()

  await ui.press({ key: 'tab-component:default/web' })
  expect((await ui.find({ type: 'Text', text: /^WEB$/ }))?.text).toBe('WEB')
  expect(await ui.find({ type: 'Text', text: /^GATEWAY$/ })).toBeUndefined()
  await ui.unmount()
})

test('an open release to the same environment is reused, not duplicated', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent, { releases: { success: true, data: { items: [{ id: 'rel-3', status: 'reviewing', environment_name: 'staging', target_ref: 'feat/x' }] } } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rel-component:default/gateway-1' })
  await ui.press({ key: 'confirm' })
  await clock.settle()

  expect(sent.filter(r => r.method === 'POST' && r.url.endsWith('/api/catalog/releases'))).toEqual([])
  expect((await ui.find({ type: 'Text', text: /already open/ }))?.text).toMatch(/already open \(reviewing\)/)
  await ui.unmount()
})

test('/pnx-context setup prints the commands to copy and never a key', { options: OPTIONS }, async ($, on) => {
  const sent: Sent[] = []
  stubWorld(on, sent)
  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })

  const { text = '' } = await $.command.run({ command: 'pnx-context', args: 'setup', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(text).toMatch(/read -rs K/)
  expect(text).toMatch(/claude plugin configure pnx-context@platformnex-abilities --values-stdin/)
  expect(text).toMatch(/\/plugin configure pnx-context@platformnex-abilities/)
  expect(text).toContain(`${BASE}/account/api-keys`)
  expect(text).not.toContain(KEY)
})

test('/pnx-context check passes every step with a good key, and shows the address but never the key', { options: OPTIONS }, async ($, on) => {
  const sent: Sent[] = []
  stubWorld(on, sent)
  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  sent.length = 0

  const { text = '' } = await $.command.run({ command: 'pnx-context', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(text).toMatch(/✓ URL set\s+https:\/\/portal\.example\.test/)
  expect(text).toMatch(/✓ API key set\s+\(hidden\)/)
  expect(text).toMatch(/✓ key accepted/)
  expect(text).toMatch(/✓ lookup route/)
  expect(text).toMatch(/Ready\./)
  expect(text).not.toContain(KEY)
  // It signs in afresh and asks the lookup route one question: nothing else.
  expect(sent.map(r => r.url)).toEqual([`${BASE}/api/catalog/auth/api-key-token`, expect.stringContaining('/entities/by-repo')])
})

test('/pnx-context check says when the server has no repo lookup yet', { options: OPTIONS }, async ($, on) => {
  const sent: Sent[] = []
  stubWorld(on, sent, { byRepoStatus: 404 })
  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })

  const { text = '' } = await $.command.run({ command: 'pnx-context', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(text).toMatch(/✓ key accepted/)
  expect(text).toMatch(/✗ lookup route\s+this PlatformNEX can't look up repos yet/)
  expect(text).toMatch(/ask the PlatformNEX team, or switch environment/)
  expect(text).toMatch(/Not ready yet/)
})

test('/pnx-context check names a key that was not accepted and skips the rest', { options: OPTIONS }, async ($, on) => {
  const sent: Sent[] = []
  stubWorld(on, sent, { tokenStatus: 401 })
  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })

  const { text = '' } = await $.command.run({ command: 'pnx-context', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(text).toMatch(/✗ key accepted\s+the API key was not accepted/)
  expect(text).toMatch(/create a new key in the portal and paste it in the pane/)
  expect(text).toMatch(/· lookup route\s+skipped/)
  expect(text).not.toContain(KEY)
})

test('/pnx-context check with no key sends nothing and says what is missing', { options: { baseUrl: BASE } }, async ($, on) => {
  const sent: Sent[] = []
  stubWorld(on, sent)
  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })

  const { text = '' } = await $.command.run({ command: 'pnx-context', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(text).toMatch(/✗ API key set\s+not set/)
  expect(sent).toEqual([])
})

test('the pane says the server has no repo lookup yet, not just "not found"', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent, { byRepoStatus: 404 })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /can't look up repos yet/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a state an earlier version stored is declined', { options: OPTIONS }, async ($, on) => {
  on('state.get', () => ({ value: { value: { repos: 'old' }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX|No git repository/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a folder with many repositories lists them a page at a time, and a repository can be picked', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const scan = Array.from({ length: 10 }, (_, i) => `/w/r${i}\thttps://github.com/ivedha-tech/r${i}.git\tmain\tabc123${i}\n`).join('')
  stubWorld(on, sent, { scan })
  // The folder holding them, not one of them: in a repository only that one is read.
  on('session.cwd', () => ({ value: '/w' }))

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /REPOSITORIES/ }))?.text).toMatch(/10/)
  // First page: eight rows, the one in view is not a button, the ninth repository is on the next page.
  expect(await ui.find({ key: 'pick-/w/r1' })).toBeDefined()
  expect(await ui.find({ key: 'pick-/w/r0' })).toBeUndefined()
  expect(await ui.find({ key: 'pick-/w/r8' })).toBeUndefined()

  await ui.press({ key: 'page-next' })
  expect(await ui.find({ key: 'pick-/w/r8' })).toBeDefined()
  expect(await ui.find({ key: 'pick-/w/r1' })).toBeUndefined()

  await ui.press({ key: 'pick-/w/r8' })
  await clock.settle()
  expect(await ui.find({ key: 'pick-/w/r8' })).toBeUndefined()
  expect(await ui.find({ key: 'pick-/w/r0' })).toBeDefined()
  await ui.unmount()
})

test('setup says ahead of time how the key will be kept, and says why a pasted key is refused', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Before any key: what will happen to it, never that it already was checked.
  expect((await ui.find({ type: 'Text', text: /never sent to the chat/ }))?.text).toBe('Saved for this plugin only, never sent to the chat.')
  expect((await ui.find({ type: 'Text', text: /\/pnx-context/ }))?.text).toBe('Closed this panel? Reopen it with /pnx-context.')
  expect(await ui.find({ type: 'Text', text: /The key is checked/ })).toBeUndefined()
  await ui.input({ key: 'setup-key', text: 'not a key' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /doesn't look like a PlatformNEX key/ }))?.text).toBeDefined()
  expect(sent).toEqual([])
  await ui.unmount()
})

test('change (s) opens the CONNECTION panel, and q closes it with the connection unchanged', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  await ui.press({ key: 'conn-open' })
  expect((await ui.find({ type: 'Text', text: /^CONNECTION$/ }))?.text).toBe('CONNECTION')
  expect(await ui.find({ key: 'setup-key' })).toBeDefined()
  expect(await ui.find({ key: 'disconnect' })).toBeDefined()
  // The open button hides while the panel is open.
  expect(await ui.find({ key: 'conn-open' })).toBeUndefined()

  await ui.press({ key: 'conn-close' })
  expect(await ui.find({ type: 'Text', text: /^CONNECTION$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')
  await ui.unmount()
})

test('a key that is not accepted while switching keeps the connection in use', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'conn-open' })
  await ui.input({ key: 'setup-key', text: 'not a key' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /doesn't look like a PlatformNEX key/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^CONNECTION$/ }))?.text).toBe('CONNECTION')
  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toMatch(/portal\.example\.test/)
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')
  await ui.unmount()
})

test('switching to another environment connects there at once and asks only that one', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)
  const DIT1 = 'https://agentic-platformnex-portal.dit1.ivedha.dev'

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'conn-open' })
  await ui.press({ key: 'env-dit1' })
  sent.length = 0
  await ui.input({ key: 'setup-key', text: 'pnx_other_test_key_do_not_use' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^CONNECTION$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to dit1')
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.every(r => r.url.startsWith(`${DIT1}/`))).toBe(true)
  // A token of its own: the one from the earlier connection is never sent to dit1.
  expect(sent.some(r => r.url === `${DIT1}/api/catalog/auth/api-key-token`)).toBe(true)
  // Neither key is ever drawn.
  expect(JSON.stringify(await ui.drawn())).not.toContain('pnx_other_test_key')
  expect(JSON.stringify(await ui.drawn())).not.toContain(KEY)
  await ui.unmount()
})

test('disconnect asks first, then goes back to setup and stops asking PlatformNEX', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'conn-open' })
  await ui.press({ key: 'disconnect' })

  // Nothing changes until yes.
  expect((await ui.find({ type: 'Text', text: /Disconnect from/ }))?.text).toMatch(/Disconnect from portal\.example\.test\?/)
  await ui.press({ key: 'disconnect-no' })
  expect(await ui.find({ type: 'Text', text: /Disconnect from/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')

  await ui.press({ key: 'disconnect' })
  await ui.press({ key: 'disconnect-yes' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect((await ui.find({ type: 'Text', text: /Disconnected/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^GATEWAY$/ })).toBeUndefined()

  sent.length = 0
  const { text = '' } = await $.command.run({ command: 'pnx-context', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(text).toMatch(/✗ API key set\s+not set/)
  expect(sent).toEqual([])
  await ui.unmount()
})

test('a saved key that is not a PlatformNEX key goes back to setup and says so, and nothing is sent', { options: { baseUrl: BASE, apiKey: 'not-a-platformnex-key' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect((await ui.find({ type: 'Text', text: /isn't a PlatformNEX key/ }))?.text).toMatch(/✗ The saved API key isn't a PlatformNEX key/)
  expect(await ui.find({ type: 'Text', text: /^connected to / })).toBeUndefined()
  expect(sent).toEqual([])
  await ui.unmount()
})

test('a key PlatformNEX refuses goes back to setup even with no repository to look up', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent, { scan: '', tokenStatus: 401 })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The key was tried (one sign-in) even though there was nothing to look up.
  expect(sent.some(r => r.url === `${BASE}/api/catalog/auth/api-key-token`)).toBe(true)
  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect((await ui.find({ type: 'Text', text: /no longer works/ }))?.text).toMatch(/Your API key no longer works on portal\.example\.test/)
  expect(await ui.find({ type: 'Text', text: /^connected to / })).toBeUndefined()
  await ui.unmount()
})

test('a good key with no repository to look up still shows Connected, after one sign-in', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent, { scan: '' })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  expect((await ui.find({ type: 'Text', text: /No git repository found here/ }))?.text).toBeDefined()
  expect(sent.map(r => r.url)).toEqual([`${BASE}/api/catalog/auth/api-key-token`])
  await ui.unmount()
})

test('refresh (r) is a fresh connection: it signs in again and reads everything again', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  sent.length = 0

  await ui.press({ key: 'refresh' })
  await clock.settle()

  // Not the cached token: a new sign-in with the key, then the lookup again.
  expect(sent[0]?.url).toBe(`${BASE}/api/catalog/auth/api-key-token`)
  expect(sent.some(r => r.url.includes('/entities/by-repo'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  await ui.unmount()
})

test('⟳ says "refreshing…" until the refresh ends, then when the pane last updated', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  let release = () => {}
  const until = new Promise<void>(resolve => {
    release = resolve
  })
  // The second scan is the ⟳ below: held, so the pane is seen mid-refresh.
  stubWorld(on, sent, { holdScan: { scan: 2, until } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const repoLine = async () => (await ui.find({ type: 'Text', text: /repos ·/ }))?.text
  expect(await repoLine()).toMatch(/repos · updated just now$/)

  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await repoLine()).toMatch(/repos · refreshing…$/)

  release()
  await clock.settle()
  expect(await repoLine()).toMatch(/repos · updated just now$/)
  await ui.unmount()
})

test('the header buttons are icons; the hotkey line shows only where the surface does not draw hotkeys', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'refresh' }))?.text).toBe('⟳')
    expect((await ui.find({ key: 'check' }))?.text).toBe('✓')
    expect((await ui.find({ key: 'conn-open' }))?.text).toBe('⚙')
    const legend = await ui.find({ type: 'Text', text: /^r refresh · k check · s change$/ })
    if (surface === 'terminal') expect(legend).toBeUndefined()
    else expect(legend).toBeDefined()
    await ui.unmount()
  }

  // With the CONNECTION panel open ⚙ is hidden, so the line doesn't offer it either.
  const code = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await code.press({ key: 'conn-open' })
  expect(await code.find({ key: 'conn-open' })).toBeUndefined()
  expect((await code.find({ type: 'Text', text: /^r refresh · k check/ }))?.text).toBe('r refresh · k check')
  await code.unmount()
})

test('in the terminal the key sits in a box with a connect button beside it, and the button connects', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await term.find({ key: 'setup-connect' }))?.text).toBe('connect')
  // Typed but not submitted: the button uses it.
  await term.input({ key: 'setup-key', text: 'not a key', kind: 'change' })
  await term.press({ key: 'setup-connect' })
  await clock.settle()
  expect((await term.find({ type: 'Text', text: /doesn't look like a PlatformNEX key/ }))?.text).toBeDefined()
  await term.unmount()

  // VS Code draws its own button for the field: no second one.
  const code = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await code.find({ key: 'setup-connect' })).toBeUndefined()
  await code.unmount()
})

test('the API keys address is dim text in the terminal and a short link elsewhere', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /\/account\/api-keys$/ })).toMatchObject({ props: { dimColor: true } })
  expect(await term.find({ type: 'Link' })).toBeUndefined()
  await term.unmount()

  const code = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await code.find({ type: 'Link' }))?.text).toMatch(/^↗ open API keys \(Production\)$/)
  await code.unmount()
})

test('CHECK shows one summary line, and only what failed with its fix', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'check' })
  await clock.settle()

  expect((await ui.find({ key: 'check-group-key' }))?.text).toBe('✓ key')
  expect((await ui.find({ key: 'check-group-lookup' }))?.text).toBe('✓ lookup')
  // The steps that passed are not listed one by one, and the address is not repeated.
  expect(await ui.find({ type: 'Text', text: /URL set/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /key format/ })).toBeUndefined()
  // Every line drawn under the summary is a failure or its fix.
  const fails = await ui.findAll({ type: 'Text', text: /^✗ / })
  const fixes = await ui.findAll({ type: 'Text', text: /^ {2}→ / })
  expect(fixes.length).toBeLessThanOrEqual(fails.length)
  await ui.unmount()
})

test('CHECK with a refused key says not ready and names the key, with its fix', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  // The key works for the pane's own reads, then is refused when the check signs in afresh.
  stubWorld(on, sent, { tokensBeforeRefusal: 1 })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'check' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /not ready/ }))?.text).toBe('✗ not ready')
  expect((await ui.find({ key: 'check-group-key' }))?.text).toBe('✗ key')
  expect((await ui.find({ type: 'Text', text: /^✗ key accepted/ }))?.text).toMatch(/the API key was not accepted/)
  expect((await ui.find({ type: 'Text', text: /→ create a new key/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('the header puts the connection first and the repository under a rule', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /^PLATFORMNEX$/ }))?.text).toBe('PLATFORMNEX')
  expect((await ui.find({ type: 'Text', text: /^✓ PlatformNEX/ }))?.text).toMatch(/^✓ PlatformNEX\s+$/)
  expect((await ui.find({ type: 'Text', text: /Dev cycles\s*$/ }))?.text).toMatch(/^[●○] Dev cycles\s+$/)
  expect((await ui.find({ type: 'Text', text: /repos ·/ }))?.text).toMatch(/^gateway · feat\/x · 1 of 1 repos · /)
  // The colour key shows with a component, as here.
  expect((await ui.find({ type: 'Text', text: /^health$/ }))?.text).toBe('health')
  await ui.unmount()
})

test('without a component the colour key is not shown', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent, { scan: '' })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  expect(await ui.find({ type: 'Text', text: /^health$/ })).toBeUndefined()
  await ui.unmount()
})

test('on Windows the repository you are in is found and shown, with no shell', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const ran: (readonly string[])[] = []
  stubWorld(on, sent, { inRepo: 'C:\\w\\gateway', scan: 'C:\\w\\gateway\thttps://github.com/ivedha-tech/gateway.git\tfeat/x\tabc1234\n' })
  on('session.cwd', () => ({ value: 'C:\\w\\gateway\\src' }))
  on('process.run', async (_, e, next) => {
    ran.push(e.argv)

    return next(e)
  })

  await $.session.start({ cwd: 'C:\\w\\gateway\\src', surface: 'vscode', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /repos ·/ }))?.text).toMatch(/^gateway · feat\/x · 1 of 1 repos · /)
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')
  // git is run directly, never through sh.
  expect(ran.some(argv => argv[0] === 'sh')).toBe(false)
  await ui.unmount()
})

test('on Windows the repositories under the folder are found by listing it', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const scan = ['a', 'b'].map(n => `C:\\w\\${n}\thttps://github.com/ivedha-tech/${n}.git\tmain\tabc123\n`).join('')
  stubWorld(on, sent, { scan })
  on('session.cwd', () => ({ value: 'C:\\w' }))

  await $.session.start({ cwd: 'C:\\w', surface: 'vscode', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /repos ·/ }))?.text).toMatch(/of 2 repos/)
  await ui.unmount()
})

test('a very broad folder is searched only so far, so a refresh never hangs on it', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent, { scan: '' })
  // Every folder holds 40 more (a home folder or a drive): 1 + 40 + 1600 folders two levels deep.
  let reads = 0
  let most = 0
  on('session.repo', async (_, e, next) => {
    // Each scan asks this first: count its folder reads on their own.
    reads = 0

    return next(e)
  })
  on('fs.list', () => {
    reads += 1
    most = Math.max(most, reads)

    return { value: Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()

  // Every folder one level down was read (repositories are usually there), and the search stopped at its cap.
  expect(most).toBeGreaterThan(41)
  expect(most).toBeLessThanOrEqual(500)
})

test('a refresh still running for the old connection never shows its data after a switch', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const DIT1 = 'https://agentic-platformnex-portal.dit1.ivedha.dev'
  const web = { ...BY_REPO.data.items[0], entityRef: 'component:default/web', name: 'web', title: 'Web' }
  let release = (): void => undefined
  const until = new Promise<void>(resolve => {
    release = resolve
  })
  // The second scan is the ⟳ refresh below, still with the old connection: it waits until the switch is done.
  stubWorld(on, sent, { holdScan: { scan: 2, until }, byRepoAt: { [DIT1]: { success: true, data: { items: [web] } } } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')

  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'conn-open' })
  await ui.press({ key: 'env-dit1' })
  await ui.input({ key: 'setup-key', text: 'pnx_other_test_key_do_not_use' })
  await clock.settle()
  // The old refresh ends now, with the old environment's answer.
  release()
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to dit1')
  expect((await ui.find({ type: 'Text', text: /^WEB$/ }))?.text).toBe('WEB')
  expect(await ui.find({ type: 'Text', text: /^GATEWAY$/ })).toBeUndefined()
  await ui.unmount()
})

test('a worker still looking for pnx when the connection is dropped never starts with the old key', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const spawned: (readonly string[])[] = []
  let release = (): void => undefined
  const until = new Promise<void>(resolve => {
    release = resolve
  })
  // pnx is there and new enough, but the lookup answers only after Disconnect.
  stubWorld(on, sent, { spawned, findPnx: { stdout: JSON.stringify({ cli: '/pnx/cli.js', version: MIN_PNX }), until } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'conn-open' })
  await ui.press({ key: 'disconnect' })
  await ui.press({ key: 'disconnect-yes' })
  await clock.settle()
  release()
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect(spawned).toEqual([])
  await ui.unmount()
})

test('a key PlatformNEX refuses is not retried for dev cycles', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  const spawned: (readonly string[])[] = []
  stubWorld(on, sent, { scan: '', tokenStatus: 401, spawned, findPnx: { stdout: JSON.stringify({ cli: '/pnx/cli.js', version: MIN_PNX }), until: Promise.resolve() } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  // At most the one start made before the first refresh found the key refused.
  const before = spawned.length
  expect(before).toBeLessThanOrEqual(1)

  // Well past the worker's retry wait, with a refresh every 15 seconds.
  await clock.advance(3 * 60_000)
  expect(spawned.length).toBe(before)
})

test('a saved key in any pnx_ form counts as set', { options: { baseUrl: BASE, apiKey: 'pnx_test.key+with=other/chars' } }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-17T09:30:00Z') })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  await ui.unmount()
})

test('in the terminal, connect can be pressed again after a failed try without typing again', { options: { baseUrl: BASE } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: Sent[] = []
  stubWorld(on, sent, { tokenStatus: 401 })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'setup-key', text: 'pnx_refused_test_key_do_not_use', kind: 'change' })

  await ui.press({ key: 'setup-connect' })
  await clock.settle()
  await ui.press({ key: 'setup-connect' })
  await clock.settle()

  // Both presses tried the key: one sign-in each.
  expect(sent.filter(r => r.url.endsWith('/auth/api-key-token')).length).toBe(2)
  await ui.unmount()
})

// ---- Sign in (single sign-on through pnx). pnx is faked: its login prints events, its token prints a short token. ----

const SIGNIN_OPTIONS = { baseUrl: BASE }
const NOW = Date.parse('2026-11-17T09:30:00Z')
const PNX_OK = JSON.stringify({ cli: '/pnx/cli.js', version: '0.1.19' })
const FIND_OK = { stdout: PNX_OK, until: Promise.resolve() }
const TOKEN_A = 'sso-access-token-AAAAAAAAAAAA'
const DEVICE_SECRET = 'pnxd_device_secret_value'
const REFRESH_SECRET = 'pnxr_refresh_secret_value'
const tokenLine = (token: string, endsAt: number) => JSON.stringify({ accessToken: token, expiresAt: new Date(endsAt).toISOString() })
const SIGNED_OUT_LINE = JSON.stringify({ error: 'signed_out' })
// pnx puts extra fields in its lines here on purpose: none of them may reach the screen, the state or a log.
const CODE_LINE = `${JSON.stringify({ event: 'code', userCode: 'ABCD-1234', verificationUri: `${BASE}/account/device-login`, verificationUriComplete: `${BASE}/account/device-login?code=ABCD-1234`, expiresIn: 600, deviceCode: DEVICE_SECRET })}\n`
const APPROVED_LINE = `${JSON.stringify({ event: 'approved', email: 'me@example.test', sessionExpiresAt: '2026-11-18T09:30:00Z', refreshToken: REFRESH_SECRET })}\n`
const errorLine = (code: string) => `${JSON.stringify({ event: 'error', code, message: 'text from pnx that is never shown' })}\n`
const gate = () => {
  let release = (): void => undefined
  const until = new Promise<void>(resolve => {
    release = resolve
  })

  return { until, release }
}

test('setup offers Sign in first and the API key below it, unchanged', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  stubWorld(on, sent)

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 'signin-start' }))?.text).toBe('Sign in')
  expect((await ui.find({ type: 'Text', text: /^Or use an API key$/ }))?.text).toBe('Or use an API key')
  expect(await ui.find({ key: 'setup-key' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^1  Create an API key$/ }))?.text).toBeDefined()
  expect(sent).toEqual([])
  await ui.unmount()
})

test('Sign in shows the link, the code and a countdown, then connects as the person, with no key and no secret kept', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  const spawned: (readonly string[])[] = []
  const spawnEnv: (Record<string, string> | undefined)[] = []
  const runs: (readonly string[])[] = []
  const copied: string[] = []
  const logs: string[] = []
  const writes: string[] = []
  on('state.set', (_, e, next) => {
    writes.push(JSON.stringify(e))

    return next(e)
  })
  const approval = gate()
  // The first `pnx token` (at start, nobody signed in yet) says signed out; once approved there is a token.
  stubWorld(on, sent, {
    spawned,
    spawnEnv,
    runs,
    copied,
    logs,
    findPnx: FIND_OK,
    pnx: { login: [CODE_LINE.slice(0, 40), CODE_LINE.slice(40), 'Opening nothing, this is not an event\n', approval.until, APPROVED_LINE], tokens: [SIGNED_OUT_LINE, tokenLine(TOKEN_A, NOW + 600_000)] },
  })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')

  await ui.press({ key: 'signin-start' })
  await clock.settle()
  // The code arrived in two pieces and an extra line: it is shown once, with the link and the time left.
  expect((await ui.find({ type: 'Text', text: /^ABCD-1234$/ }))?.text).toBe('ABCD-1234')
  expect((await ui.find({ type: 'Text', text: /device-login\?code=ABCD-1234/ }))?.text).toBe(`${BASE}/account/device-login?code=ABCD-1234`)
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toMatch(/Waiting for you · \d+:\d\d left/)
  expect(await ui.find({ key: 'signin-cancel' })).toBeDefined()
  expect(await ui.find({ key: 'signin-start' })).toBeUndefined()
  await ui.press({ key: 'signin-copy-code' })
  await ui.press({ key: 'signin-copy-link' })
  await clock.settle()
  expect(copied).toEqual(['ABCD-1234', `${BASE}/account/device-login?code=ABCD-1234`])
  expect(spawned.find(a => a[2] === 'login')).toEqual(['node', '/pnx/cli.js', 'login', '--json', '--no-open', '--client', 'pnx-context', '--name', 'dev-laptop', '--catalog-url', `${BASE}/api/catalog`])

  approval.release()
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  expect((await ui.find({ type: 'Text', text: /connected as/ }))?.text).toBe('connected as me@example.test via sign-in')
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')
  // The token came from pnx; no key was traded, and nothing else carried an Authorization.
  expect(sent.some(r => r.url.endsWith('/auth/api-key-token'))).toBe(false)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.every(r => r.headers['Authorization'] === `Bearer ${TOKEN_A}`)).toBe(true)
  // No key is saved or cleared: the plugin's settings are not rewritten.
  expect(runs.some(a => a.includes('configure'))).toBe(false)

  // Dev cycles start without any key: pnx reads the sign-in itself.
  await clock.advance(20_000)
  const worker = spawned.findIndex(a => a[2] === 'claude')
  expect(worker).toBeGreaterThanOrEqual(0)
  expect(spawnEnv[worker]).toEqual({ PNX_CATALOG_URL: `${BASE}/api/catalog` })

  // The device code, the refresh token and the access token are in no state, no log and nothing drawn.
  const everything = [JSON.stringify(await ui.drawn()), ...writes, ...logs].join('\n')
  for (const secret of [DEVICE_SECRET, REFRESH_SECRET, TOKEN_A, 'pnxd_', 'pnxr_']) expect(everything).not.toContain(secret)
  await ui.unmount()
})

test('Cancel ends the sign-in at once and goes back to the choice', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  const never = gate()
  stubWorld(on, sent, { findPnx: FIND_OK, pnx: { login: [CODE_LINE, never.until], tokens: [SIGNED_OUT_LINE] } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'signin-start' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^ABCD-1234$/ }))?.text).toBe('ABCD-1234')

  await ui.press({ key: 'signin-cancel' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /ABCD-1234/ })).toBeUndefined()
  expect((await ui.find({ key: 'signin-start' }))?.text).toBe('Sign in')
  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect(await ui.find({ type: 'Text', text: /^connected to / })).toBeUndefined()
  never.release()
  await ui.unmount()
})

for (const [name, line, text] of [
  ['denied in the portal', errorLine('denied'), /Sign-in was denied/],
  ['not available on this server (off)', errorLine('off'), /Sign in is not available here yet\. Use an API key\./],
  ['the code ran out', errorLine('expired'), /The code ran out/],
  ['no credential store', errorLine('store'), /secure credential store/],
] as const) {
  test(`a sign-in that ends as ${name} says so, offers the API key and never shows pnx's own text`, { options: SIGNIN_OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent: Sent[] = []
    stubWorld(on, sent, { findPnx: FIND_OK, pnx: { login: [CODE_LINE, line], loginExit: 1, tokens: [SIGNED_OUT_LINE] } })

    await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'signin-start' })
    await clock.settle()

    expect((await ui.find({ type: 'Text', text: /^✗ / }))?.text).toMatch(text)
    expect(JSON.stringify(await ui.drawn())).not.toContain('text from pnx that is never shown')
    // Not connected; Sign in can be pressed again and the key field is still there.
    expect(await ui.find({ type: 'Text', text: /^connected to / })).toBeUndefined()
    expect((await ui.find({ key: 'signin-start' }))?.text).toBe('Sign in')
    expect(await ui.find({ key: 'setup-key' })).toBeDefined()
    await ui.unmount()
  })
}

test('a sign-in that ends without an approval (pnx exits 0 without the event) is a failure, not a connection', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  stubWorld(on, sent, { findPnx: FIND_OK, pnx: { login: [CODE_LINE], loginExit: 0, tokens: [SIGNED_OUT_LINE, tokenLine(TOKEN_A, NOW + 600_000)] } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'signin-start' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^✗ / }))?.text).toMatch(/stopped before it finished/)
  expect(await ui.find({ type: 'Text', text: /^connected to / })).toBeUndefined()
  await ui.unmount()
})

test('without pnx, Sign in says so and points to the API key; nothing is started', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  const spawned: (readonly string[])[] = []
  stubWorld(on, sent, { spawned, findPnx: { stdout: JSON.stringify({ cli: '', version: '' }), until: Promise.resolve() } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'signin-start' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^✗ / }))?.text).toMatch(/not installed.*API key/)
  expect(await ui.find({ key: 'setup-key' })).toBeDefined()
  expect(spawned.some(a => a[2] === 'login')).toBe(false)
  await ui.unmount()
})

test('a sign-in made earlier connects again at start; its token is kept until a minute before it ends', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  const runs: (readonly string[])[] = []
  stubWorld(on, sent, { runs, findPnx: FIND_OK, pnx: { tokens: [tokenLine(TOKEN_A, NOW + 600_000), SIGNED_OUT_LINE] } })
  const tokenRuns = () => runs.filter(a => a[2] === 'token').length

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  // After a restart nobody tells the pane an email: connected, not "as" anyone.
  expect((await ui.find({ type: 'Text', text: /via sign-in/ }))?.text).toBe('connected via sign-in')
  expect(tokenRuns()).toBe(1)
  expect(sent.some(r => r.url.endsWith('/auth/api-key-token'))).toBe(false)

  // Still fresh at 3 minutes (the detail is read again after 2): the same token, no new pnx call.
  await clock.advance(180_000)
  expect(tokenRuns()).toBe(1)
  await ui.unmount()
})

test('when the sign-in has ended, the pane goes back to setup and says "Your sign-in ended. Sign in again."', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  stubWorld(on, sent, { findPnx: FIND_OK, pnx: { tokens: [tokenLine(TOKEN_A, NOW + 600_000), SIGNED_OUT_LINE] } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^GATEWAY$/ }))?.text).toBe('GATEWAY')

  // Past the token's end: the next call asks pnx, which says signed out.
  await clock.advance(10 * 60_000)

  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect((await ui.find({ type: 'Text', text: /Your sign-in ended/ }))?.text).toMatch(/Your sign-in ended\. Sign in again\./)
  expect((await ui.find({ key: 'signin-start' }))?.text).toBe('Sign in')
  expect(await ui.find({ type: 'Text', text: /^GATEWAY$/ })).toBeUndefined()
  await ui.unmount()
})

test('Disconnect in sign-in mode runs pnx logout, clears the pane and does not touch a saved key', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  const runs: (readonly string[])[] = []
  stubWorld(on, sent, { runs, findPnx: FIND_OK, pnx: { tokens: [tokenLine(TOKEN_A, NOW + 600_000)], logout: '{"event":"signed_out"}\n' } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'conn-open' })
  // The CONNECTION panel offers Sign in too, and says what Disconnect does here.
  expect(await ui.find({ key: 'signin-start' })).toBeDefined()
  await ui.press({ key: 'disconnect' })
  expect((await ui.find({ type: 'Text', text: /signs out on this machine/ }))?.text).toBeDefined()
  await ui.press({ key: 'disconnect-yes' })
  await clock.settle()

  expect(runs.find(a => a[2] === 'logout')).toEqual(['node', '/pnx/cli.js', 'logout', '--json', '--catalog-url', `${BASE}/api/catalog`])
  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  expect((await ui.find({ type: 'Text', text: /Signed out/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^GATEWAY$/ })).toBeUndefined()
  // Neither the plugin's settings nor anything else was rewritten for a key.
  expect(runs.some(a => a.includes('configure'))).toBe(false)
  await ui.unmount()
})

test('Disconnect says so when pnx could not end the sign-in', { options: SIGNIN_OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  stubWorld(on, sent, { findPnx: FIND_OK, pnx: { tokens: [tokenLine(TOKEN_A, NOW + 600_000)], logout: 'something went wrong\n' } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'conn-open' })
  await ui.press({ key: 'disconnect' })
  await ui.press({ key: 'disconnect-yes' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /could not end the sign-in/ }))?.text).toMatch(/Run pnx logout/)
  expect((await ui.find({ type: 'Text', text: /SET UP PLATFORMNEX/ }))?.text).toBe('SET UP PLATFORMNEX')
  await ui.unmount()
})

test('the API key path is untouched: it still trades the key, and the worker still gets it', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const sent: Sent[] = []
  const spawned: (readonly string[])[] = []
  const spawnEnv: (Record<string, string> | undefined)[] = []
  stubWorld(on, sent, { spawned, spawnEnv, findPnx: { stdout: JSON.stringify({ cli: '/pnx/cli.js', version: MIN_PNX }), until: Promise.resolve() } })

  await $.session.start({ cwd: '/w/gateway', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^connected to / }))?.text).toBe('connected to portal.example.test')
  expect(await ui.find({ type: 'Text', text: /via sign-in/ })).toBeUndefined()
  expect(sent.some(r => r.url.endsWith('/auth/api-key-token'))).toBe(true)
  // pnx 0.1.18 is enough for the key.
  const worker = spawned.findIndex(a => a[2] === 'claude')
  expect(worker).toBeGreaterThanOrEqual(0)
  expect(spawnEnv[worker]).toEqual({ PNX_CATALOG_URL: `${BASE}/api/catalog`, PNX_API_KEY: KEY })
  await ui.unmount()
})
