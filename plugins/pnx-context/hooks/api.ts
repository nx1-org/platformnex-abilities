// The only place that talks to PlatformNEX. It sends the key to one host (the configured base)
// and never puts a URL, the key, a token or a response body into an error.
import type { EngineInterface } from 'claude-code'

import { cap, unwrap } from './lib'

export type Cfg = { base: string; key: string }

/** A failure that is safe to show: a short reason, nothing from the request or the response. */
export class ApiFailure extends Error {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(reason)
  }
}

const AGENT = 'pnx-context-mod/0.1.0'
const TIMEOUT_MS = 12_000
const MAX_BODY = 2_000_000

// The token and the connection (address and key) it was issued for: another connection never gets it. Memory only.
let token: { value: string; expiresAt: number; base: string; key: string } | undefined

/** Why a call failed when PlatformNEX refused the key (wrong, expired or revoked). */
export const KEY_REFUSED = 'the API key was not accepted'

const reasonFor = (status: number): string =>
  status === 401 ? KEY_REFUSED : status === 403 ? 'no permission' : status === 404 ? 'not found' : status === 429 ? 'too many requests, try again soon' : `PlatformNEX error (${status})`

type Reply = { status: number; ok: boolean; text: string }

async function send($: EngineInterface, cfg: Cfg, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const request = $.http.fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'User-Agent': AGENT,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => {
    throw new ApiFailure('no answer in time')
  })
  // If the request wins the race, the timer's rejection must not surface later as an unhandled one.
  timeout.catch(() => undefined)
  let reply: Awaited<typeof request>
  try {
    reply = await Promise.race([request, timeout])
  } catch (error) {
    throw error instanceof ApiFailure ? error : new ApiFailure("can't reach PlatformNEX (check your internet or VPN)")
  }
  if (reply.text.length > MAX_BODY) throw new ApiFailure('answer too large')

  return { status: reply.status, ok: reply.ok, text: reply.text }
}

/** Trades the personal key for a 15-minute token, kept in memory only. */
async function bearer($: EngineInterface, cfg: Cfg): Promise<string> {
  if (token !== undefined && token.base === cfg.base && token.key === cfg.key && token.expiresAt - Date.now() > 60_000) return token.value
  const reply = await send($, cfg, 'POST', '/api/catalog/auth/api-key-token', { Authorization: `ApiKey ${cfg.key}` })
  if (!reply.ok) throw new ApiFailure(reasonFor(reply.status), reply.status)
  const data = unwrap(reply.text) as { accessToken?: unknown; expiresIn?: unknown } | undefined
  if (typeof data?.accessToken !== 'string' || data.accessToken === '') throw new ApiFailure('unexpected answer from PlatformNEX')
  const seconds = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : 900
  token = { value: data.accessToken, expiresAt: Date.now() + seconds * 1000, base: cfg.base, key: cfg.key }

  return token.value
}

/** Signs in with the key (or reuses this connection's token): throws ApiFailure(KEY_REFUSED) when the key is refused. */
export async function signIn($: EngineInterface, cfg: Cfg): Promise<void> {
  await bearer($, cfg)
}

export const forgetToken = (): void => {
  token = undefined
}

/** One authenticated call; a 401 gets one fresh token and one retry. Returns the parsed envelope data. */
export async function call($: EngineInterface, cfg: Cfg, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await send($, cfg, method, path, { Authorization: `Bearer ${await bearer($, cfg)}` }, body)
    if (reply.status === 401 && attempt === 0) {
      forgetToken()
      continue
    }
    if (!reply.ok) {
      const message = ((): string | undefined => {
        try {
          const parsed = JSON.parse(reply.text) as { error?: { message?: unknown } }

          return typeof parsed.error?.message === 'string' ? cap(parsed.error.message, 120) : undefined
        } catch {
          return undefined
        }
      })()
      throw new ApiFailure(message ?? reasonFor(reply.status), reply.status)
    }

    return { status: reply.status, data: unwrap(reply.text) }
  }

  throw new ApiFailure(KEY_REFUSED, 401)
}

