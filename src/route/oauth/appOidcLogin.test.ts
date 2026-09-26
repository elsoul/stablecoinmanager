import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { AppContext } from '@/types/env.ts'
import { decodeState } from '@/utils/state.ts'
import { generateCodeChallenge } from '@/utils/pkce.ts'
import { oidcTxnKey } from '@/utils/appOidc.ts'
import { authorizeRouter } from './authorize.ts'
import { callbackRouter, AUTH_CODE_PREFIX } from './callback.ts'
import { OAUTH_CLIENT_PREFIX } from './client.ts'

// ---------------------------------------------------------------------------
// The app-oidc login path, route-level: bare Hono mount, fakeKV, globalThis.fetch stub
// restored after each test. Each test gets its own APP_OIDC_ISSUER so the
// production JWKS singleton cache (see appOidcJwks.ts) never leaks state
// between tests.
// ---------------------------------------------------------------------------

const app = new Hono<AppContext>()
app.route('/oauth/authorize', authorizeRouter)
app.route('/oauth/callback', callbackRouter)

const CLIENT_ID = 'client_00000000-0000-0000-0000-0000000000d0'
const REDIRECT = 'http://localhost:1410/callback'
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const OWNER_EMAIL = 'owner@example.com'
const STATE_SECRET = 'dummy-unit-state-secret'

let issuerCounter = 0
function uniqueIssuer(): string {
  issuerCounter += 1
  return `https://app-oidc-route-test-${issuerCounter}.example.com`
}

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

function baseEnv(
  kv: ReturnType<typeof fakeKV>,
  overrides: Record<string, string> = {},
): AppContext['Bindings'] {
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
    ALLOWED_GOOGLE_EMAILS: OWNER_EMAIL,
    AUTH_PROVIDER: 'app-oidc',
    APP_OIDC_CLIENT_ID: 'app-oidc-client-under-test',
    ...overrides,
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

function oidcTxnKeysInStore(kv: ReturnType<typeof fakeKV>): string[] {
  return [...kv.store.keys()].filter((k) => k.startsWith('oidc_txn:'))
}

function authCodeKeysInStore(kv: ReturnType<typeof fakeKV>): string[] {
  return [...kv.store.keys()].filter((k) => k.startsWith(AUTH_CODE_PREFIX))
}

async function requestAuthorize(
  kv: ReturnType<typeof fakeKV>,
  envObj: AppContext['Bindings'],
  overrides: Record<string, string> = {},
): Promise<Response> {
  registerClient(kv, CLIENT_ID)
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-opaque-state',
    ...overrides,
  })
  return app.fetch(
    new Request(
      `https://mcp-stablecoin-manager.erpc.global/oauth/authorize?${query.toString()}`,
    ),
    envObj,
  )
}

function requestCallback(
  envObj: AppContext['Bindings'],
  params: Record<string, string>,
) {
  const query = new URLSearchParams(params)
  return app.fetch(
    new Request(
      `https://mcp-stablecoin-manager.erpc.global/oauth/callback?${query.toString()}`,
    ),
    envObj,
  )
}

interface Broker {
  issuer: string
  clientId: string
  restore: () => void
  calls: { token: number; jwks: number }
}

/** Stubs fetch for one issuer's /oauth/token and /.well-known/jwks.json. */
function stubBroker(opts: {
  issuer: string
  clientId: string
  idToken: () => string | Promise<string>
  tokenStatus?: number
  jwks: unknown
}): Broker {
  const calls = { token: 0, jwks: 0 }
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${opts.issuer}/oauth/token`) {
      calls.token++
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'server_error' }), {
          status: opts.tokenStatus,
        })
      }
      return new Response(
        JSON.stringify({ id_token: await opts.idToken(), expires_in: 300 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === `${opts.issuer}/.well-known/jwks.json`) {
      calls.jwks++
      return new Response(JSON.stringify(opts.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch in appOidcLogin.test.ts: ${url}`)
  }) as typeof fetch
  return {
    issuer: opts.issuer,
    clientId: opts.clientId,
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

async function mintIdToken(params: {
  privateKey: CryptoKey
  kid: string
  issuer: string
  clientId: string
  nonce: string
  claimOverrides?: Record<string, unknown>
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'google-subject-route-test',
    email: OWNER_EMAIL,
    email_verified: true,
    nonce: params.nonce,
    ...params.claimOverrides,
  })
    .setProtectedHeader({ alg: 'ES256', kid: params.kid, typ: 'JWT' })
    .setIssuer(params.issuer)
    .setAudience(params.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(params.privateKey)
}

async function makeEs256Key(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  return { privateKey, publicJwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } }
}

function jwtLikeStrings(text: string): boolean {
  return /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)
}

