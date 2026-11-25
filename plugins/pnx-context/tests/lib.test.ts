import { expect, test } from 'claude-code/testing'

import { bar, baseName, deploySteps, envRows, isAbsolutePath, liveRelease, nextItems, normalizePath, parsePhases, parseReleases, reviewProgress, rootContaining, scannedRepo, took } from '../hooks/lib'

test('a folder is spelled one way on every OS', () => {
  expect(normalizePath('C:\\work\\Agentic-portal\\')).toBe('c:/work/Agentic-portal')
  expect(normalizePath('c:/work/x')).toBe('c:/work/x')
  expect(normalizePath('C:\\')).toBe('c:/')
  expect(normalizePath('/home/me/x/')).toBe('/home/me/x')
  expect(normalizePath('/')).toBe('/')
})

test('absolute paths are recognised on every OS', () => {
  for (const path of ['/home/me/x.ts', 'C:\\w\\x.ts', 'c:/w/x.ts', '\\\\server\\share\\x.ts']) expect(isAbsolutePath(path)).toBe(true)
  for (const path of ['x.ts', 'src\\x.ts', 'C:x.ts', '']) expect(isAbsolutePath(path)).toBe(false)
})

test('the repository holding a path is found however Windows spells either', () => {
  const roots = ['c:/w/gateway', 'c:/w/gateway/packages/inner', '/home/me/portal']
  expect(rootContaining('C:\\w\\gateway\\src\\x.ts', roots)).toBe('c:/w/gateway')
  expect(rootContaining('C:\\W\\Gateway\\src\\x.ts', roots)).toBe('c:/w/gateway')
  // The deepest wins when repositories nest.
  expect(rootContaining('c:/w/gateway/packages/inner/a.ts', roots)).toBe('c:/w/gateway/packages/inner')
  expect(rootContaining('C:\\w\\gateway', roots)).toBe('c:/w/gateway')
  // A neighbour with the same start is not inside it.
  expect(rootContaining('C:\\w\\gateway-old\\x.ts', roots)).toBeUndefined()
  // macOS and Linux paths stay case-sensitive, as before.
  expect(rootContaining('/home/me/portal/src/x.ts', roots)).toBe('/home/me/portal')
  expect(rootContaining('/home/me/Portal/src/x.ts', roots)).toBeUndefined()
})

test('a repository read by git keeps a clean remote and a usable branch', () => {
  expect(scannedRepo('C:\\w\\gateway', 'https://someone:s3cret@github.com/o/gateway.git\n', 'feat/x\n', 'abc1234\n')).toEqual({
    root: 'c:/w/gateway',
    remote: 'https://github.com/o/gateway.git',
    branch: 'feat/x',
    head: 'abc1234',
  })
  // A detached HEAD and a repository with no remote or commit yet.
  expect(scannedRepo('/w/new', '', 'HEAD', '')).toEqual({ root: '/w/new', remote: undefined, branch: undefined, head: undefined })
})

test('a folder name is read from either kind of path', () => {
  expect(baseName('C:\\w\\gateway')).toBe('gateway')
  expect(baseName('/w/gateway/')).toBe('gateway')
})

const NOW = Date.parse('2026-11-17T09:30:00Z')

test('a release session is cut down to what the pane draws', () => {
  const [r] = parseReleases({ items: [{ id: 'rel-1', status: 'deploying', environment_id: 1, environment_name: 'staging', target_ref: 'v1.2.0', target_sha: 'a81d07c9f0aa', tag_pushed_at: '2026-11-17T09:26:00Z', pipeline_run_id: 'b-1', rollout: { state: 'watching' }, build_recovery: null }] })
  expect(r).toMatchObject({ id: 'rel-1', status: 'deploying', environment: 'staging', environmentId: 1, target: 'v1.2.0', sha: 'a81d07c', hasBuild: true, isBuildMissing: false, rollout: 'watching' })
  expect(parseReleases({ items: [{ status: 'x' }] })).toEqual([])
  expect(parsePhases({ phases: [{ phase: 'readiness', status: 'stale', stale_reason: 'why' }, { status: 'x' }] })).toEqual([{ phase: 'readiness', status: 'stale', staleReason: 'why' }])
})

