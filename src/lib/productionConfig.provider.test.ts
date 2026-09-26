import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  APP_OIDC_ISSUER_PRODUCTION,
  assertDeployableProductionConfig,
} from './productionConfig.ts'

// ---------------------------------------------------------------------------
// The AUTH_PROVIDER branching and the app-oidc issuer pin. The checked-in
// wrangler.toml is the app-oidc template (productionConfig.test.ts renders
// and checks it), so both providers are driven here from inline configs.
// ---------------------------------------------------------------------------

const APP_OIDC_BASE = 'https://third-party-template.example.com'

/** A minimal, otherwise-valid AUTH_PROVIDER=app-oidc config. */
function appOidcConfig(overrides: Record<string, string> = {}): string {
  return workerConfig(
    {
      AUTH_PROVIDER: 'app-oidc',
      APP_OIDC_ISSUER: APP_OIDC_ISSUER_PRODUCTION,
      APP_OIDC_CLIENT_ID: 'client-issued-by-broker',
      MCP_SERVER_BASE_URL: APP_OIDC_BASE,
      OAUTH_ISSUER: APP_OIDC_BASE,
      ALLOWED_GOOGLE_EMAILS: 'owner@example.com',
      X402_HOST: 'https://x402.erpc.global',
      NODE_ENV: 'production',
      ...overrides,
    },
    'third-party-template.example.com',
  )
}

/**
 * A minimal, otherwise-valid config for the default provider (AUTH_PROVIDER
 * unset = erpc-auth-api). That branch only accepts the route host pinned in
 * productionConfig.ts.
 */
function defaultProviderConfig(overrides: Record<string, string> = {}): string {
  const base = 'https://mcp-stablecoin-manager.erpc.global'
  return workerConfig(
    {
      AUTH_API_BASE_URL: 'https://auth.example.com',
      AUTH_API_CLIENT_ID: 'mcp-stablecoin-manager',
      MCP_SERVER_BASE_URL: base,
      OAUTH_ISSUER: base,
      ALLOWED_GOOGLE_EMAILS: 'owner@example.com',
      X402_HOST: 'https://x402.erpc.global',
      NODE_ENV: 'production',
      ...overrides,
    },
    'mcp-stablecoin-manager.erpc.global',
  )
}

function workerConfig(fields: Record<string, string>, routeHost: string): string {
  const varsBlock = Object.entries(fields)
    .filter(([, v]) => v !== '__OMIT__')
    .map(([k, v]) => `${k} = "${v}"`)
    .join('\n')

  return `
name = "mcp-stablecoin-manager-template"
main = "./src/index.ts"
compatibility_date = "2026-05-12"
workers_dev = false
compatibility_flags = ["nodejs_compat"]

[vars]
${varsBlock}

[[routes]]
pattern = "${routeHost}"
custom_domain = true

[[kv_namespaces]]
binding = "MCP_KV"
id = "some-real-kv-id"

[[durable_objects.bindings]]
name = "WALLET_LEDGER"
class_name = "WalletLedger"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["WalletLedger"]
`
}

test('a well-formed AUTH_PROVIDER=app-oidc config is deployable', () => {
  assertDeployableProductionConfig(appOidcConfig())
})

test('a well-formed default-provider config is deployable', () => {
  // Positive control for the three refusals below: each differs from this
  // config by exactly the change it names.
  assertDeployableProductionConfig(defaultProviderConfig())
})

test('the default (AUTH_PROVIDER unset) provider still requires AUTH_API_BASE_URL', () => {
  assert.throws(
    () => assertDeployableProductionConfig(defaultProviderConfig({ AUTH_API_BASE_URL: '__OMIT__' })),
    /AUTH_API_BASE_URL/,
  )
})

test('the default provider refuses APP_OIDC_* vars mixed in', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        defaultProviderConfig({ APP_OIDC_ISSUER: APP_OIDC_ISSUER_PRODUCTION }),
      ),
    /APP_OIDC_\* vars must not be present/,
  )
  assert.throws(
    () => assertDeployableProductionConfig(defaultProviderConfig({ APP_OIDC_CLIENT_ID: 'some-client' })),
    /APP_OIDC_\* vars must not be present/,
  )
})

test('an unknown AUTH_PROVIDER value is refused', () => {
  assert.throws(
    () => assertDeployableProductionConfig(defaultProviderConfig({ AUTH_PROVIDER: 'bogus' })),
    /Unknown AUTH_PROVIDER/,
  )
})

test('issuer pin: only the exact production broker origin is accepted', () => {
  for (
    const badIssuer of [
      'https://app-oidc-api.example.workers.dev',
      'http://app-oidc-api.s-kishi.workers.dev',
      `${APP_OIDC_ISSUER_PRODUCTION}/`,
      `${APP_OIDC_ISSUER_PRODUCTION}/oauth`,
      ` ${APP_OIDC_ISSUER_PRODUCTION}`,
      `${APP_OIDC_ISSUER_PRODUCTION} `,
    ]
  ) {
    assert.throws(
      () => assertDeployableProductionConfig(appOidcConfig({ APP_OIDC_ISSUER: badIssuer })),
      /APP_OIDC_ISSUER must be exactly/,
      badIssuer,
    )
  }
  // Positive control: the pin itself is not a no-op.
  assertDeployableProductionConfig(appOidcConfig())
})

test('app-oidc: a missing APP_OIDC_ISSUER is refused', () => {
  assert.throws(
    () => assertDeployableProductionConfig(appOidcConfig({ APP_OIDC_ISSUER: '__OMIT__' })),
    /APP_OIDC_ISSUER must be exactly/,
  )
})

test('app-oidc: a missing or whitespace APP_OIDC_CLIENT_ID is refused', () => {
  assert.throws(
    () => assertDeployableProductionConfig(appOidcConfig({ APP_OIDC_CLIENT_ID: '__OMIT__' })),
    /APP_OIDC_CLIENT_ID must be a non-empty value/,
  )
  assert.throws(
    () => assertDeployableProductionConfig(appOidcConfig({ APP_OIDC_CLIENT_ID: '  ' })),
    /APP_OIDC_CLIENT_ID must be a non-empty value/,
  )
})

test('app-oidc: the route host must match MCP_SERVER_BASE_URL, not just any custom domain', () => {
  const config = appOidcConfig().replace(
    'pattern = "third-party-template.example.com"',
    'pattern = "somewhere-else.example.com"',
  )
  assert.throws(
    () => assertDeployableProductionConfig(config),
    /custom domain route matching MCP_SERVER_BASE_URL/,
  )
})

test('app-oidc: OAUTH_ISSUER must equal MCP_SERVER_BASE_URL', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        appOidcConfig({ OAUTH_ISSUER: 'https://not-the-base.example.com' }),
      ),
    /OAUTH_ISSUER must equal/,
  )
})

test('app-oidc still enforces the shared checks (allowlist, X402_HOST, workers_dev)', () => {
  assert.throws(
    () => assertDeployableProductionConfig(appOidcConfig({ ALLOWED_GOOGLE_EMAILS: '__OMIT__' })),
    /ALLOWED_GOOGLE_EMAILS is empty/,
  )
  assert.throws(
    () => assertDeployableProductionConfig(appOidcConfig({ X402_HOST: 'https://staging.example.com' })),
    /X402_HOST is/,
  )
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        appOidcConfig().replace('workers_dev = false', 'workers_dev = true'),
      ),
    /workers_dev = true/,
  )
})