/**
 * Captures console.log lines for the duration of `run`, so a test can pin the
 * `reason` safeLog records -- the 403 body is reason-agnostic by design (see
 * callback.ts), so the reason is only observable through the log.
 */
async function captureLogs<T>(run: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  try {
    const result = await run()
    return { result, lines }
  } finally {
    console.log = original
  }
}

test('authorize: Location, nonce, client_id, scope, and no provider param', async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const response = await requestAuthorize(kv, baseEnv(kv, { APP_OIDC_ISSUER: issuer }))

  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location') ?? '')
  assert.equal(`${location.origin}${location.pathname}`, `${issuer}/oauth/authorize`)
  assert.equal(location.searchParams.get('client_id'), 'app-oidc-client-under-test')
  assert.equal(location.searchParams.get('scope'), 'openid email')
  assert.equal(location.searchParams.has('provider'), false)

  const state = location.searchParams.get('state') ?? ''
  const decoded = await decodeState(state, STATE_SECRET)
  assert.equal(location.searchParams.get('nonce'), decoded.nonce)
})

test('authorize: the upstream verifier is not in state, but is in MCP_KV under oidc_txn:', async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const response = await requestAuthorize(kv, baseEnv(kv, { APP_OIDC_ISSUER: issuer }))
  const location = new URL(response.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''

  const decoded = await decodeState(state, STATE_SECRET)
  assert.equal('upstreamVerifier' in decoded, false)
  assert.ok(!location.toString().includes((await stateVerifier(kv, state)) ?? '\u0000'))

  const keys = oidcTxnKeysInStore(kv)
  assert.equal(keys.length, 1)
  assert.equal(keys[0], await oidcTxnKey(state))

  const storedVerifier = kv.store.get(keys[0]) ?? ''
  const codeChallenge = location.searchParams.get('code_challenge') ?? ''
  assert.equal(await generateCodeChallenge(storedVerifier), codeChallenge)
})

async function stateVerifier(
  kv: ReturnType<typeof fakeKV>,
  state: string,
): Promise<string | undefined> {
  return kv.store.get(await oidcTxnKey(state))
}

test('authorize: an oversized state is refused before anything is written to KV', async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const response = await requestAuthorize(kv, baseEnv(kv, { APP_OIDC_ISSUER: issuer }), {
    state: 'x'.repeat(3000),
  })
  assert.equal(response.status, 400)
  assert.equal(response.headers.has('location'), false)
  assert.equal(oidcTxnKeysInStore(kv).length, 0)

  // Control: an ordinary-length client state still gets a 302.
  const ok = await requestAuthorize(kv, baseEnv(kv, { APP_OIDC_ISSUER: issuer }))
  assert.equal(ok.status, 302)
})

async function fullLogin(
  kv: ReturnType<typeof fakeKV>,
  issuer: string,
  claimOverrides: Record<string, unknown> = {},
): Promise<{ envObj: AppContext['Bindings']; broker: Broker; callbackResponse: Response }> {
  const key = await makeEs256Key('k1')
  const envObj = baseEnv(kv, { APP_OIDC_ISSUER: issuer })
  const authorizeResponse = await requestAuthorize(kv, envObj)
  const location = new URL(authorizeResponse.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''
  const decoded = await decodeState(state, STATE_SECRET)

  const broker = stubBroker({
    issuer,
    clientId: 'app-oidc-client-under-test',
    idToken: () =>
      mintIdToken({
        privateKey: key.privateKey,
        kid: 'k1',
        issuer,
        clientId: 'app-oidc-client-under-test',
        nonce: decoded.nonce,
        claimOverrides,
      }),
    jwks: { keys: [key.publicJwk] },
  })

  let callbackResponse: Response
  try {
    callbackResponse = await requestCallback(envObj, { code: 'upstream-code', state, iss: issuer })
  } finally {
    broker.restore()
  }

  return { envObj, broker, callbackResponse }
}

test('callback happy path: 302, an auth_code with subject+email, and the txn consumed', async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const { callbackResponse } = await fullLogin(kv, issuer)

  assert.equal(callbackResponse.status, 302)
  const codes = authCodeKeysInStore(kv)
  assert.equal(codes.length, 1)
  const stored = JSON.parse(kv.store.get(codes[0]) ?? '{}')
  assert.equal(stored.email, OWNER_EMAIL)
  assert.ok(stored.subject)

  assert.equal(oidcTxnKeysInStore(kv).length, 0)
})