test('a deploy reads as steps from what the session records', () => {
  const base = { id: 'r', status: 'deploying' }
  expect(deploySteps({ ...base, status: 'awaiting_approval' }).map(s => `${s.label}:${s.state}`)).toEqual(['Approval:now', 'Build:todo', 'Deployed:todo'])
  expect(deploySteps({ ...base, tagPushedAt: 1 }).map(s => `${s.label}:${s.state}:${s.note ?? ''}`)).toEqual(['Tag pushed:done:', 'Build:now:waiting to start', 'Deployed:todo:'])
  expect(deploySteps({ ...base, tagPushedAt: 1, isBuildMissing: true })[1]).toEqual({ label: 'Build', state: 'failed', note: 'did not start' })
  expect(deploySteps({ ...base, hasBuild: true, rollout: 'watching' }).map(s => `${s.label}:${s.state}`)).toEqual(['Build:done', 'Rollout:now', 'Deployed:todo'])
  expect(deploySteps({ ...base, status: 'succeeded', hasBuild: true }).map(s => s.state)).toEqual(['done', 'done'])
  expect(deploySteps({ ...base, status: 'failed', hasBuild: true }).map(s => s.state)).toEqual(['failed', 'failed'])
})

test('Live shows a deploy under way, else the one that just ended, and nothing older', () => {
  const ended = { id: 'a', status: 'succeeded', completedAt: NOW - 10 * 60_000 }
  const old = { id: 'b', status: 'failed', completedAt: NOW - 3 * 60 * 60_000 }
  const running = { id: 'c', status: 'deploying' }
  expect(liveRelease([ended, old, running], NOW)?.id).toBe('c')
  expect(liveRelease([old, ended], NOW)?.id).toBe('a')
  expect(liveRelease([old], NOW)).toBeUndefined()
})

test('review progress leaves the deploy phase out and names where it stopped', () => {
  const p = reviewProgress([{ phase: 'overview', status: 'acknowledged' }, { phase: 'readiness', status: 'computed' }, { phase: 'impact', status: 'pending' }, { phase: 'deploy', status: 'pending' }])
  expect(p.done).toBe(1)
  expect(p.total).toBe(3)
  expect(p.current?.phase).toBe('readiness')
  expect(p.rest.map(x => x.phase)).toEqual(['impact'])
  expect(bar(1, 3)).toBe('▰▱▱')
  expect(took(0, 252_000)).toBe('4m 12s')
  expect(took(undefined, 1)).toBe('')
})

test('each environment gets what last deployed there and its open release', () => {
  const envs = [{ id: 1, name: 'staging', isProduction: false }, { id: 2, name: 'production', isProduction: true }]
  const rows = envRows(envs, [
    { id: 'o', status: 'reviewing', environmentId: 2 },
    { id: 'n', status: 'succeeded', environmentId: 1, target: 'v2', completedAt: 20 },
    { id: 'm', status: 'succeeded', environmentId: 1, target: 'v1', completedAt: 10 },
  ])
  expect(rows[0]).toMatchObject({ name: 'staging', target: 'v2', at: 20 })
  expect(rows[0]?.open).toBeUndefined()
  expect(rows[1]?.target).toBeUndefined()
  expect(rows[1]?.open?.id).toBe('o')
})

test('what needs the person comes most urgent first, and server text is quoted as data in a prompt', () => {
  const health = { status: 'at_risk', reasons: ['Build failing on main'], history: [] }
  const items = nextItems('Gateway', health, [
    { id: 'f', status: 'failed', environment: 'staging', target: 'v2', completedAt: NOW - 60_000, outcome: 'Build step 3 failed' },
    { id: 'g', status: 'ready', environment: 'production' },
  ], NOW)
  expect(items.map(i => i.id)).toEqual(['failed-f', 'ready-g', 'health-0'])
  const fix = items[0]?.action
  expect(fix?.kind).toBe('prompt')
  if (fix?.kind === 'prompt') {
    expect(fix.text).toMatch(/quoted as data: "Build step 3 failed"/)
    expect(fix.text).toMatch(/Do not deploy\.$/)
  }
  // A later good release to the same environment clears the failure.
  expect(nextItems('Gateway', undefined, [{ id: 'ok', status: 'succeeded', environment: 'staging', completedAt: NOW }, { id: 'f', status: 'failed', environment: 'staging', completedAt: NOW - 60_000 }], NOW)).toEqual([])
})
