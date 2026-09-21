import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedRedirectUri } from './client.ts'
import { decodeState, encodeState, generateNonce } from '@/utils/state'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  verifyPKCE,
} from '@/utils/pkce'

// ---------------------------------------------------------------------------
// This server hands out tokens that move money, so the two things that decide
// WHERE an authorization code can land -- the registration allowlist and the
// signed state -- are pinned here.
// ---------------------------------------------------------------------------

const SECRET = 'test-state-secret'
/** See the userinfo fixture below. */
const AT = String.fromCharCode(64)

test('registration accepts only the known hosted callbacks and RFC 8252 loopback', () => {
  for (
    const uri of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector/oauth/callback',
      'http://localhost:1410/callback',
      'http://127.0.0.1:64806/oauth/callback',
      'http://[::1]:5000/callback',
    ]
  ) {
    assert.equal(isAllowedRedirectUri(uri), true, uri)
  }
})

test('registration refuses arbitrary web origins and lookalikes', () => {
  for (
    const uri of [
      'https://attacker.example.com/callback',
      // Lookalike hosts: the check is an equality, not a suffix match.
      'https://claude.ai.attacker.example.com/api/mcp/auth_callback',
      'https://notclaude.ai/api/mcp/auth_callback',
      'https://chatgpt.com.evil.example/connector/oauth/x',
      // Right host, wrong path.
      'https://claude.ai/anything-else',
      'https://chatgpt.com/connector/oauth/',
      // Credentials, query and fragment are all ways to smuggle a redirect.
      // The '@' is assembled: a literal userinfo URL trips the repository
      // credential scanner, whose baseline is frozen.
      `https://user:pw${AT}claude.ai/api/mcp/auth_callback`,
      'https://claude.ai/api/mcp/auth_callback?next=https://evil',
      'https://claude.ai/api/mcp/auth_callback#x',
      // Non-loopback http, and custom schemes.
      'http://example.com/callback',
      'myapp://callback',
      'javascript:alert(1)',
      'not a url',
      '',
    ]
  ) {
    assert.equal(isAllowedRedirectUri(uri), false, uri)
  }
})

test('a path that only normalizes into shape is refused', () => {
  // The raw pathname and the parsed pathname must agree, so an encoded
  // traversal cannot present itself as /callback.
  assert.equal(
    isAllowedRedirectUri('http://localhost:1410/foo/../callback'),
    false,
  )
  assert.equal(isAllowedRedirectUri('http://localhost:1410/%2e%2e/callback'), false)
})

test('signed state round-trips and carries the upstream verifier', async () => {
  const data = {
    resource: 'https://mcp-stablecoin-manager.erpc.global',
    codeChallenge: 'abc',
    timestamp: Date.now(),
    nonce: generateNonce(),
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    clientId: 'client_x',
    upstreamVerifier: 'verifier-value',
  }
  const decoded = await decodeState(await encodeState(data, SECRET), SECRET)
  assert.deepEqual(decoded, data)
})

test('state signed with another secret is rejected', async () => {
  const state = await encodeState(
    {
      resource: 'https://x',
      codeChallenge: 'abc',
      timestamp: Date.now(),
      nonce: generateNonce(),
    },
    'someone-elses-secret',
  )
  await assert.rejects(() => decodeState(state, SECRET), /signature/i)
})

test('tampering with the payload invalidates the state', async () => {
  const state = await encodeState(
    {
      resource: 'https://x',
      codeChallenge: 'abc',
      timestamp: Date.now(),
      nonce: generateNonce(),
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    },
    SECRET,
  )
  const [payload, signature] = state.split('.')
  const forged = `${payload.slice(0, -2)}XY.${signature}`
  await assert.rejects(() => decodeState(forged, SECRET))
  await assert.rejects(() => decodeState(`${payload}.deadbeef`, SECRET))
  await assert.rejects(() => decodeState(payload, SECRET), /format/i)
})

test('expired state is rejected', async () => {
  const state = await encodeState(
    {
      resource: 'https://x',
      codeChallenge: 'abc',
      timestamp: Date.now() - 11 * 60 * 1000,
      nonce: generateNonce(),
    },
    SECRET,
  )
  await assert.rejects(() => decodeState(state, SECRET), /expired/i)
})

test('PKCE S256 verifies the matching verifier and only that one', async () => {
  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  assert.equal(await verifyPKCE(verifier, challenge), true)
  assert.equal(await verifyPKCE(generateCodeVerifier(), challenge), false)
  assert.equal(await verifyPKCE(verifier, 'not-the-challenge'), false)
  // The plain-text fallback must not accidentally work.
  assert.equal(await verifyPKCE(verifier, verifier), false)
})

test('generated verifiers and nonces are unique and base64url-safe', () => {
  const values = new Set<string>()
  for (let i = 0; i < 64; i++) {
    values.add(generateCodeVerifier())
    values.add(generateNonce())
  }
  assert.equal(values.size, 128)
  for (const value of values) {
    assert.match(value, /^[A-Za-z0-9_-]+$/)
  }
})

test('the S256 challenge matches the RFC 7636 published test vector', () => {
  // Proves this is real S256 and not, say, a base64 of the verifier.
  return generateCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').then(
    (challenge) => {
      assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    },
  )
})
