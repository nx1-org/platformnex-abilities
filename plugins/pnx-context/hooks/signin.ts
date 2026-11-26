/**
 * Sign in through pnx (`pnx login/token/logout --json`): pure parts only; register.tsx and token.ts talk to the engine.
 * What pnx prints is data: lines that are not JSON are skipped, unknown events are ignored, only the fields named here
 * are read, and pnx's own message text is never shown.
 */

import type { SigninView } from '../types'
import { catalogUrlOf, isAtLeast } from './worker'

/** The first pnx with `pnx login`, `pnx token` and `pnx logout`. */
export const MIN_PNX_SIGNIN = '0.1.20'
/** An access token is renewed (asked for again) when it has less than this left. */
const TOKEN_MARGIN_MS = 60_000
/** Why a call failed when the sign-in ended (portal sign-out, 12 hour limit, revoked). */
export const SIGNED_OUT = 'Your sign-in ended. Sign in again.'

const MAX_LINE = 8_000
const MAX_FIELD = 400

/** Splits a stream of text into whole lines, whatever the chunking; a runaway line with no end is dropped. */
export function lineSplitter(): { feed: (text: string) => string[]; flush: () => string[] } {
  let rest = ''

  return {
    feed(text) {
      const parts = (rest + text).split(/\r?\n/)
      rest = parts.pop() ?? ''
      if (rest.length > MAX_LINE) rest = ''

      return parts
    },
    flush() {
      const last = rest
      rest = ''

      return last === '' ? [] : [last]
    },
  }
}

export type LoginErrorCode = 'denied' | 'expired' | 'off' | 'proof' | 'network' | 'store' | 'unknown'

/** One event of `pnx login --json`, cut down to the fields we use. Never carries any other field pnx printed. */
export type LoginEvent =
  | { event: 'code'; userCode: string; link: string; expiresIn?: number }
  | { event: 'approved'; email?: string }
  | { event: 'error'; code: LoginErrorCode }

const ERROR_CODES: readonly string[] = ['denied', 'expired', 'off', 'proof', 'network', 'store']
const USER_CODE = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/
const EMAIL = /^[^\s@<>]{1,100}@[^\s@<>]{1,200}$/

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD ? value : undefined)

/** One line pnx printed: an event, or undefined for junk, another event or a malformed one. */
export function parseLoginLine(line: string): LoginEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || trimmed.length > MAX_LINE) return undefined
  let o: unknown
  try {
    o = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined
  const f = o as Record<string, unknown>
  if (f['event'] === 'code') {
    const userCode = text(f['userCode'])
    const link = text(f['verificationUriComplete']) ?? text(f['verificationUri'])
    if (userCode === undefined || !USER_CODE.test(userCode) || link === undefined) return undefined
    const secs = f['expiresIn']

    return { event: 'code', userCode: userCode.toUpperCase(), link, expiresIn: typeof secs === 'number' && Number.isFinite(secs) && secs > 0 && secs <= 3600 ? secs : undefined }
  }
  if (f['event'] === 'approved') {
    const email = text(f['email'])

    return { event: 'approved', email: email !== undefined && EMAIL.test(email) ? email : undefined }
  }
  if (f['event'] === 'error') {
    const code = text(f['code'])

    return { event: 'error', code: code !== undefined && ERROR_CODES.includes(code) ? (code as LoginErrorCode) : 'unknown' }
  }

  return undefined
}

/** The link to show: https (or localhost while developing), on the same host as the PlatformNEX in use, with no login in it. */
export function safeLink(link: string, base: string): string | undefined {
  try {
    const url = new URL(link)
    if (url.origin !== new URL(base).origin || url.username !== '' || url.password !== '') return undefined

    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Where a sign-in is. `waiting` holds only what the person needs to see: the link and the short code they type. */
export type LoginState =
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string; link: string; expiresAt: number }
  | { phase: 'approved'; email?: string }
  | { phase: 'failed'; code: LoginErrorCode | 'link' | 'stopped' }

export const LOGIN_START: LoginState = { phase: 'starting' }

/** The next state after one event. Events out of order, repeated, or after the end change nothing. */
export function nextLoginState(state: LoginState, event: LoginEvent, ctx: { now: number; base: string }): LoginState {
  if (state.phase === 'starting' && event.event === 'code') {
    const link = safeLink(event.link, ctx.base)

    return link === undefined ? { phase: 'failed', code: 'link' } : { phase: 'waiting', userCode: event.userCode, link, expiresAt: ctx.now + (event.expiresIn ?? 600) * 1000 }
  }
  if (state.phase === 'waiting' && event.event === 'approved') return { phase: 'approved', email: event.email }
  if ((state.phase === 'starting' || state.phase === 'waiting') && event.event === 'error') return { phase: 'failed', code: event.code }

  return state
}

/** The state when pnx's process ended (`code` null: killed). Success needs both the approved event and exit 0. */
export function endLoginState(state: LoginState, code: number | null): LoginState {
  if (state.phase === 'approved') return code === 0 ? state : { phase: 'failed', code: 'stopped' }

  return state.phase === 'failed' ? state : { phase: 'failed', code: 'stopped' }
}

/** `m:ss` left until `expiresAt`, `0:00` when over. */
export function countdown(expiresAt: number, now: number): string {
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000))

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const FAILED_TEXT: Record<LoginErrorCode | 'link' | 'stopped', string> = {
  denied: 'Sign-in was denied in the portal. Sign in again, or use an API key.',
  expired: 'The code ran out before it was approved. Sign in again.',
  off: 'Sign in is not available here yet. Use an API key.',
  proof: 'pnx could not prove this sign-in is yours. Update pnx and try again, or use an API key.',
  network: "Can't reach PlatformNEX (check your internet or VPN). Try again, or use an API key.",
  store: "pnx can't keep a sign-in on this machine (its secure credential store is not available). Use an API key.",
  unknown: 'Sign-in did not finish. Try again, or use an API key.',
  link: 'pnx gave a link that is not this PlatformNEX, so it was not shown. Try again, or use an API key.',
  stopped: 'Sign-in stopped before it finished. Try again, or use an API key.',
}

