import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { exchangeAppOidcCode, verifyAppOidcIdToken } from './appOidc.ts'
import type { AppOidcJwk, AppOidcJwks } from './appOidcJwks.ts'

// ---------------------------------------------------------------------------
// Pointer: docs/superpowers/plans/2026-09-25-stablecoin-manager-app-oidc-branch-madeen.md
// §2-A, §4-B. Local JWKS + injected clock -- no network, no shared cache.
// ---------------------------------------------------------------------------

const ISSUER = 'https://app-oidc-test.example.com'
const CLIENT_ID = 'app_test0000000000000000000001'
const NONCE = 'test-nonce-abcdefghijklmnop'
const NOW_SECONDS = 1_800_000_000
const NOW_MS = NOW_SECONDS * 1000

interface TestKey {
  privateKey: CryptoKey
  jwk: AppOidcJwk
}

async function makeKey(
  alg: 'ES256' | 'EdDSA' | 'RS256',
  kid: string,
  opts: Parameters<typeof generateKeyPair>[1] = {},
): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    ...opts,
    extractable: true,
  })
  const jwk = await exportJWK(publicKey)
  return { privateKey, jwk: { ...jwk, kid, alg, use: 'sig' } as AppOidcJwk }
}

function jwks(...keys: TestKey[]): AppOidcJwks {
  return { keys: keys.map((k) => k.jwk) }
}

function fixedGetJwks(
  ...responses: AppOidcJwks[]
): (opts?: { force?: boolean }) => Promise<AppOidcJwks> {
  let call = 0
  return async () => {
    const response = responses[Math.min(call, responses.length - 1)]
    if (call < responses.length - 1) call++
    return response
  }
}

async function mint(
  key: TestKey,
  alg: string,
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: key.jwk.kid, typ: 'JWT', ...headerOverrides })
    .sign(key.privateKey)
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'google-subject-1',
    email: 'owner@example.com',
    email_verified: true,
    nonce: NONCE,
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
    ...overrides,
  }
}

function verify(
  idToken: string,
  getJwksImpl: (opts?: { force?: boolean }) => Promise<AppOidcJwks>,
  overrides: { expectedNonce?: string; now?: number } = {},
) {
  return verifyAppOidcIdToken(idToken, {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    expectedNonce: overrides.expectedNonce ?? NONCE,
    now: () => overrides.now ?? NOW_MS,
    getJwks: getJwksImpl,
  })
}

const mainKey = await makeKey('ES256', 'k-main')
const otherEs256Key = await makeKey('ES256', 'k-main') // same kid, different key material
const edKey = await makeKey('EdDSA', 'k-confused', { crv: 'Ed25519' })
const rsaKey = await makeKey('RS256', 'k-confused-rsa')

test('a well-formed token verifies and shapes the claims evaluateLogin expects', async () => {
  const token = await mint(mainKey, 'ES256', baseClaims())
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.deepEqual(result.claims, {
    sub: 'google-subject-1',
    provider: 'google',
    email: 'owner@example.com',
    isEmailVerified: true,
    iss: ISSUER,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
  })
})

test('aud mismatch is refused', async () => {
  const token = await mint(mainKey, 'ES256', baseClaims({ aud: 'someone-else' }))
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'aud_mismatch' })
})

test('an aud array naming the client is still refused (single-value only)', async () => {
  const token = await mint(mainKey, 'ES256', baseClaims({ aud: [CLIENT_ID, 'other'] }))
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'aud_mismatch' })
})

test('a mismatched azp is refused even though aud is correct', async () => {
  const token = await mint(mainKey, 'ES256', baseClaims({ azp: 'someone-else' }))
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'aud_mismatch' })
})

test('a present-but-wrong nonce is nonce_mismatch', async () => {
  const mismatched = await mint(mainKey, 'ES256', baseClaims({ nonce: 'wrong-nonce-value' }))
  assert.deepEqual(await verify(mismatched, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'nonce_mismatch',
  })
})

