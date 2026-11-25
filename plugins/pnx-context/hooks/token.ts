// The sign-in's token source: asks `pnx token --json` for the short-lived access token, the only secret the plugin sees
// in sign-in mode. Memory only; never in state, a file, a log or an error.
import type { EngineInterface } from 'claude-code'

import { ApiFailure, type TokenSource } from './api'
import { TOKEN_FAILURE_TEXT, isTokenFresh, parseTokenOutput, tokenArgv } from './signin'

const TOKEN_TIMEOUT_MS = 30_000

/** One token source for one PlatformNEX and one pnx: calls made together share one `pnx token` run. */
export function makeSigninTokens(base: string, cli: string, onSignedOut: () => void): TokenSource {
  let cached: { value: string; expiresAt: number } | undefined
  let inflight: Promise<string> | undefined

  const ask = async ($: EngineInterface): Promise<string> => {
    const ran = await $.process.run(tokenArgv(cli, base), { timeoutMs: TOKEN_TIMEOUT_MS }).catch(() => undefined)
    if (ran === undefined) throw new ApiFailure('pnx could not run')
    // pnx prints JSON even when it fails (exit 2 when signed out), so the answer is read whatever the exit code.
    const answer = parseTokenOutput(ran.stdout)
    if (!answer.ok && answer.reason === 'signed_out') {
      cached = undefined
      onSignedOut()
    }
    if (!answer.ok) throw new ApiFailure(TOKEN_FAILURE_TEXT[answer.reason], answer.reason === 'signed_out' ? 401 : undefined)
    cached = { value: answer.accessToken, expiresAt: answer.expiresAt }

    return answer.accessToken
  }

  return {
    async get($) {
      if (isTokenFresh(cached, await $.clock.now()) && cached !== undefined) return cached.value
      inflight ??= ask($).finally(() => {
        inflight = undefined
      })

      return inflight
    },
    forget() {
      cached = undefined
    },
  }
}
