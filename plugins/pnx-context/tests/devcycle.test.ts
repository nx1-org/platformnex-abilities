import { expect, test } from 'claude-code/testing'

import { badge, devStatus, finishedNotice, logLines, parseActivity, parseLive, rowOf, visibleJobs } from '../hooks/devcycle'
import { MIN_ACTIVITY_PNX, WANT_ACTIVITY_PNX, WANT_PNX, isAtLeast } from '../hooks/worker'
import type { DevJob } from '../types'

const NOW = Date.parse('2026-11-25T10:30:00Z')
const job = (over: Partial<DevJob> = {}): DevJob => ({ id: 'j1', source: 'local', title: 'Add retry', state: 'running', files: 0, ...over })
const activity = (jobs: unknown[], events: unknown[] = []) => JSON.stringify({ v: 1, jobs, events })

test('reads pnx activity: named fields only, capped, control characters stripped', () => {
  const out = parseActivity(
    activity(
      [
        { id: 'a', kind: 'code', title: `Add\u001b[31m retry\n${'x'.repeat(200)}`, repo: 'acme/gateway', state: 'running', phase: 'writing', filesChanged: 4, startedAt: '2026-11-25T10:20:00Z', endedAt: null, prUrl: null, reason: null, extraField: 'nope' },
        { id: 'b', kind: 'code', title: 'Done one', repo: 'acme/gateway', state: 'done', phase: null, filesChanged: 2, startedAt: '2026-11-25T09:00:00Z', endedAt: '2026-11-25T09:10:00Z', prUrl: 'https://github.com/acme/gateway/pull/42', reason: null },
      ],
      [{ at: '2026-11-25T10:21:00Z', job: 'a', level: 'info', text: 'changed src/a.ts', extra: 1 }],
    ),
  )
  expect(out?.jobs.length).toBe(2)
  expect(out?.jobs[0]?.title.includes('\u001b')).toBe(false)
  expect(out?.jobs[0]?.title.length).toBe(80)
  expect(out?.jobs[0]?.phase).toBe('writing')
  expect(out?.jobs[0]?.files).toBe(4)
  expect(Object.keys(out?.jobs[0] ?? {}).includes('extraField')).toBe(false)
  expect(out?.jobs[1]?.pr).toBe(42)
  expect(JSON.stringify(out).includes('github.com')).toBe(false)
  expect(out?.events).toEqual([{ at: Date.parse('2026-11-25T10:21:00Z'), level: 'info', text: 'changed src/a.ts' }])
})

test('anything that is not pnx activity is nothing: junk, an error object, a wrong version, or too much', () => {
  expect(parseActivity('not json')).toBeUndefined()
  expect(parseActivity('')).toBeUndefined()
  expect(parseActivity('{"error":"unreadable"}')).toBeUndefined()
  expect(parseActivity('{"v":2,"jobs":[],"events":[]}')).toBeUndefined()
  expect(parseActivity('[1,2]')).toBeUndefined()
  expect(parseActivity(` ${'x'.repeat(300_000)}`)).toBeUndefined()
  expect(parseActivity('{"v":1,"jobs":[],"events":[]}')).toEqual({ jobs: [], events: [] })
  // Wrong types inside are skipped, not thrown on.
  expect(parseActivity(activity([null, 5, { id: 1 }, { id: 'x', state: 'weird' }], [null, { at: 'bad', text: 'x' }, { at: '2026-11-25T10:00:00Z' }]))).toEqual({ jobs: [], events: [] })
})

test('counts are capped: 10 jobs, the last 30 events', () => {
  const jobs = Array.from({ length: 25 }, (_, i) => ({ id: `j${i}`, title: 't', state: 'done' }))
  const events = Array.from({ length: 200 }, (_, i) => ({ at: '2026-11-25T10:00:00Z', level: 'info', text: `e${i}` }))
  const out = parseActivity(activity(jobs, events))
  expect(out?.jobs.length).toBe(10)
  expect(out?.events.length).toBe(30)
  expect(out?.events[29]?.text).toBe('e199')
})

test('a seeded secret in any field drops that job or event, and a bad repo or phase is not kept', () => {
  const out = parseActivity(
    activity(
      [
        { id: 'ok', title: 'fine', state: 'running', repo: 'not a repo', phase: 'rm -rf', reason: 'x' },
        { id: 'pnxr_abc', title: 'leaky id', state: 'running' },
        { id: 'r', title: 'fine', state: 'failed', reason: 'ghp_123456' },
      ],
      [
        { at: '2026-11-25T10:00:00Z', text: 'token eyJhbGciOi here' },
        { at: '2026-11-25T10:00:00Z', text: '-----BEGIN KEY' },
        { at: '2026-11-25T10:00:00Z', text: 'github_pat_x' },
        { at: '2026-11-25T10:00:00Z', text: 'sent Bearer abc' },
        { at: '2026-11-25T10:00:00Z', text: 'changed ok.ts' },
      ],
    ),
  )
  expect(out?.jobs.map(j => j.id)).toEqual(['ok', 'r'])
  expect(out?.jobs[0]?.repo).toBeUndefined()
  expect(out?.jobs[0]?.phase).toBeUndefined()
  expect(out?.jobs[1]?.reason).toBeUndefined()
  expect(out?.events.map(e => e.text)).toEqual(['changed ok.ts'])
})

