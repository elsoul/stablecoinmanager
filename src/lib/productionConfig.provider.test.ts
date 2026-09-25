import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  APP_OIDC_ISSUER_PRODUCTION,
  assertDeployableProductionConfig,
} from './productionConfig.ts'

// ---------------------------------------------------------------------------
// Pointer: docs/superpowers/plans/2026-09-25-packet-pr2-stablecoin-manager-app-oidc.md
// §Acceptance check 9. `productionConfig.test.ts` (unmodified) already pins
// the erpc-auth-api-shaped checked-in wrangler.toml; this file pins the
// AUTH_PROVIDER branching and the app-oidc issuer pin.
// ---------------------------------------------------------------------------

const PROD = join(import.meta.dirname, '../../wrangler.toml')
const prod = () => readFileSync(PROD, 'utf8')

const APP_OIDC_BASE = 'https://third-party-template.example.com'

/** A minimal, otherwise-valid AUTH_PROVIDER=app-oidc config. */
function appOidcConfig(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    AUTH_PROVIDER: 'app-oidc',
    APP_OIDC_ISSUER: APP_OIDC_ISSUER_PRODUCTION,
    APP_OIDC_CLIENT_ID: 'client-issued-by-broker',
    MCP_SERVER_BASE_URL: APP_OIDC_BASE,
    OAUTH_ISSUER: APP_OIDC_BASE,
    ALLOWED_GOOGLE_EMAILS: 'owner@example.com',
    X402_HOST: 'https://x402.erpc.global',
    NODE_ENV: 'production',
    ...overrides,
  }
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
pattern = "third-party-template.example.com"
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

test('the default (AUTH_PROVIDER unset) provider still requires AUTH_API_BASE_URL', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        prod().replace(/AUTH_API_BASE_URL\s*=\s*"[^"]*"\n?/, ''),
      ),
    /AUTH_API_BASE_URL/,
  )
})

test('the default provider refuses APP_OIDC_* vars mixed in', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        `${prod()}\nAPP_OIDC_ISSUER = "${APP_OIDC_ISSUER_PRODUCTION}"\n`,
      ),
    /APP_OIDC_\* vars must not be present/,
  )
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        `${prod()}\nAPP_OIDC_CLIENT_ID = "some-client"\n`,
      ),
    /APP_OIDC_\* vars must not be present/,
  )
})

test('an unknown AUTH_PROVIDER value is refused', () => {
  assert.throws(
    () => assertDeployableProductionConfig(`${prod()}\nAUTH_PROVIDER = "bogus"\n`),
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