test('a nonce claim that is entirely absent is claim_missing (caught by requiredClaims first)', async () => {
  // Not an empty string: jose's requiredClaims check runs before our own
  // nonce comparison, so a truly absent claim never reaches nonce_mismatch.
  const claims = baseClaims()
  delete claims.nonce
  const missing = await mint(mainKey, 'ES256', claims)
  assert.deepEqual(await verify(missing, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'claim_missing',
  })
})

test('exp: 31s past is refused, 29s past is accepted (30s clockTolerance)', async () => {
  const expired = await mint(
    mainKey,
    'ES256',
    baseClaims({ iat: NOW_SECONDS - 300, exp: NOW_SECONDS - 31 }),
  )
  assert.deepEqual(await verify(expired, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'expired',
  })

  const stillOk = await mint(
    mainKey,
    'ES256',
    baseClaims({ iat: NOW_SECONDS - 300, exp: NOW_SECONDS - 29 }),
  )
  assert.equal((await verify(stillOk, fixedGetJwks(jwks(mainKey)))).ok, true)
})

test('a missing exp claim is refused', async () => {
  const claims = baseClaims()
  delete claims.exp
  const token = await mint(mainKey, 'ES256', claims)
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'claim_missing' })
})

test('iat: 331s of age is too_old, 329s is accepted (maxTokenAge 300 + 30s tolerance)', async () => {
  const tooOld = await mint(
    mainKey,
    'ES256',
    baseClaims({ iat: NOW_SECONDS - 331, exp: NOW_SECONDS + 600 }),
  )
  assert.deepEqual(await verify(tooOld, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'too_old',
  })

  const stillOk = await mint(
    mainKey,
    'ES256',
    baseClaims({ iat: NOW_SECONDS - 329, exp: NOW_SECONDS + 600 }),
  )
  assert.equal((await verify(stillOk, fixedGetJwks(jwks(mainKey)))).ok, true)
})

test('iat: 31s in the future is not_yet_valid, 29s is accepted', async () => {
  const future = await mint(mainKey, 'ES256', baseClaims({ iat: NOW_SECONDS + 31 }))
  assert.deepEqual(await verify(future, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'not_yet_valid',
  })

  const stillOk = await mint(mainKey, 'ES256', baseClaims({ iat: NOW_SECONDS + 29 }))
  assert.equal((await verify(stillOk, fixedGetJwks(jwks(mainKey)))).ok, true)
})

test('an unknown kid forces exactly one refetch, then reports key_not_found (not signature_invalid)', async () => {
  const strangerKey = await makeKey('ES256', 'k-unknown')
  const token = await mint(strangerKey, 'ES256', baseClaims())

  const calls: Array<{ force?: boolean }> = []
  const getJwksImpl = async (opts?: { force?: boolean }) => {
    calls.push({ force: opts?.force })
    return jwks(mainKey)
  }

  const result = await verify(token, getJwksImpl)
  assert.deepEqual(result, { ok: false, reason: 'key_not_found' })
  assert.deepEqual(calls, [{ force: undefined }, { force: true }])
})

test('the same kid signed by a different key is a signature failure', async () => {
  const token = await mint(otherEs256Key, 'ES256', baseClaims())
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'signature_invalid' })
})

test('iss mismatch, including a trailing slash, is refused', async () => {
  const wrongHost = await mint(mainKey, 'ES256', baseClaims({ iss: 'https://not-the-issuer.example.com' }))
  assert.deepEqual(await verify(wrongHost, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'iss_mismatch',
  })

  const trailingSlash = await mint(mainKey, 'ES256', baseClaims({ iss: `${ISSUER}/` }))
  assert.deepEqual(await verify(trailingSlash, fixedGetJwks(jwks(mainKey))), {
    ok: false,
    reason: 'iss_mismatch',
  })
})

test('algorithm confusion (EdDSA, RS256) is refused even when the JWKS carries a matching kid', async () => {
  // The fixture deliberately includes the confusable keys under a matching kid:
  // removing the alg pin (header pre-check + jose `algorithms`) would let jose
  // find and use them, and since these tokens are genuinely signed by the
  // matching private key, verification would then SUCCEED -- which is exactly
  // the firing control for the "alg pin" row of the mutation table.
  const confusedJwks = jwks(mainKey, edKey, rsaKey)

  const edToken = await mint(edKey, 'EdDSA', baseClaims())
  assert.deepEqual(await verify(edToken, fixedGetJwks(confusedJwks)), {
    ok: false,
    reason: 'alg_not_allowed',
  })

  const rsaToken = await mint(rsaKey, 'RS256', baseClaims())
  assert.deepEqual(await verify(rsaToken, fixedGetJwks(confusedJwks)), {
    ok: false,
    reason: 'alg_not_allowed',
  })
})

