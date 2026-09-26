/**
 * Deploy-time refusals. `deploy:prod` and `test:deploy` both run these before
 * anything is shipped, so a misconfigured wrangler.toml fails the pipeline
 * instead of producing a worker that holds a wallet but is reachable on the
 * wrong origin or with a dev fallback in place.
 */
import { AUTH_PROVIDERS, type AuthProvider } from '../utils/authProvider.ts'

const PLACEHOLDER_KV_IDS = [
  'REPLACE_WITH_KV_NAMESPACE_ID',
  'PLACEHOLDER_KV_ID',
  'PLACEHOLDER_KV_PREVIEW_ID',
]

const PRODUCTION_HOST = 'mcp-stablecoin-manager.erpc.global'

/**
 * The app-oidc-api broker every AUTH_PROVIDER=app-oidc deploy points at,
 * including deploys made from this template. Compared byte-for-byte;
 * `resolveAppOidcConfig` at request time only checks the var's shape, not
 * this value (see appOidc.ts).
 */
export const APP_OIDC_ISSUER_PRODUCTION = 'https://app-oidc-api.s-kishi.workers.dev'

function resolveConfiguredProvider(config: string): AuthProvider {
  const raw = config.match(/^\s*AUTH_PROVIDER\s*=\s*"([^"]*)"/m)?.[1]
  if (raw === undefined || raw === '') return 'erpc-auth-api'
  if ((AUTH_PROVIDERS as readonly string[]).includes(raw)) return raw as AuthProvider
  throw new Error(`Unknown AUTH_PROVIDER in production config: ${JSON.stringify(raw)}`)
}

/**
 * `{{...}}` placeholders that `erpc app init` should already have rendered.
 * The `{{erpc:...}}` sentinels (the KV namespace id, the Cloudflare account
 * id) are left out on purpose: `erpc deploy` fills those itself and refuses a
 * real deploy while one is still present, and `erpc deploy --dry-run` runs
 * this check as its preflight before it has filled them.
 */