test('callback: a verified token outside the allowlist is refused before an auth_code is minted', async () => {
  // Distinct from the verification-rejection cases below: this token passes
  // every cryptographic check (aud, iss, nonce, signature, exp) and only
  // fails evaluateLogin's allowlist. Firing control for the code-issuance
  // ordering: the allowlist must still run before AUTH_CODE_PREFIX is
  // written.
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const { callbackResponse } = await fullLogin(kv, issuer, {
    email: 'not-the-owner@example.com',
  })

  assert.equal(callbackResponse.status, 403)
  assert.equal(authCodeKeysInStore(kv).length, 0)
})

test('iss param mismatch: missing or wrong issuer is refused without consuming the txn', async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const key = await makeEs256Key('k1')
  const envObj = baseEnv(kv, { APP_OIDC_ISSUER: issuer })
  const authorizeResponse = await requestAuthorize(kv, envObj)
  const location = new URL(authorizeResponse.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''
  const decoded = await decodeState(state, STATE_SECRET)

  const broker = stubBroker({
    issuer,
    clientId: 'app-oidc-client-under-test',
    idToken: () =>
      mintIdToken({
        privateKey: key.privateKey,
        kid: 'k1',
        issuer,
        clientId: 'app-oidc-client-under-test',
        nonce: decoded.nonce,
      }),
    jwks: { keys: [key.publicJwk] },
  })

  try {
    const { result: missingIss, lines: missingIssLines } = await captureLogs(() =>
      requestCallback(envObj, { code: 'c', state })
    )
    assert.equal(missingIss.status, 403)
    assert.deepEqual(await missingIss.json(), {
      error: 'access_denied',
      error_description: 'Identity provider could not be established',
    })
    assert.equal(oidcTxnKeysInStore(kv).length, 1, 'the txn is not consumed on iss mismatch')
    assert.ok(
      missingIssLines.some((line) => line.includes('app_oidc_iss_param_mismatch')),
      `expected app_oidc_iss_param_mismatch in the log, got: ${JSON.stringify(missingIssLines)}`,
    )

    const { result: wrongIss, lines: wrongIssLines } = await captureLogs(() =>
      requestCallback(envObj, {
        code: 'c',
        state,
        iss: 'https://not-the-broker.example.com',
      })
    )
    assert.equal(wrongIss.status, 403)
    assert.equal(oidcTxnKeysInStore(kv).length, 1)
    assert.ok(
      wrongIssLines.some((line) => line.includes('app_oidc_iss_param_mismatch')),
      `expected app_oidc_iss_param_mismatch in the log, got: ${JSON.stringify(wrongIssLines)}`,
    )

    const correct = await requestCallback(envObj, { code: 'upstream-code', state, iss: issuer })
    assert.equal(correct.status, 302)
    assert.equal(oidcTxnKeysInStore(kv).length, 0)
  } finally {
    broker.restore()
  }
})

test('reuse: the same code+state a second time is refused as txn_missing, without a second token-endpoint call', async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()
  const key = await makeEs256Key('k1')
  const envObj = baseEnv(kv, { APP_OIDC_ISSUER: issuer })
  const authorizeResponse = await requestAuthorize(kv, envObj)
  const location = new URL(authorizeResponse.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''
  const decoded = await decodeState(state, STATE_SECRET)

  const broker = stubBroker({
    issuer,
    clientId: 'app-oidc-client-under-test',
    idToken: () =>
      mintIdToken({
        privateKey: key.privateKey,
        kid: 'k1',
        issuer,
        clientId: 'app-oidc-client-under-test',
        nonce: decoded.nonce,
      }),
    jwks: { keys: [key.publicJwk] },
  })

  try {
    const first = await requestCallback(envObj, { code: 'upstream-code', state, iss: issuer })
    assert.equal(first.status, 302)
    assert.equal(authCodeKeysInStore(kv).length, 1)
    assert.equal(broker.calls.token, 1)

    const { result: second, lines } = await captureLogs(() =>
      requestCallback(envObj, { code: 'upstream-code', state, iss: issuer })
    )
    assert.equal(second.status, 403)
    assert.equal(authCodeKeysInStore(kv).length, 1, 'no second auth_code was minted')
    assert.equal(broker.calls.token, 1, 'the token endpoint was not called a second time')
    assert.ok(
      lines.some((line) => line.includes('app_oidc_txn_missing')),
      `expected a log line naming app_oidc_txn_missing, got: ${JSON.stringify(lines)}`,
    )
  } finally {
    broker.restore()
  }
})