test('reads the server live runs: named fields only, component not repository, never an address', () => {
  const jobs = parseLive({
    items: [
      { runId: 'r1', kind: 'generate', status: 'running', progress: { phase: 'writing', filesChanged: 3, areas: [{ label: 'x' }] }, startedAt: '2026-11-25T10:10:00Z', intent: 'Add retry', componentRef: 'component:default/gateway', requestedBy: 'someone@example.test', systemRef: 'system:default/p' },
      { runId: 'r2', status: 'starting', progress: null, startedAt: '2026-11-25T10:29:00Z', intent: null, componentRef: null },
      { runId: 'r3', status: 'succeeded' },
      { status: 'running' },
      'junk',
    ],
  })
  expect(jobs.map(j => j.id)).toEqual(['r1', 'r2'])
  expect(jobs[0]).toEqual({ id: 'r1', source: 'cloud', title: 'Add retry', repo: 'gateway', state: 'running', phase: 'writing', files: 3, startedAt: Date.parse('2026-11-25T10:10:00Z') })
  expect(jobs[1]?.state).toBe('waiting')
  expect(jobs[1]?.phase).toBe('starting')
  expect(jobs[1]?.title).toBe('Coding step')
  expect(JSON.stringify(jobs).includes('example.test')).toBe(false)
  expect(parseLive(undefined)).toEqual([])
  expect(parseLive({ items: 'x' })).toEqual([])
  expect(parseLive({ items: Array.from({ length: 50 }, (_, i) => ({ runId: `r${i}`, status: 'running' })) }).length).toBe(20)
})

test('rows are two short lines with a mark and a word for every state', () => {
  const running = rowOf(job({ phase: 'opening_pr', files: 4, repo: 'acme/gateway', startedAt: NOW - 3 * 60_000 }), NOW, 36)
  expect(running.left).toBe('◐ Add retry')
  expect(running.right).toBe('opening pr 4 files')
  expect(running.sub).toBe('  acme/gateway · this machine · 3m')
  expect(rowOf(job({ state: 'done', pr: 7, source: 'cloud', repo: 'gateway', startedAt: NOW - 90 * 60_000, endedAt: NOW - 20 * 60_000 }), NOW, 36)).toEqual({
    mark: '✓',
    tone: 'success',
    left: '✓ Add retry',
    right: 'PR #7',
    sub: '  gateway · cloud · 1h10m',
  })
  const failed = rowOf(job({ state: 'failed', reason: 'offline' }), NOW, 36)
  expect([failed.mark, failed.tone, failed.right]).toEqual(['✕', 'error', 'offline'])
  expect(rowOf(job({ state: 'interrupted' }), NOW, 36).mark).toBe('✕')
  expect(rowOf(job({ state: 'cancelled' }), NOW, 36).mark).toBe('⊘')
  const waiting = rowOf(job({ source: 'cloud', state: 'waiting', phase: 'queued' }), NOW, 36)
  expect([waiting.mark, waiting.right, waiting.sub]).toEqual(['⏸', 'queued', '  cloud'])
  // The two lines fit the pane.
  const long = rowOf(job({ title: 'x'.repeat(100), repo: `acme/${'y'.repeat(90)}`, phase: 'writing', files: 12 }), NOW, 36)
  expect(long.left.length + long.right.length + 1 <= 36).toBe(true)
  expect(long.sub.length <= 36).toBe(true)
  expect(rowOf(job({ startedAt: NOW - 5_000 }), NOW, 36).sub).toBe('  this machine · <1m')
})

test('running first, and a finished job from hours ago is left out', () => {
  const hour = 60 * 60_000
  const list = visibleJobs(
    [job({ id: 'old', state: 'done', endedAt: NOW - 3 * hour }), job({ id: 'recent', state: 'failed', endedAt: NOW - 5 * 60_000 }), job({ id: 'run' })],
    [job({ id: 'c1', source: 'cloud' })],
    NOW,
  )
  expect(list.map(j => j.id)).toEqual(['run', 'c1', 'recent'])
})

