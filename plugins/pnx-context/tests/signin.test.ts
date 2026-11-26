import { expect, test } from 'claude-code/testing'

import {
  LOGIN_START,
  MIN_PNX_SIGNIN,
  SIGNED_OUT,
  TOKEN_FAILURE_TEXT,
  countdown,
  deviceName,
  endLoginState,
  failedMessage,
  isSignedOutLine,
  isTokenFresh,
  lineSplitter,
  loginView,
  loginArgv,
  logoutArgv,
  nextLoginState,
  parseLoginLine,
  parseTokenOutput,
  pnxProblem,
  safeLink,
  tokenArgv,
  type LoginEvent,
  type LoginState,
} from '../hooks/signin'
import { wantPnx } from '../hooks/worker'

const BASE = 'https://portal.example.test'
const CODE = JSON.stringify({ event: 'code', userCode: 'abcd-1234', verificationUri: `${BASE}/account/device-login`, verificationUriComplete: `${BASE}/account/device-login?code=ABCD-1234`, expiresIn: 600 })
const APPROVED = JSON.stringify({ event: 'approved', email: 'me@example.test', sessionExpiresAt: '2026-11-23T20:00:00Z' })
const ctx = { now: 1_000_000, base: BASE }

test('reads pnx login lines: junk, unknown events and malformed events are skipped', () => {
  expect(parseLoginLine(CODE)).toEqual({ event: 'code', userCode: 'ABCD-1234', link: `${BASE}/account/device-login?code=ABCD-1234`, expiresIn: 600 })
  expect(parseLoginLine(APPROVED)).toEqual({ event: 'approved', email: 'me@example.test' })
  expect(parseLoginLine('{"event":"error","code":"denied","message":"whatever pnx says"}')).toEqual({ event: 'error', code: 'denied' })
  expect(parseLoginLine('{"event":"error","code":"something-new"}')).toEqual({ event: 'error', code: 'unknown' })
  // Not events, or not ones we know: ignored, never trusted.
  expect(parseLoginLine('Opening your browser…')).toBeUndefined()
  expect(parseLoginLine('')).toBeUndefined()
  expect(parseLoginLine('{"event":"progress","percent":5}')).toBeUndefined()
  expect(parseLoginLine('{"event":"code"}')).toBeUndefined()
  expect(parseLoginLine('{"event":"code","userCode":"not a code","verificationUriComplete":"https://x"}')).toBeUndefined()
  expect(parseLoginLine('{"event":"code","userCode":"ABCD-1234"}')).toBeUndefined()
  expect(parseLoginLine('[1,2]')).toBeUndefined()
  expect(parseLoginLine('{"event":"approved","email":"not an email"}')).toEqual({ event: 'approved', email: undefined })
  expect(parseLoginLine(`{"event":"approved","email":"${'a'.repeat(500)}@x.test"}`)).toEqual({ event: 'approved', email: undefined })
  expect(parseLoginLine(`{"event":"approved","pad":"${'x'.repeat(9000)}"}`)).toBeUndefined()
})

