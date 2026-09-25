import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { AppContext } from '@/types/env.ts'
import { authorizeRouter } from './authorize.ts'
import { callbackRouter, AUTH_CODE_PREFIX } from './callback.ts'
import { OAUTH_CLIENT_PREFIX } from './client.ts'

// Pointer: PR #14211 steiner r1 N-5; packet
// docs/superpowers/plans/2026-09-25-packet-pr2-stablecoin-manager-app-oidc.md
// §Coordinates.

const app = new Hono<AppContext>()
app.route('/oauth/authorize', authorizeRouter)
app.route('/oauth/callback', callbackRouter)

const STATE_SECRET = 'dummy-unit-state-secret'
const CLIENT_ID = 'client_00000000-0000-0000-0000-00000000000b'
const REDIRECT = 'http://localhost:1410/callback'
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const CLIENT_STATE = 'client-opaque-state-outcome'

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

function authCodeKeysInStore(kv: ReturnType<typeof fakeKV>): string[] {
  return [...kv.store.keys()].filter((k) => k.startsWith(AUTH_CODE_PREFIX))
}

function fakeAuthApiAccessToken(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  return `header.${payload}.signature`
}

test('erpc-auth-api login: the final redirect goes to the client with code and its own opaque state, and auth_code: stores the identity', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)

  const authorizeResponse = await app.fetch(
    new Request(
      `https://mcp-stablecoin-manager.erpc.global/oauth/authorize?${
        new URLSearchParams({
          response_type: 'code',
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
          code_challenge: CODE_CHALLENGE,
          code_challenge_method: 'S256',
          state: CLIENT_STATE,
        }).toString()
      }`,
    ),
    env(kv),
  )
  const authorizeLocation = new URL(authorizeResponse.headers.get('location') ?? '')
  const state = authorizeLocation.searchParams.get('state') ?? ''

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: fakeAuthApiAccessToken({
          sub: 'google-subject-outcome',
          provider: 'google',
          email: 'owner@example.com',
          isEmailVerified: true,
        }),
        token_type: 'Bearer',
        expires_in: 3600,
        provider: 'google',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

  let callbackResponse: Response
  try {
    callbackResponse = await app.fetch(
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

  assert.equal(callbackResponse.status, 302)
  const finalLocation = new URL(callbackResponse.headers.get('location') ?? '')
  assert.equal(`${finalLocation.origin}${finalLocation.pathname}`, REDIRECT)
  assert.equal(finalLocation.searchParams.get('state'), CLIENT_STATE)
  const issuedCode = finalLocation.searchParams.get('code')
  assert.ok(issuedCode, 'the redirect must carry the code the client exchanges next')
  assert.deepEqual([...finalLocation.searchParams.keys()], ['code', 'state'])

  const codes = authCodeKeysInStore(kv)
  assert.equal(codes.length, 1)
  assert.equal(codes[0], AUTH_CODE_PREFIX + issuedCode)
  const stored = JSON.parse(kv.store.get(codes[0]) ?? '{}')
  assert.equal(stored.subject, 'google-subject-outcome')
  assert.equal(stored.email, 'owner@example.com')
  assert.equal(stored.clientId, CLIENT_ID)
  assert.equal(stored.redirectUri, REDIRECT)
  assert.equal(stored.codeChallenge, CODE_CHALLENGE)
})