/** What to tell the person when a sign-in failed. Fixed text: nothing pnx printed is shown. */
export const failedMessage = (code: LoginErrorCode | 'link' | 'stopped'): string => FAILED_TEXT[code]

/** What the pane shows for a sign-in's state: the link, the short code, the end time or a fixed message. Nothing else. */
export function loginView(state: LoginState, at: number): SigninView {
  if (state.phase === 'waiting') return { phase: 'waiting', userCode: state.userCode, link: state.link, expiresAt: state.expiresAt, at }
  if (state.phase === 'failed') return { phase: 'failed', message: failedMessage(state.code) }

  return { phase: 'starting', at, message: state.phase === 'approved' ? 'Approved. Finishing…' : undefined }
}

/** Why sign in can't start with this pnx, or undefined when it can. */
export function pnxProblem(found: { cli?: string; version?: string }): string | undefined {
  if (found.cli === undefined) return 'Sign in needs pnx, and it is not installed. The pnx-fast-dev plugin installs it (restart Claude Code in a few minutes), or use an API key.'
  if (!isAtLeast(found.version, MIN_PNX_SIGNIN)) return `Sign in needs pnx ${MIN_PNX_SIGNIN} or newer (this is ${found.version ?? 'unknown'}). pnx-fast-dev updates it at the next start, or use an API key.`

  return undefined
}

/** What the person's machine is called, for the sign-in list in the portal: short, one line. */
export function deviceName(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

  return name === '' ? 'Claude Code' : name
}

/** The commands, as argument lists (no shell). The catalog address is the portal's under /api/catalog. */
export const loginArgv = (cli: string, base: string, name: string): string[] => ['node', cli, 'login', '--json', '--no-open', '--client', 'pnx-context', '--name', name, '--catalog-url', catalogUrlOf(base)]
export const tokenArgv = (cli: string, base: string): string[] => ['node', cli, 'token', '--json', '--catalog-url', catalogUrlOf(base)]
export const logoutArgv = (cli: string, base: string): string[] => ['node', cli, 'logout', '--json', '--catalog-url', catalogUrlOf(base)]

export type TokenFailure = 'signed_out' | 'network' | 'store' | 'off' | 'bad'
export type TokenResult = { ok: true; accessToken: string; expiresAt: number } | { ok: false; reason: TokenFailure }

const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,8192}$/

/** `pnx token --json`: the token and when it ends (ms), or why not. Junk lines are skipped; the token is never put in a reason. */
export function parseTokenOutput(stdout: string): TokenResult {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let o: unknown
    try {
      o = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue
    const f = o as Record<string, unknown>
    const error = f['error']
    if (typeof error === 'string') return { ok: false, reason: error === 'signed_out' || error === 'network' || error === 'store' || error === 'off' ? error : 'bad' }
    const token = f['accessToken']
    const at = f['expiresAt']
    const expiresAt = typeof at === 'string' ? Date.parse(at) : Number.NaN
    if (typeof token === 'string' && TOKEN_SHAPE.test(token) && Number.isFinite(expiresAt)) return { ok: true, accessToken: token, expiresAt }

    return { ok: false, reason: 'bad' }
  }

  return { ok: false, reason: 'bad' }
}

/** A cached token is used until it has less than TOKEN_MARGIN_MS left. */
export const isTokenFresh = (entry: { expiresAt: number } | undefined, now: number): boolean => entry !== undefined && entry.expiresAt - now > TOKEN_MARGIN_MS

/** Why a call failed for each way `pnx token` can fail: short fixed text (SIGNED_OUT is the one that ends the connection). */
export const TOKEN_FAILURE_TEXT: Record<TokenFailure, string> = {
  signed_out: SIGNED_OUT,
  network: "can't reach PlatformNEX (check your internet or VPN)",
  store: "pnx can't read its saved sign-in",
  off: 'sign in is not available here',
  bad: 'pnx did not give a sign-in token',
}

/** `pnx logout --json` printed `{"event":"signed_out"}`. */
export function isSignedOutLine(stdout: string): boolean {
  return stdout.split(/\r?\n/).some(line => {
    try {
      return (JSON.parse(line.trim()) as { event?: unknown }).event === 'signed_out'
    } catch {
      return false
    }
  })
}
