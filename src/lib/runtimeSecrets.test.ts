import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  configState,
  MCP_SECRETS,
  missingMcpSecrets,
  missingOAuthSecrets,
  missingWalletSecrets,
  OAUTH_SECRETS,
  WALLET_SECRETS,
} from './runtimeSecrets.ts'
import type { Env } from '@/types/env'

const full = {
  JWT_SECRET: 'a',
  REFRESH_TOKEN_SECRET: 'b',
  OAUTH_STATE_SECRET: 'c',
  WALLET_MNEMONIC: 'd',
  ERPC_API_KEY: 'e',
} as unknown as Env

test('a fully configured worker reports ready', () => {
  assert.deepEqual(missingOAuthSecrets(full), [])
  assert.deepEqual(missingWalletSecrets(full), [])
  assert.equal(configState(full), 'ready')
})

test('a fresh deployment names every missing secret', () => {
  const empty = {} as Env
  assert.deepEqual(missingOAuthSecrets(empty), [...OAUTH_SECRETS])
  assert.deepEqual(missingWalletSecrets(empty), [...WALLET_SECRETS])
  assert.equal(configState(empty), 'incomplete')
})

test('an EMPTY secret counts as missing, not as configured', () => {
  // The failure that matters: sign(payload, '') does not throw, it produces a
  // signature anyone can forge. An empty string must never read as "set".
  for (const blank of ['', '   ', '\n']) {
    const env = { ...full, JWT_SECRET: blank } as unknown as Env
    assert.deepEqual(missingOAuthSecrets(env), ['JWT_SECRET'], JSON.stringify(blank))
    assert.equal(configState(env), 'incomplete')
  }
})

test('a non-string value counts as missing', () => {
  for (const value of [undefined, null, 0, false, {}]) {
    const env = { ...full, OAUTH_STATE_SECRET: value } as unknown as Env
    assert.deepEqual(missingOAuthSecrets(env), ['OAUTH_STATE_SECRET'])
  }
})

test('wallet secrets do not block the OAuth surface', () => {
  const env = { ...full, WALLET_MNEMONIC: '', ERPC_API_KEY: '' } as unknown as Env
  assert.deepEqual(missingOAuthSecrets(env), [])
  assert.deepEqual(missingWalletSecrets(env), [...WALLET_SECRETS])
  assert.equal(configState(env), 'incomplete')
})

test('the MCP surface is guarded on ONLY what it uses', () => {
  // Guarding /mcp/* on all three OAuth secrets would 503 a live, correctly
  // authenticated session during the delete-then-put window of an
  // OAUTH_STATE_SECRET rotation -- refusing work it can perfectly well do.
  const rotating = { ...full, OAUTH_STATE_SECRET: '' } as unknown as Env
  assert.deepEqual(missingMcpSecrets(rotating), [], '/mcp/* keeps serving')
  assert.deepEqual(
    missingOAuthSecrets(rotating),
    ['OAUTH_STATE_SECRET'],
    '/oauth/* correctly refuses',
  )
})

test('the MCP surface still refuses a blank signing key', () => {
  // The case this guards: a whitespace-only secret is accepted by sign/verify,
  // so it must read as missing here or the surface runs on a key the operator
  // believes is unset.
  for (const blank of ['', ' ', '\n', '\t']) {
    assert.deepEqual(
      missingMcpSecrets({ ...full, JWT_SECRET: blank } as unknown as Env),
      ['JWT_SECRET'],
      JSON.stringify(blank),
    )
  }
})

test('MCP_SECRETS is a strict subset of OAUTH_SECRETS', () => {
  for (const name of MCP_SECRETS) {
    assert.ok(
      (OAUTH_SECRETS as readonly string[]).includes(name),
      `${name} must also be an OAuth secret`,
    )
  }
  assert.ok(MCP_SECRETS.length < OAUTH_SECRETS.length)
})
