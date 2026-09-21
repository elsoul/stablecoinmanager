/**
 * Fail loudly when a runtime secret is missing.
 *
 * All five of this worker's secrets are operator-set with
 * `wrangler secret put` rather than synced from CI (see slv.toml for why --
 * the repository is at GitHub's 100-secret cap). The cost of that is that a
 * fresh environment starts with none of them, and the failure mode we must not
 * have is a worker that boots, accepts a login, and signs tokens with
 * `undefined`.
 *
 * So: OAuth refuses with 503 while a secret is missing, and /health names
 * which ones, because "it deployed" and "it works" are different claims.
 */
import type { Env } from '@/types/env'

/** Secrets without which the OAuth surface must not run at all. */
export const OAUTH_SECRETS = [
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
  'OAUTH_STATE_SECRET',
] as const

/**
 * What `/mcp/*` actually needs: it verifies a bearer token and nothing else.
 *
 * Deliberately narrower than OAUTH_SECRETS. Guarding the MCP surface on all
 * three would 503 a live, correctly-authenticated session during the
 * delete-then-put window of an OAUTH_STATE_SECRET rotation -- refusing work it
 * is perfectly able to do.
 */
export const MCP_SECRETS = ['JWT_SECRET'] as const

/** Secrets the wallet tools need; OAuth still works without them. */
export const WALLET_SECRETS = ['WALLET_MNEMONIC', 'ERPC_API_KEY'] as const

export function missingOAuthSecrets(env: Env): string[] {
  return OAUTH_SECRETS.filter((name) => !isPresent(env[name]))
}

export function missingMcpSecrets(env: Env): string[] {
  return MCP_SECRETS.filter((name) => !isPresent(env[name]))
}

export function missingWalletSecrets(env: Env): string[] {
  return WALLET_SECRETS.filter((name) => !isPresent(env[name]))
}

export function configState(env: Env): 'ready' | 'incomplete' {
  return missingOAuthSecrets(env).length === 0 &&
      missingWalletSecrets(env).length === 0
    ? 'ready'
    : 'incomplete'
}

/**
 * A secret is present only if it is a non-empty string. Wrangler will happily
 * store an empty value, and `sign(payload, '')` does not throw -- it produces a
 * signature anyone can forge.
 */
function isPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
