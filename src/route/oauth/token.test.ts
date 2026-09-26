import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { AppContext } from '@/types/env.ts'
import { generateCodeChallenge } from '@/utils/pkce.ts'
import { tokenRouter } from './token.ts'
import { AUTH_CODE_PREFIX } from './callback.ts'
import { OAUTH_CLIENT_PREFIX } from './client.ts'

// ---------------------------------------------------------------------------
// /oauth/token had no tests at all, and four separate defects lived in it:
// an omitted redirect_uri deleted its own binding, and refresh tokens were
// neither single-use, nor rotated, nor bound to the client they were issued to.
// Every one of those is asserted here against the real Hono app.
//
// It matters here more than in an ordinary MCP server: an access token minted
// on this endpoint reaches `wallet_export_seed`.
//
// The router is mounted on a bare Hono app exactly as src/index.ts mounts it.
// Importing src/index.ts here is not possible: it re-exports the Durable
// Object, which imports `cloudflare:workers`, a specifier only workerd
// resolves. Mounting the router keeps the code under test real.
// ---------------------------------------------------------------------------

const app = new Hono<AppContext>()
app.route('/oauth/token', tokenRouter)

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

const CLIENT_ID = 'client_00000000-0000-0000-0000-000000000001'
const OTHER_CLIENT_ID = 'client_00000000-0000-0000-0000-000000000002'
const REDIRECT = 'http://localhost:1410/callback'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

function env(kv: ReturnType<typeof fakeKV>) {
  return {
    MCP_KV: kv,
    NODE_ENV: 'test',
    JWT_SECRET: 'dummy-unit-jwt-secret',
    REFRESH_TOKEN_SECRET: 'dummy-unit-refresh-secret',
    OAUTH_STATE_SECRET: 'dummy-unit-state-secret',
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

async function seedCode(
  kv: ReturnType<typeof fakeKV>,
  code: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  kv.store.set(
    AUTH_CODE_PREFIX + code,
    JSON.stringify({
      subject: 'google-subject',
      email: 'owner@example.com',
      resource: 'https://mcp-stablecoin-manager.erpc.global',
      codeChallenge: await generateCodeChallenge(VERIFIER),
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      expiresAt: Date.now() + 600_000,
      ...overrides,
    }),
  )
}

async function post(
  kv: ReturnType<typeof fakeKV>,
  body: Record<string, string>,
): Promise<{ status: number; json: Record<string, string> }> {
  const response = await app.fetch(
    new Request('https://mcp-stablecoin-manager.erpc.global/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    }),
    env(kv),
  )
  return { status: response.status, json: await response.json() }
}

const exchange = (kv: ReturnType<typeof fakeKV>, over: Record<string, string> = {}) =>
  post(kv, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: 'the-code',
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    ...over,
  })

test('a valid authorization code exchanges for an access and refresh token', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  await seedCode(kv, 'the-code')

  const { status, json } = await exchange(kv)
  assert.equal(status, 200)
  assert.equal(json.token_type, 'Bearer')
  assert.ok(json.access_token)
  assert.ok(json.refresh_token)
})

test('an authorization code is single use', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  await seedCode(kv, 'the-code')

  assert.equal((await exchange(kv)).status, 200)
  const second = await exchange(kv)
  assert.equal(second.status, 400)
  assert.equal(second.json.error, 'invalid_grant')
})

test('OMITTING redirect_uri does not delete its own binding', async () => {
  // The defect: `if (redirectUri && redirectUri !== stored.redirectUri)` let a
  // caller drop the binding by simply not sending the parameter.
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  await seedCode(kv, 'the-code')

  const response = await post(kv, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: 'the-code',
    code_verifier: VERIFIER,
  })
  assert.equal(response.status, 400)
  assert.equal(response.json.error, 'invalid_grant')
  assert.match(response.json.error_description, /redirect_uri/)
})

test('a mismatched redirect_uri is refused', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  await seedCode(kv, 'the-code')
  const response = await exchange(kv, { redirect_uri: 'http://localhost:9999/callback' })
  assert.equal(response.status, 400)
  assert.equal(response.json.error, 'invalid_grant')
})