/** An MCP Streamable HTTP reply is JSON, or one server-sent event whose `data:` line is the JSON. */
const mcpBody = (text: string): unknown => {
  const trimmed = text.trim()
  const line = trimmed.startsWith('{') ? trimmed : trimmed.split('\n').reverse().find(l => l.startsWith('data:'))?.slice(5).trim()
  try {
    return line === undefined ? undefined : JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * One read-only tool call through the gateway's MCP proxy, as the person (their key, traded for a short token).
 * Returns the tool's answer text. The proxy only offers read-only tools; this never calls anything else.
 */
export async function mcpCall($: EngineInterface, cfg: Cfg, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await send($, cfg, 'POST', '/api/catalog/mcp-proxy', { Authorization: `Bearer ${await bearer($, cfg)}`, Accept: 'application/json, text/event-stream' }, body)
    if (reply.status === 401 && attempt === 0) {
      forgetToken()
      continue
    }
    if (!reply.ok) throw new ApiFailure(reasonFor(reply.status), reply.status)
    const parsed = mcpBody(reply.text) as { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: unknown } } | undefined
    if (parsed === undefined) throw new ApiFailure('unexpected answer from PlatformNEX')
    if (parsed.error !== undefined) throw new ApiFailure(typeof parsed.error.message === 'string' ? cap(parsed.error.message, 120) : 'the tool was refused')
    const text = (parsed.result?.content ?? []).map(c => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('')

    return { text, isError: parsed.result?.isError === true }
  }
  throw new ApiFailure(KEY_REFUSED, 401)
}

export function byRepo($: EngineInterface, cfg: Cfg, repoUrl: string) {
  return call($, cfg, 'GET', `/api/catalog/catalog/entities/by-repo?repoUrl=${encodeURIComponent(repoUrl)}`)
}

export function systemHealth($: EngineInterface, cfg: Cfg, namespaceAndName: string) {
  return call($, cfg, 'GET', `/api/catalog/systems/${namespaceAndName.split('/').map(encodeURIComponent).join('/')}/health?historyDays=14`)
}

/** Cached read-only snapshots, many in one request. Never the refresh route: that one re-runs billed jobs. */
export function snapshots($: EngineInterface, cfg: Cfg, keys: { domain: string; resourceType: string; resourceKey: string }[]) {
  return call($, cfg, 'POST', '/api/aggregator/dashboard/batch', { keys })
}

/** The latest release sessions of a component, open and finished, newest first. */
export function recentReleases($: EngineInterface, cfg: Cfg, entityRef: string) {
  return call($, cfg, 'GET', `/api/catalog/releases?entityRef=${encodeURIComponent(entityRef)}&limit=30`)
}

/** One release session with its phases. */
export function releaseDetail($: EngineInterface, cfg: Cfg, id: string) {
  return call($, cfg, 'GET', `/api/catalog/releases/${encodeURIComponent(id)}`)
}

/** Opens a DRAFT release session. This is the only write the mod makes; it never calls deploy. */
export function createDraftRelease($: EngineInterface, cfg: Cfg, body: { entityRef: string; environmentId: number; targetKind: 'branch'; targetRef: string }) {
  return call($, cfg, 'POST', '/api/catalog/releases', body)
}

/** One line of `/pnx-context check`: ok is undefined for a step skipped. */
export type CheckStep = { label: string; ok: boolean | undefined; detail: string; fix?: string }

/** Signs in with the key and asks the lookup route one harmless question. Reasons only; nothing from the key or the answer. */
export async function checkAccess($: EngineInterface, cfg: Cfg): Promise<CheckStep[]> {
  forgetToken()
  const steps: CheckStep[] = []
  try {
    await bearer($, cfg)
    steps.push({ label: 'key accepted', ok: true, detail: 'signed in' })
  } catch (error) {
    steps.push({ label: 'key accepted', ok: false, detail: error instanceof ApiFailure ? error.reason : 'could not check', fix: 'create a new key in the portal and paste it in the pane' })
    steps.push({ label: 'lookup route', ok: undefined, detail: 'skipped until the key works' })

    return steps
  }
  try {
    await byRepo($, cfg, 'https://github.com/owner/name')
    steps.push({ label: 'lookup route', ok: true, detail: 'answers' })
  } catch (error) {
    const missing = error instanceof ApiFailure && error.status === 404
    steps.push({
      label: 'lookup route',
      ok: false,
      detail: missing ? "this PlatformNEX can't look up repos yet" : error instanceof ApiFailure ? error.reason : 'could not check',
      fix: missing ? 'ask the PlatformNEX team, or switch environment (⚙)' : undefined,
    })
  }

  return steps
}