test('alg: none is refused', async () => {
  // Hand-built: SignJWT refuses to sign with 'none', so this constructs the
  // compact serialization directly.
  const header = base64url({ alg: 'none', kid: mainKey.jwk.kid, typ: 'JWT' })
  const payload = base64url(baseClaims())
  const token = `${header}.${payload}.`
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'alg_not_allowed' })
})

test('a missing kid is refused', async () => {
  const header = base64url({ alg: 'ES256', typ: 'JWT' })
  const payload = base64url(baseClaims())
  const token = `${header}.${payload}.deadbeef`
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'kid_missing' })
})

test('a missing email_verified claim is refused as claim_missing', async () => {
  const claims = baseClaims()
  delete claims.email_verified
  const token = await mint(mainKey, 'ES256', claims)
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.deepEqual(result, { ok: false, reason: 'claim_missing' })
})

test('email_verified as the STRING "true" verifies, but shapes to isEmailVerified: false', async () => {
  // jose's requiredClaims only checks presence, not type. The strict `=== true`
  // comparison in the claim shaping is what evaluateLogin then reads as
  // email_unverified -- this test pins the shaping half of that chain.
  const token = await mint(mainKey, 'ES256', baseClaims({ email_verified: 'true' }))
  const result = await verify(token, fixedGetJwks(jwks(mainKey)))
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.equal(result.claims.isEmailVerified, false)
})

function base64url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// --- exchangeAppOidcCode: the token-endpoint half -------------------------

function stubFetch(
  handler: (input: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function exchangeParams(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: 'https://mcp-stablecoin-manager.erpc.global/oauth/callback',
    code: 'the-upstream-code',
    codeVerifier: 'the-code-verifier',
    expectedNonce: NONCE,
    now: () => NOW_MS,
    getJwks: fixedGetJwks(jwks(mainKey)),
    ...overrides,
  }
}

for (const status of [400, 500]) {
  test(`token endpoint status ${status} is a token_endpoint_error`, async () => {
    const stub = stubFetch(() => new Response(JSON.stringify({ error: 'x' }), { status }))
    try {
      const result = await exchangeAppOidcCode(exchangeParams())
      assert.deepEqual(result, { ok: false, reason: 'token_endpoint_error' })
    } finally {
      stub.restore()
    }
  })
}

test('a 302 from the token endpoint is a token_endpoint_error too', async () => {
  const stub = stubFetch(() =>
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } })
  )
  try {
    const result = await exchangeAppOidcCode(exchangeParams())
    assert.deepEqual(result, { ok: false, reason: 'token_endpoint_error' })
  } finally {
    stub.restore()
  }
})

test('a token response with no id_token is token_response_malformed', async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ expires_in: 300 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  )
  try {
    const result = await exchangeAppOidcCode(exchangeParams())
    assert.deepEqual(result, { ok: false, reason: 'token_response_malformed' })
  } finally {
    stub.restore()
  }
})

test('the outbound token request: exact form fields, no client_secret, redirect manual', async () => {
  const idToken = await mint(mainKey, 'ES256', baseClaims())
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ id_token: idToken, expires_in: 300 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  )
  let result
  try {
    result = await exchangeAppOidcCode(exchangeParams())
  } finally {
    stub.restore()
  }

  assert.equal(result.ok, true)
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].url, `${ISSUER}/oauth/token`)
  assert.equal(stub.calls[0].init.method, 'POST')
  assert.equal(stub.calls[0].init.redirect, 'manual')

  const body = new URLSearchParams(String(stub.calls[0].init.body))
  assert.deepEqual(
    [...body.keys()].sort(),
    ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri'].sort(),
  )
  assert.equal(body.has('client_secret'), false)
})