test('a code issued to another client cannot be redeemed', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  registerClient(kv, OTHER_CLIENT_ID)
  await seedCode(kv, 'the-code')
  const response = await exchange(kv, { client_id: OTHER_CLIENT_ID })
  assert.equal(response.status, 400)
  assert.equal(response.json.error, 'invalid_grant')
})

test('a wrong PKCE verifier is refused', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  await seedCode(kv, 'the-code')
  const response = await exchange(kv, { code_verifier: 'not-the-verifier' })
  assert.equal(response.status, 400)
  assert.match(response.json.error_description, /PKCE/)
})

test('an unregistered client is refused before anything else', async () => {
  const kv = fakeKV()
  await seedCode(kv, 'the-code')
  const response = await exchange(kv)
  assert.equal(response.status, 401)
  assert.equal(response.json.error, 'invalid_client')
})

// --- refresh -------------------------------------------------------------

async function firstRefreshToken(kv: ReturnType<typeof fakeKV>): Promise<string> {
  registerClient(kv, CLIENT_ID)
  await seedCode(kv, 'the-code')
  const { json } = await exchange(kv)
  return json.refresh_token
}

const refresh = (
  kv: ReturnType<typeof fakeKV>,
  token: string,
  clientId = CLIENT_ID,
) => post(kv, { grant_type: 'refresh_token', client_id: clientId, refresh_token: token })

test('a refresh token mints a new access token AND is rotated', async () => {
  const kv = fakeKV()
  const first = await firstRefreshToken(kv)

  const { status, json } = await refresh(kv, first)
  assert.equal(status, 200)
  assert.ok(json.access_token)
  assert.ok(json.refresh_token, 'a rotated refresh token must come back')
  assert.notEqual(json.refresh_token, first, 'the caller must not keep the old one')
})

test('a refresh token is SINGLE USE', async () => {
  // The defect: one leaked refresh token minted wallet-capable access tokens
  // for its whole 30-day life, with no way to revoke it.
  const kv = fakeKV()
  const first = await firstRefreshToken(kv)

  assert.equal((await refresh(kv, first)).status, 200)
  const replay = await refresh(kv, first)
  assert.equal(replay.status, 400)
  assert.equal(replay.json.error, 'invalid_grant')
})

test('the rotated refresh token works exactly once too', async () => {
  const kv = fakeKV()
  const first = await firstRefreshToken(kv)
  const second = (await refresh(kv, first)).json.refresh_token

  assert.equal((await refresh(kv, second)).status, 200)
  assert.equal((await refresh(kv, second)).status, 400)
})

test('a refresh token cannot be redeemed by a DIFFERENT client', async () => {
  // Every client registers with token_endpoint_auth_method 'none', so without
  // the binding any client could redeem another's token (RFC 6749 §6).
  const kv = fakeKV()
  const first = await firstRefreshToken(kv)
  registerClient(kv, OTHER_CLIENT_ID)

  const response = await refresh(kv, first, OTHER_CLIENT_ID)
  assert.equal(response.status, 400)
  assert.equal(response.json.error, 'invalid_grant')
  assert.match(response.json.error_description, /another client/)
})

test('a rejected redemption still consumes the token', async () => {
  // A failed attempt must not leave a reusable credential behind.
  const kv = fakeKV()
  const first = await firstRefreshToken(kv)
  registerClient(kv, OTHER_CLIENT_ID)

  assert.equal((await refresh(kv, first, OTHER_CLIENT_ID)).status, 400)
  assert.equal((await refresh(kv, first)).status, 400)
})

test('a garbage refresh token is refused', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  assert.equal((await refresh(kv, 'not-a-jwt')).status, 400)
})

test('an unsupported grant type is named, not silently ignored', async () => {
  const kv = fakeKV()
  registerClient(kv, CLIENT_ID)
  const response = await post(kv, {
    grant_type: 'password',
    client_id: CLIENT_ID,
  })
  assert.equal(response.status, 400)
  assert.equal(response.json.error, 'unsupported_grant_type')
})