test("AUTH_PROVIDER='erpc-auth-api' explicit matches the unset default; 'bogus' is a 500", async () => {
  const kv = fakeKV()
  const issuer = uniqueIssuer()

  const explicit = await requestAuthorize(kv, baseEnv(kv, {
    APP_OIDC_ISSUER: issuer,
    AUTH_PROVIDER: 'erpc-auth-api',
  }))
  assert.equal(explicit.status, 302)
  const location = explicit.headers.get('location') ?? ''
  assert.ok(location.startsWith('https://auth-api.erpc.global/oauth/authorize?'), location)
  assert.deepEqual(
    [...new URL(location).searchParams.keys()],
    [
      'response_type',
      'provider',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'state',
    ],
    'the explicit erpc-auth-api path must match the unset default byte-for-byte in query key order too',
  )

  const bogus = await requestAuthorize(kv, baseEnv(kv, {
    APP_OIDC_ISSUER: issuer,
    AUTH_PROVIDER: 'bogus',
  }))
  assert.equal(bogus.status, 500)
  assert.equal(bogus.headers.has('location'), false)
})

test('callback rejections (aud, nonce, exp, unknown kid, signature, token endpoint 500) are uniformly refused', async () => {
  const kv = fakeKV()

  async function attempt(
    label: string,
    expectedReason: string,
    build: (
      issuer: string,
      key: Awaited<ReturnType<typeof makeEs256Key>>,
      nonce: string,
    ) => Promise<{ idToken?: () => string | Promise<string>; jwks?: unknown; tokenStatus?: number }>,
  ) {
    const issuer = uniqueIssuer()
    const key = await makeEs256Key('k1')
    const envObj = baseEnv(kv, { APP_OIDC_ISSUER: issuer })
    const authorizeResponse = await requestAuthorize(kv, envObj)
    const location = new URL(authorizeResponse.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const decoded = await decodeState(state, STATE_SECRET)

    const plan = await build(issuer, key, decoded.nonce)
    const broker = stubBroker({
      issuer,
      clientId: 'app-oidc-client-under-test',
      idToken: plan.idToken ??
        (() =>
          mintIdToken({
            privateKey: key.privateKey,
            kid: 'k1',
            issuer,
            clientId: 'app-oidc-client-under-test',
            nonce: decoded.nonce,
          })),
      jwks: plan.jwks ?? { keys: [key.publicJwk] },
      tokenStatus: plan.tokenStatus,
    })

    let response: Response
    let text: string
    let lines: string[]
    try {
      const captured = await captureLogs(() =>
        requestCallback(envObj, { code: 'upstream-code', state, iss: issuer })
      )
      response = captured.result
      lines = captured.lines
      text = await response.text()
    } finally {
      broker.restore()
    }

    assert.equal(response.status, 403, label)
    assert.deepEqual(JSON.parse(text), {
      error: 'access_denied',
      error_description: 'Identity provider could not be established',
    }, label)
    assert.equal(authCodeKeysInStore(kv).length, 0, `${label}: no auth_code`)
    assert.equal(oidcTxnKeysInStore(kv).length, 0, `${label}: the txn is still consumed`)
    assert.equal(jwtLikeStrings(text), false, `${label}: no JWT-shaped string leaks into the response`)
    assert.ok(
      lines.some((line) => line.includes(`app_oidc_${expectedReason}`)),
      `${label}: expected a log line naming app_oidc_${expectedReason}, got: ${JSON.stringify(lines)}`,
    )
  }

  await attempt('aud mismatch', 'aud_mismatch', async (issuer, key, nonce) => ({
    idToken: () =>
      mintIdToken({
        privateKey: key.privateKey,
        kid: 'k1',
        issuer,
        clientId: 'someone-else',
        nonce,
      }),
  }))

  await attempt('nonce mismatch', 'nonce_mismatch', async (issuer, key) => ({
    idToken: () =>
      mintIdToken({
        privateKey: key.privateKey,
        kid: 'k1',
        issuer,
        clientId: 'app-oidc-client-under-test',
        nonce: 'the-wrong-nonce',
      }),
  }))

  await attempt('expired', 'expired', async (issuer, key, nonce) => ({
    idToken: async () => {
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({
        sub: 's',
        email: OWNER_EMAIL,
        email_verified: true,
        nonce,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('app-oidc-client-under-test')
        .setIssuedAt(now - 600)
        .setExpirationTime(now - 60)
        .sign(key.privateKey)
    },
  }))

  await attempt('unknown kid', 'key_not_found', async () => ({
    jwks: { keys: [] },
  }))

  await attempt('signature invalid (same kid, different key)', 'signature_invalid', async (issuer, key, nonce) => {
    const impostor = await makeEs256Key('k1')
    return {
      idToken: () =>
        mintIdToken({
          privateKey: impostor.privateKey,
          kid: 'k1',
          issuer,
          clientId: 'app-oidc-client-under-test',
          nonce,
        }),
    }
  })

  await attempt('token endpoint 500', 'token_endpoint_error', async () => ({ tokenStatus: 500 }))
})