test('only the fields it uses are ever kept: a device code or token in a line goes nowhere', () => {
  const noisy = JSON.stringify({ event: 'code', userCode: 'ABCD-1234', verificationUriComplete: `${BASE}/x`, deviceCode: 'pnxd_secret', refreshToken: 'pnxr_secret', accessToken: 'tok' })
  const parsed = parseLoginLine(noisy)
  expect(JSON.stringify(parsed)).not.toMatch(/pnxd_|pnxr_|tok"|deviceCode|refreshToken|accessToken/)
  const approved = parseLoginLine(JSON.stringify({ event: 'approved', email: 'me@example.test', refreshToken: 'pnxr_secret', privateKey: 'k' }))
  expect(JSON.stringify(approved)).not.toMatch(/pnxr_|privateKey/)
})

test('splits output into whole lines whatever the chunking', () => {
  const s = lineSplitter()
  expect(s.feed('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
  expect(s.feed(':2}\r\nrest')).toEqual(['{"b":2}'])
  expect(s.flush()).toEqual(['rest'])
  expect(s.flush()).toEqual([])
  // A runaway line with no end is dropped, not kept in memory.
  const runaway = lineSplitter()
  expect(runaway.feed('x'.repeat(20_000))).toEqual([])
  expect(runaway.flush()).toEqual([])
})

test('only a link on the same https host as the PlatformNEX in use is shown', () => {
  expect(safeLink(`${BASE}/account/device-login?code=ABCD-1234`, BASE)).toBe(`${BASE}/account/device-login?code=ABCD-1234`)
  expect(safeLink('https://evil.example/login', BASE)).toBeUndefined()
  expect(safeLink(`http://portal.example.test/x`, BASE)).toBeUndefined()
  expect(safeLink(`https://me:pw@portal.example.test/x`, BASE)).toBeUndefined()
  expect(safeLink('javascript:alert(1)', BASE)).toBeUndefined()
  expect(safeLink('not a url', BASE)).toBeUndefined()
  expect(safeLink('http://localhost:3000/x', 'http://localhost:3000')).toBe('http://localhost:3000/x')
})

const code = parseLoginLine(CODE) as LoginEvent
const approved = parseLoginLine(APPROVED) as LoginEvent

test('the sign-in goes starting, waiting, approved; events out of order change nothing', () => {
  const waiting = nextLoginState(LOGIN_START, code, ctx)
  expect(waiting).toEqual({ phase: 'waiting', userCode: 'ABCD-1234', link: `${BASE}/account/device-login?code=ABCD-1234`, expiresAt: 1_000_000 + 600_000 })
  // Approved before any code, a second code, and anything after the end: ignored.
  expect(nextLoginState(LOGIN_START, approved, ctx)).toEqual(LOGIN_START)
  expect(nextLoginState(waiting, { ...(code as object), userCode: 'ZZZZ-9999' } as LoginEvent, ctx)).toEqual(waiting)
  const done = nextLoginState(waiting, approved, ctx)
  expect(done).toEqual({ phase: 'approved', email: 'me@example.test' })
  expect(nextLoginState(done, { event: 'error', code: 'denied' }, ctx)).toEqual(done)
  expect(nextLoginState(done, code, ctx)).toEqual(done)
})

test('a link for another host fails the sign-in; an error event ends it with its code', () => {
  const other = { ...(code as object), link: 'https://evil.example/x' } as LoginEvent
  expect(nextLoginState(LOGIN_START, other, ctx)).toEqual({ phase: 'failed', code: 'link' })
  expect(nextLoginState(LOGIN_START, { event: 'error', code: 'off' }, ctx)).toEqual({ phase: 'failed', code: 'off' })
  const waiting = nextLoginState(LOGIN_START, code, ctx)
  expect(nextLoginState(waiting, { event: 'error', code: 'expired' }, ctx)).toEqual({ phase: 'failed', code: 'expired' })
  const failed: LoginState = { phase: 'failed', code: 'denied' }
  expect(nextLoginState(failed, approved, ctx)).toEqual(failed)
})

test('success needs the approved event and exit 0; a process that ends otherwise is a failure', () => {
  const waiting = nextLoginState(LOGIN_START, code, ctx)
  const done = nextLoginState(waiting, approved, ctx)
  expect(endLoginState(done, 0)).toEqual(done)
  expect(endLoginState(done, 1)).toEqual({ phase: 'failed', code: 'stopped' })
  expect(endLoginState(waiting, 0)).toEqual({ phase: 'failed', code: 'stopped' })
  expect(endLoginState(LOGIN_START, null)).toEqual({ phase: 'failed', code: 'stopped' })
  expect(endLoginState({ phase: 'failed', code: 'denied' }, 1)).toEqual({ phase: 'failed', code: 'denied' })
})

test('counts the time left, and the pane view holds only what the person sees', () => {
  expect(countdown(10_000 + 600_000, 10_000)).toBe('10:00')
  expect(countdown(10_000 + 61_500, 10_000)).toBe('1:02')
  expect(countdown(5_000, 10_000)).toBe('0:00')
  const waiting = nextLoginState(LOGIN_START, code, ctx)
  expect(loginView(waiting, 5)).toEqual({ phase: 'waiting', userCode: 'ABCD-1234', link: `${BASE}/account/device-login?code=ABCD-1234`, expiresAt: 1_600_000, at: 5 })
  expect(loginView({ phase: 'failed', code: 'off' }, 5)).toEqual({ phase: 'failed', message: failedMessage('off') })
})

test('every failure has fixed text that offers the API key, and none repeats what pnx printed', () => {
  expect(failedMessage('off')).toBe('Sign in is not available here yet. Use an API key.')
  expect(failedMessage('denied')).toMatch(/denied/)
  for (const c of ['denied', 'expired', 'off', 'proof', 'network', 'store', 'unknown', 'link', 'stopped'] as const) expect(failedMessage(c)).toMatch(/API key|Sign in again|Try again/)
})

test('says why sign in cannot start when pnx is missing or too old, and never falls back silently', () => {
  expect(pnxProblem({})).toMatch(/not installed.*API key/)
  expect(pnxProblem({ cli: '/p/cli.js', version: '0.1.18' })).toMatch(/0\.1\.20 or newer \(this is 0\.1\.18\).*API key/)
  expect(pnxProblem({ cli: '/p/cli.js', version: undefined })).toMatch(/this is unknown/)
  expect(pnxProblem({ cli: '/p/cli.js', version: '0.1.20' })).toBeUndefined()
})

test('asks pnx-fast-dev for the pnx that sign in needs', () => {
  expect(wantPnx(MIN_PNX_SIGNIN)).toContain(`'0.1.20'`)
})

test('builds the pnx commands as argument lists with the portal catalog address, no shell', () => {
  expect(loginArgv('/p/cli.js', BASE, 'dev-laptop')).toEqual(['node', '/p/cli.js', 'login', '--json', '--client', 'pnx-context', '--name', 'dev-laptop', '--catalog-url', `${BASE}/api/catalog`])
  expect(tokenArgv('/p/cli.js', BASE)).toEqual(['node', '/p/cli.js', 'token', '--json', '--catalog-url', `${BASE}/api/catalog`])
  expect(logoutArgv('/p/cli.js', BASE)).toEqual(['node', '/p/cli.js', 'logout', '--json', '--catalog-url', `${BASE}/api/catalog`])
  expect(deviceName('  my\tlaptop\n')).toBe('my laptop')
  expect(deviceName('')).toBe('Claude Code')
  expect(deviceName(undefined)).toBe('Claude Code')
  expect(deviceName('x'.repeat(200)).length).toBe(60)
})

const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.sample-access-token.signature'

test('reads pnx token output: the token and when it ends, or why not; junk lines are skipped', () => {
  const at = '2026-11-23T10:10:00.000Z'
  expect(parseTokenOutput(JSON.stringify({ accessToken: TOKEN, expiresAt: at }))).toEqual({ ok: true, accessToken: TOKEN, expiresAt: Date.parse(at) })
  expect(parseTokenOutput(`warming up\n${JSON.stringify({ accessToken: TOKEN, expiresAt: at })}\n`)).toEqual({ ok: true, accessToken: TOKEN, expiresAt: Date.parse(at) })
  for (const reason of ['signed_out', 'network', 'store', 'off'] as const) expect(parseTokenOutput(JSON.stringify({ error: reason }))).toEqual({ ok: false, reason })
  expect(parseTokenOutput('{"error":"brand-new"}')).toEqual({ ok: false, reason: 'bad' })
  expect(parseTokenOutput('')).toEqual({ ok: false, reason: 'bad' })
  expect(parseTokenOutput('not json')).toEqual({ ok: false, reason: 'bad' })
  expect(parseTokenOutput(JSON.stringify({ accessToken: 'has spaces and is odd', expiresAt: at }))).toEqual({ ok: false, reason: 'bad' })
  expect(parseTokenOutput(JSON.stringify({ accessToken: TOKEN }))).toEqual({ ok: false, reason: 'bad' })
  expect(parseTokenOutput(JSON.stringify({ accessToken: TOKEN, expiresAt: 'soon' }))).toEqual({ ok: false, reason: 'bad' })
})

test('a failure reason never holds the token, and signed out says to sign in again', () => {
  const failed = parseTokenOutput(JSON.stringify({ error: 'store', accessToken: TOKEN }))
  expect(JSON.stringify(failed)).not.toContain(TOKEN)
  expect(JSON.stringify(TOKEN_FAILURE_TEXT)).not.toMatch(/eyJ/)
  expect(TOKEN_FAILURE_TEXT.signed_out).toBe(SIGNED_OUT)
  expect(SIGNED_OUT).toBe('Your sign-in ended. Sign in again.')
})

test('a cached token is used until 60 seconds before it ends', () => {
  const entry = { expiresAt: 1_000_000 }
  expect(isTokenFresh(entry, 1_000_000 - 61_000)).toBe(true)
  expect(isTokenFresh(entry, 1_000_000 - 60_000)).toBe(false)
  expect(isTokenFresh(entry, 1_000_000 - 59_000)).toBe(false)
  expect(isTokenFresh(entry, 1_000_001)).toBe(false)
  expect(isTokenFresh(undefined, 0)).toBe(false)
})

test('knows pnx logout finished', () => {
  expect(isSignedOutLine('{"event":"signed_out"}\n')).toBe(true)
  expect(isSignedOutLine('note\n{"event":"signed_out"}')).toBe(true)
  expect(isSignedOutLine('{"event":"error"}')).toBe(false)
  expect(isSignedOutLine('')).toBe(false)
})