test('the log lines read HH:MM then the text, newest last, and are capped', () => {
  const at = Date.parse('2026-11-25T10:21:00Z')
  const events = Array.from({ length: 10 }, (_, i) => ({ at, level: 'info' as const, text: `event ${i}` }))
  const six = logLines(events, 6, 36)
  expect(six.length).toBe(6)
  expect(six[0]?.text).toMatch(/^\d\d:\d\d {2}event 4$/)
  expect(six[5]?.text).toMatch(/event 9$/)
  expect(logLines(events, 30, 36).length).toBe(10)
  expect(logLines([{ at, level: 'error', text: 'y'.repeat(100) }], 6, 20)[0]?.text.length).toBe(20)
  expect(logLines([], 6, 36)).toEqual([])
})

test('a job seen running that then finishes or fails gives one line; nothing else does', () => {
  const run = job()
  expect(finishedNotice([], [job({ state: 'done' })])).toBeUndefined()
  expect(finishedNotice([run], [run])).toBeUndefined()
  expect(finishedNotice([run], [])).toBeUndefined()
  expect(finishedNotice([run], [job({ state: 'cancelled' })])).toBeUndefined()
  expect(finishedNotice([run], [job({ state: 'done', pr: 9 })])).toEqual({ text: 'Dev cycle done: Add retry · PR #9', tone: 'success' })
  expect(finishedNotice([run], [job({ state: 'failed', reason: 'no changes' })])).toEqual({ text: 'Dev cycle failed: Add retry · no changes', tone: 'error' })
  expect(finishedNotice([run], [job({ state: 'interrupted' })])?.text).toBe('Dev cycle failed: Add retry · interrupted')
  // A cloud run leaving the live list says nothing about how it ended.
  expect(finishedNotice([job({ source: 'cloud' })], [])).toBeUndefined()
  // Another job's id is not this one.
  expect(finishedNotice([run], [job({ id: 'other', state: 'done' })])).toBeUndefined()
})

test('the log needs pnx 0.1.19, and asking for it does not change what the worker asks for', () => {
  expect(MIN_ACTIVITY_PNX).toBe('0.1.19')
  expect(isAtLeast('0.1.18', MIN_ACTIVITY_PNX)).toBe(false)
  expect(isAtLeast('0.1.19', MIN_ACTIVITY_PNX)).toBe(true)
  expect(WANT_ACTIVITY_PNX).toContain("'0.1.19'")
  expect(WANT_PNX).toContain("'0.1.18'")
})

test('the view badge counts running jobs, flags a failure not yet seen, and is empty when idle', () => {
  const failed = job({ id: 'f', state: 'failed', endedAt: NOW - 60_000 })
  expect(badge([], [], undefined, false, NOW)).toBe('')
  expect(badge([job()], [], undefined, false, NOW)).toBe('◐1')
  expect(badge([job(), job({ id: 'b' })], [job({ id: 'c', source: 'cloud' })], undefined, false, NOW)).toBe('◐3')
  // A waiting cloud run is not running.
  expect(badge([], [job({ source: 'cloud', state: 'waiting' })], undefined, false, NOW)).toBe('')
  expect(badge([failed], [], undefined, false, NOW)).toBe('✕')
  expect(badge([job(), failed], [], undefined, false, NOW)).toBe('◐1 ✕')
  // Seen once the view was left after it; never shown while the view is open.
  expect(badge([failed], [], NOW, false, NOW)).toBe('')
  expect(badge([failed], [], NOW - 120_000, false, NOW)).toBe('✕')
  expect(badge([failed], [], undefined, true, NOW)).toBe('')
  expect(badge([job({ id: 'i', state: 'interrupted', startedAt: NOW - 1000 })], [], undefined, false, NOW)).toBe('✕')
  expect(badge([job({ id: 'd', state: 'done', endedAt: NOW - 1000 }), job({ id: 'x', state: 'cancelled', endedAt: NOW - 1000 })], [], undefined, false, NOW)).toBe('')
})

test('the view says why the worker is not taking jobs, and says nothing running only when it is online', () => {
  const at = (cc: { status: 'connecting' | 'online' | 'offline'; note?: string }, isOff = false) => devStatus({ isOff, cc, width: 60 })
  expect(at({ status: 'online' })).toBeUndefined()
  expect(at({ status: 'connecting' })?.text).toMatch(/Connecting/)
  expect(at({ status: 'offline' }, true)?.text).toMatch(/turned off/)
  expect(at({ status: 'offline', note: 'pnx is not installed' })).toEqual({ text: '○ Not connected on this machine: pnx is not installed. Press k for the full check.', tone: 'warning' })
  expect(at({ status: 'offline' })?.text).toBe('○ Not connected on this machine. Press k for the full check.')
  // A note that looks like a secret is never shown; the long note is capped.
  expect(at({ status: 'offline', note: 'bad key pnx_abcdef123456' })?.text).not.toMatch(/pnx_/)
  expect((at({ status: 'offline', note: 'x'.repeat(500) })?.text.length ?? 999) < 200).toBe(true)
})
