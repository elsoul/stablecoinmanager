import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { AppContext } from '@/types/env.ts'
import { decodeState } from '@/utils/state.ts'
import { authorizeRouter } from './authorize.ts'
import { callbackRouter } from './callback.ts'
import { OAUTH_CLIENT_PREFIX } from './client.ts'

// ---------------------------------------------------------------------------
// Pointer: docs/superpowers/plans/2026-09-25-packet-pr2-stablecoin-manager-app-oidc.md
// §Coordinates (commit 1) and §Acceptance checks 1, 3, 4.
//
// This file is committed alone, before any app-oidc source change, and pins
// the external shape of the AUTH_PROVIDER-unset login path as it exists today.
// It must not change in the commit that adds the app-oidc branch.
// ---------------------------------------------------------------------------

const app = new Hono<AppContext>()
app.route('/oauth/authorize', authorizeRouter)
app.route('/oauth/callback', callbackRouter)

const STATE_SECRET = 'dummy-unit-state-secret'
const CLIENT_ID = 'client_00000000-0000-0000-0000-00000000000a'
const REDIRECT = 'http://localhost:1410/callback'
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

function fakeKV() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

function env(kv: ReturnType<typeof fakeKV>): AppContext['Bindings'] {
  return {
    MCP_KV: kv,
    NODE_ENV: 'test',
    JWT_SECRET: 'dummy-unit-jwt-secret',
    REFRESH_TOKEN_SECRET: 'dummy-unit-refresh-secret',
    OAUTH_STATE_SECRET: STATE_SECRET,
    JWT_EXPIRES_IN: '3600',
    MCP_SERVER_BASE_URL: 'https://mcp-stablecoin-manager.erpc.global',
    OAUTH_ISSUER: 'https://mcp-stablecoin-manager.erpc.global',
    AUTH_API_BASE_URL: 'https://auth-api.erpc.global',
    AUTH_API_CLIENT_ID: 'mcp-stablecoin-manager',
    ALLOWED_GOOGLE_EMAILS: 'owner@example.com',
  } as unknown as AppContext['Bindings']
}

function registerClient(kv: ReturnType<typeof fakeKV>, clientId: string): void {
  kv.store.set(
    OAUTH_CLIENT_PREFIX + clientId,
    JSON.stringify({
      client_id: clientId,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  )
}

function oidcTxnKeys(kv: ReturnType<typeof fakeKV>): string[] {
  return [...kv.store.keys()].filter((key) => key.startsWith('oidc_txn:'))
}

async function requestAuthorize(kv: ReturnType<typeof fakeKV>) {
  registerClient(kv, CLIENT_ID)
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-opaque-state',
  })
  return app.fetch(
    new Request(
      `https://mcp-stablecoin-manager.erpc.global/oauth/authorize?${query.toString()}`,
    ),
    env(kv),
  )
}

// header.payload.signature with a literal, non-base64 header/signature -- the
// same shape allowlist.test.ts uses so this never looks like a real token to
// the repository credential scanner.
function fakeAuthApiAccessToken(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  return `header.${payload}.signature`
}

test('AUTH_PROVIDER unset: authorize redirects to auth-api with the current query shape', async () => {
  const kv = fakeKV()
  const response = await requestAuthorize(kv)

  assert.equal(response.status, 302)
  const location = response.headers.get('location') ?? ''
  assert.ok(
    location.startsWith('https://auth-api.erpc.global/oauth/authorize?'),
    location,
  )

  const query = new URL(location).searchParams
  assert.deepEqual(
    [...query.keys()],
    [
      'response_type',
      'provider',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'state',
    ],
  )
  assert.equal(query.get('provider'), 'google')
  assert.equal(query.get('client_id'), 'mcp-stablecoin-manager')
  assert.equal(query.has('nonce'), false)

  const decoded = await decodeState(query.get('state') ?? '', STATE_SECRET)
  assert.ok(decoded.upstreamVerifier, 'the default path still carries the verifier in state')

  assert.equal(oidcTxnKeys(kv).length, 0)
})

test('AUTH_PROVIDER unset: callback exchanges the code with auth-api exactly once', async () => {
  const kv = fakeKV()
  const authorizeResponse = await requestAuthorize(kv)
  const state = new URL(authorizeResponse.headers.get('location') ?? '').searchParams.get(
    'state',
  ) ?? ''

  const calls: Array<{ url: string; init: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(
      JSON.stringify({
        access_token: fakeAuthApiAccessToken({
          sub: 'google-subject',
          provider: 'google',
          email: 'owner@example.com',
          isEmailVerified: true,
        }),
        token_type: 'Bearer',
        expires_in: 3600,
        provider: 'google',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  let response: Response
  try {
    response = await app.fetch(
      new Request(
        `https://mcp-stablecoin-manager.erpc.global/oauth/callback?${
          new URLSearchParams({ code: 'upstream-code', state }).toString()
        }`,
      ),
      env(kv),
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(response.status, 302)
  assert.equal(calls.length, 1, 'exactly one outbound fetch (no JWKS access on this path)')
  assert.equal(calls[0].url, 'https://auth-api.erpc.global/oauth/token')
  assert.equal(calls[0].init.method, 'POST')

  const body = new URLSearchParams(String(calls[0].init.body))
  assert.deepEqual(
    [...body.keys()].sort(),
    ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri'].sort(),
  )

  assert.equal(oidcTxnKeys(kv).length, 0)
})
