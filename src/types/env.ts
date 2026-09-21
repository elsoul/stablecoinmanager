import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types'

export type Env = {
  /** OAuth clients, authorization codes and refresh tokens. */
  MCP_KV: KVNamespace
  /** Single-writer money ledger. See src/do/walletLedger.ts. */
  WALLET_LEDGER: DurableObjectNamespace

  NODE_ENV: string

  // This worker's own Authorization Server (for MCP clients).
  JWT_SECRET: string
  REFRESH_TOKEN_SECRET: string
  JWT_EXPIRES_IN: string
  MCP_SERVER_BASE_URL: string
  OAUTH_ISSUER: string
  OAUTH_STATE_SECRET: string

  // auth-api, used purely as the Google IdP (establishes WHICH human is here).
  AUTH_API_BASE_URL: string
  AUTH_API_CLIENT_ID: string
  /** Comma-separated. A login outside this list is refused with 403. */
  ALLOWED_GOOGLE_EMAILS: string

  // Wallet + chain access. Both are `wrangler secret` only and are absent in
  // local dev, where the worker reports `not_initialized` instead of guessing.
  WALLET_MNEMONIC?: string
  ERPC_API_KEY?: string

  // Policy ceilings (see src/lib/policy.ts).
  POLICY_MAX_EURC_PER_PAYMENT: string
  POLICY_MAX_EURC_PER_DAY: string
  POLICY_ALLOWED_NETWORKS: string
  POLICY_ALLOWED_ASSETS: string
  POLICY_ALLOW_ANY_PAYTO: string
  POLICY_MAX_SLIPPAGE_BPS: string
  POLICY_MAX_DEADLINE_SECONDS: string
}

export type CustomContext = {
  /** Google account subject from auth-api. */
  subject: string
  email: string
}

export type AppContext = {
  Variables: CustomContext
  Bindings: Env
}