export const unrenderedPlaceholders = (config: string): string[] =>
  [...config.matchAll(/\{\{([^{}]*)\}\}/g)]
    .map((match) => match[1].trim())
    .filter((name) => !name.startsWith('erpc:'))

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const assertDeployableProductionConfig = (raw: string): void => {
  // Judge the CONFIG, not the prose about it. A wrangler.toml comment may well
  // explain which values are `wrangler secret` only, and a checker that reads
  // that documentation as a violation refuses every correct deploy.
  const config = stripComments(raw)

  // The checked-in wrangler.toml is a template: `erpc app init` renders its
  // `{{...}}` placeholders. Checking the unrendered file (for example
  // `pnpm deploy:prod` straight from a clone) must refuse by name, before a
  // later check fails on one of the placeholders for a reason that does not
  // say what is actually wrong.
  const unrendered = unrenderedPlaceholders(config)
  if (unrendered.length > 0) {
    throw new Error(
      `wrangler.toml still contains unrendered placeholders (${
        unrendered.map((name) => `{{${name}}}`).join(', ')
      }); run \`erpc app init --template\` first`,
    )
  }

  const provider = resolveConfiguredProvider(config)

  const kvId = config
    .match(
      /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"MCP_KV"[\s\S]*?id\s*=\s*"([^"]*)"/,
    )?.[1]
    ?.trim() ?? ''
  if (!kvId || PLACEHOLDER_KV_IDS.includes(kvId)) {
    throw new Error(
      'MCP_KV namespace is not provisioned; refusing production deployment',
    )
  }

  if (
    !/\[\[durable_objects\.bindings\]\][\s\S]*?class_name\s*=\s*"WalletLedger"/
      .test(config)
  ) {
    throw new Error('WalletLedger Durable Object binding is missing')
  }

  // Migration tags are cumulative. Dropping v1 orphans every ledger row, which
  // is how a double-payment guard silently stops guarding.
  if (!/\[\[migrations\]\][\s\S]*?tag\s*=\s*"v1"/.test(config)) {
    throw new Error('WalletLedger migration tag v1 is missing')
  }

  if (provider === 'erpc-auth-api') {
    if (
      !new RegExp(
        `\\[\\[routes\\]\\][\\s\\S]*?pattern\\s*=\\s*"${PRODUCTION_HOST}"[\\s\\S]*?custom_domain\\s*=\\s*true`,
      ).test(config)
    ) {
      throw new Error(
        `custom domain route ${PRODUCTION_HOST} is missing; refusing production deployment`,
      )
    }
  } else {
    const baseUrl = config.match(/MCP_SERVER_BASE_URL\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? ''
    let baseHost = ''
    try {
      baseHost = new URL(baseUrl).host
    } catch {
      // baseHost stays '' -> the check below refuses.
    }
    if (
      !baseHost ||
      !new RegExp(
        `\\[\\[routes\\]\\][\\s\\S]*?pattern\\s*=\\s*"${escapeRegExp(baseHost)}"[\\s\\S]*?custom_domain\\s*=\\s*true`,
      ).test(config)
    ) {
      throw new Error(
        'custom domain route matching MCP_SERVER_BASE_URL is missing; refusing production deployment',
      )
    }
  }

  const allowed = config
    .match(/ALLOWED_GOOGLE_EMAILS\s*=\s*"([^"]*)"/)?.[1]
    ?.trim() ?? ''
  if (!allowed) {
    throw new Error(
      'ALLOWED_GOOGLE_EMAILS is empty; refusing to deploy a wallet with no login allowlist',
    )
  }

  // The x402 host decides where real money is sent. A staging host in
  // production would sign a payment to somewhere that is not ERPC.
  const x402Host = config.match(/X402_HOST\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? ''
  if (x402Host !== 'https://x402.erpc.global') {
    throw new Error(
      `X402_HOST is ${JSON.stringify(x402Host)}; production must pay https://x402.erpc.global`,
    )
  }

  if (/NODE_ENV\s*=\s*"development"/.test(config)) {
    throw new Error('development NODE_ENV is present in the production config')
  }

  if (/workers_dev\s*=\s*true/.test(config)) {
    throw new Error(
      'workers_dev = true exposes a *.workers.dev origin the redirect_uri pin does not cover',
    )
  }

  // A seed phrase or API key that reaches a config file has to be treated as
  // disclosed. Both are `wrangler secret` only.
  if (/WALLET_MNEMONIC|ERPC_API_KEY/.test(config)) {
    throw new Error(
      'WALLET_MNEMONIC / ERPC_API_KEY must never appear in wrangler config; use `wrangler secret put`',
    )
  }

  // Exactly the values wrangler.dev.toml carries. They are spelled "dummy-…"
  // so the repository credential scanner recognises them as placeholders; the
  // point of this check is that they must never reach production anyway.
  for (
    const devSecret of [
      'dummy-jwt-secret-local-only',
      'dummy-refresh-secret-local-only',
      'dummy-state-secret-local-only',
    ]
  ) {
    if (config.includes(devSecret)) {
      throw new Error(`development secret ${devSecret} is present in the production config`)
    }
  }

  if (provider === 'erpc-auth-api') {
    const authApiBase = config.match(/AUTH_API_BASE_URL\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? ''
    if (!authApiBase || !/^https:\/\//.test(authApiBase)) {
      throw new Error(
        'AUTH_API_BASE_URL must be a non-empty https URL for AUTH_PROVIDER=erpc-auth-api',
      )
    }

    const authApiClientId = config.match(/AUTH_API_CLIENT_ID\s*=\s*"([^"]*)"/)?.[1]?.trim() ??
      ''
    if (!authApiClientId) {
      throw new Error('AUTH_API_CLIENT_ID must be set for AUTH_PROVIDER=erpc-auth-api')
    }

    if (/APP_OIDC_ISSUER\s*=|APP_OIDC_CLIENT_ID\s*=/.test(config)) {
      throw new Error(
        'APP_OIDC_* vars must not be present when AUTH_PROVIDER=erpc-auth-api',
      )
    }
  } else {
    // No .trim() here: the pin is a byte-for-byte comparison, so
    // a space-padded value must be refused, not silently normalized.
    const issuer = config.match(/APP_OIDC_ISSUER\s*=\s*"([^"]*)"/)?.[1] ?? ''
    if (issuer !== APP_OIDC_ISSUER_PRODUCTION) {
      throw new Error(
        `APP_OIDC_ISSUER must be exactly ${
          JSON.stringify(APP_OIDC_ISSUER_PRODUCTION)
        }; refusing production deployment`,
      )
    }

    const clientId = config.match(/APP_OIDC_CLIENT_ID\s*=\s*"([^"]*)"/)?.[1] ?? ''
    if (!clientId.trim() || /\s/.test(clientId)) {
      throw new Error('APP_OIDC_CLIENT_ID must be a non-empty value with no whitespace')
    }

    const baseUrl = config.match(/MCP_SERVER_BASE_URL\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? ''
    let baseOrigin = ''
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol === 'https:' && parsed.origin === baseUrl) baseOrigin = baseUrl
    } catch {
      // baseOrigin stays '' -> the check below refuses.
    }
    if (!baseOrigin) {
      throw new Error('MCP_SERVER_BASE_URL must be a canonical https origin')
    }

    const oauthIssuer = config.match(/OAUTH_ISSUER\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? ''
    if (oauthIssuer !== baseOrigin) {
      throw new Error('OAUTH_ISSUER must equal MCP_SERVER_BASE_URL')
    }
  }
}

/** Drop whole-line TOML comments. Values never start a line with `#`. */
function stripComments(config: string): string {
  return config
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}
