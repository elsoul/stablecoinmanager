import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertDeployableProductionConfig } from './productionConfig.ts'

// import.meta.dirname rather than new URL(...): @cloudflare/workers-types
// replaces the global URL with the Workers one, which node:fs and node:url
// both refuse.
const PROD = join(import.meta.dirname, '../../wrangler.toml')
const DEV = join(import.meta.dirname, '../../wrangler.dev.toml')

const prod = () => readFileSync(PROD, 'utf8')

test('the checked-in dev config is REFUSED (the checker is not a no-op)', () => {
  // The positive control: if this ever passes, every assertion below is empty.
  assert.throws(() => assertDeployableProductionConfig(readFileSync(DEV, 'utf8')))
})

test('the checked-in production config is deployable as it stands', () => {
  assertDeployableProductionConfig(prod())
})

test('a config whose KV namespace was never created is refused', () => {
  // The namespace is created once by an operator (`wrangler kv namespace
  // create`). Until that has happened the deploy must refuse rather than ship
  // a worker with no store, so the placeholder the file was authored with is
  // still a rejection.
  for (const placeholder of ['REPLACE_WITH_KV_NAMESPACE_ID', 'PLACEHOLDER_KV_ID', '']) {
    assert.throws(
      () =>
        assertDeployableProductionConfig(
          prod().replace(/(binding = "MCP_KV"\nid = ")[^"]*/, `$1${placeholder}`),
        ),
      /MCP_KV namespace is not provisioned/,
      `placeholder ${JSON.stringify(placeholder)} must be refused`,
    )
  }
})

const provisioned = prod

test('dropping the Durable Object binding or its migration tag is refused', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        provisioned().replace('class_name = "WalletLedger"', 'class_name = "Other"'),
      ),
    /Durable Object binding is missing/,
  )
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        provisioned().replace('tag = "v1"', 'tag = "v2"'),
      ),
    /migration tag v1 is missing/,
  )
})

test('losing the custom domain is refused', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        provisioned().replace(
          'pattern = "mcp-stablecoin-manager.erpc.global"',
          'pattern = "somewhere-else.example.com"',
        ),
      ),
    /custom domain/,
  )
})

test('an empty login allowlist is refused', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        provisioned().replace(
          'ALLOWED_GOOGLE_EMAILS = "owner@example.com"',
          'ALLOWED_GOOGLE_EMAILS = ""',
        ),
      ),
    /ALLOWED_GOOGLE_EMAILS is empty/,
  )
})

test('workers_dev or a development NODE_ENV is refused', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        provisioned().replace('workers_dev = false', 'workers_dev = true'),
      ),
    /workers_dev = true/,
  )
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        provisioned().replace('NODE_ENV = "production"', 'NODE_ENV = "development"'),
      ),
    /development NODE_ENV/,
  )
})

test('a seed phrase or api key reaching the config is refused', () => {
  for (const line of [
    'WALLET_MNEMONIC = "abandon abandon"',
    'ERPC_API_KEY = "erpc_x"',
  ]) {
    assert.throws(
      () => assertDeployableProductionConfig(`${provisioned()}\n${line}\n`),
      /must never appear in wrangler config/,
    )
  }
})

test('a development secret leaking into production is refused', () => {
  assert.throws(
    () =>
      assertDeployableProductionConfig(
        `${provisioned()}\nJWT_SECRET = "dummy-jwt-secret-local-only"\n`,
      ),
    /development secret/,
  )
})
