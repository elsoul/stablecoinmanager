import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAppOidcJwksClient } from './appOidcJwks.ts'

// ---------------------------------------------------------------------------
// Pointer: docs/superpowers/plans/2026-09-25-stablecoin-manager-app-oidc-branch-madeen.md
// §2-B, §4-C. Injected fetch + clock; the factory only (not the production
// singleton), so each test is isolated.
// ---------------------------------------------------------------------------

const ISSUER = 'https://app-oidc-jwks-test.example.com'
const URL_JWKS = `${ISSUER}/.well-known/jwks.json`

function key(kid: string) {
  return { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid, use: 'sig', alg: 'ES256' }
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

type TestRequestInit = RequestInit & { cache?: string }

function stubFetch(
  responses: Array<() => Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: TestRequestInit }> } {
  const calls: Array<{ url: string; init: TestRequestInit }> = []
  let index = 0
  const impl = (async (input: RequestInfo | URL, init?: TestRequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const factory = responses[Math.min(index, responses.length - 1)]
    if (index < responses.length - 1) index++
    return factory()
  }) as typeof fetch
  return { fetch: impl, calls }
}

function clock(startSeconds: number) {
  let now = startSeconds * 1000
  return {
    now: () => now,
    advance: (seconds: number) => {
      now += seconds * 1000
    },
  }
}

test('a fresh JWKS is cached for max-age seconds, then refetched', async () => {
  const time = clock(1_000_000)
  const stub = stubFetch([
    () => jsonResponse({ keys: [key('a')] }, { headers: { 'cache-control': 'max-age=300' } }),
    () => jsonResponse({ keys: [key('b')] }, { headers: { 'cache-control': 'max-age=300' } }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })

  assert.deepEqual(await client.getJwks(), { keys: [key('a')] })
  assert.equal(stub.calls.length, 1)

  time.advance(299)
  assert.deepEqual(await client.getJwks(), { keys: [key('a')] })
  assert.equal(stub.calls.length, 1, 'still within max-age: no refetch')

  time.advance(2) // total 301s
  assert.deepEqual(await client.getJwks(), { keys: [key('b')] })
  assert.equal(stub.calls.length, 2)
})

test('max-age above 300 is capped at 300', async () => {
  const time = clock(2_000_000)
  const stub = stubFetch([
    () => jsonResponse({ keys: [key('a')] }, { headers: { 'cache-control': 'max-age=600' } }),
    () => jsonResponse({ keys: [key('b')] }, { headers: { 'cache-control': 'max-age=600' } }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })

  await client.getJwks()
  time.advance(299)
  await client.getJwks()
  assert.equal(stub.calls.length, 1, 'a 600s max-age is capped at 300, not honored in full')

  time.advance(2)
  await client.getJwks()
  assert.equal(stub.calls.length, 2)
})

test('a short max-age refetches after its own window, not after 300', async () => {
  const time = clock(3_000_000)
  const stub = stubFetch([
    () => jsonResponse({ keys: [key('a')] }, { headers: { 'cache-control': 'max-age=60' } }),
    () => jsonResponse({ keys: [key('b')] }, { headers: { 'cache-control': 'max-age=60' } }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })

  await client.getJwks()
  time.advance(60)
  await client.getJwks()
  assert.equal(stub.calls.length, 1)

  time.advance(1) // total 61s
  await client.getJwks()
  assert.equal(stub.calls.length, 2)
})

test('the Age header is subtracted from max-age', async () => {
  const time = clock(4_000_000)
  const stub = stubFetch([
    () =>
      jsonResponse(
        { keys: [key('a')] },
        { headers: { 'cache-control': 'max-age=300', age: '250' } },
      ),
    () => jsonResponse({ keys: [key('b')] }, { headers: { 'cache-control': 'max-age=300' } }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })

  await client.getJwks()
  time.advance(50) // remaining TTL is 300 - 250 = 50s
  await client.getJwks()
  assert.equal(stub.calls.length, 1)

  time.advance(1) // total 51s
  await client.getJwks()
  assert.equal(stub.calls.length, 2)
})

test('no Cache-Control, or no-store/no-cache, means every call refetches', async () => {
  const headerCases: Record<string, string>[] = [
    {},
    { 'cache-control': 'no-store' },
    { 'cache-control': 'no-cache' },
  ]
  for (const headers of headerCases) {
    const time = clock(5_000_000)
    const stub = stubFetch([
      () => jsonResponse({ keys: [key('a')] }, { headers }),
      () => jsonResponse({ keys: [key('a')] }, { headers }),
    ])
    const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })
    await client.getJwks()
    await client.getJwks()
    assert.equal(stub.calls.length, 2, JSON.stringify(headers))
  }
})

test('an unknown kid forces a refetch even within the TTL window, with cache: no-store', async () => {
  const time = clock(6_000_000)
  const stub = stubFetch([
    () => jsonResponse({ keys: [key('a')] }, { headers: { 'cache-control': 'max-age=300' } }),
    () => jsonResponse({ keys: [key('a'), key('b')] }, { headers: { 'cache-control': 'max-age=300' } }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })

  const first = await client.getJwks()
  assert.equal(stub.calls.length, 1)
  assert.ok(!first.keys.some((k) => k.kid === 'b'), 'b is not present yet')

  // Simulate "unknown kid" resolution: caller re-asks with force.
  const forced = await client.getJwks({ force: true })
  assert.equal(stub.calls.length, 2)
  assert.ok(forced.keys.some((k) => k.kid === 'b'))
  assert.equal(stub.calls[1].init.cache, 'no-store')
})

test('rotation: a key removed from the JWKS is still accepted within the old TTL, refused after', async () => {
  const time = clock(7_000_000)
  const stub = stubFetch([
    () => jsonResponse({ keys: [key('v1-a'), key('v1-b')] }, { headers: { 'cache-control': 'max-age=300' } }),
    () => jsonResponse({ keys: [key('v1-b')] }, { headers: { 'cache-control': 'max-age=300' } }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })

  const v1 = await client.getJwks()
  assert.ok(v1.keys.some((k) => k.kid === 'v1-a'))

  time.advance(299)
  const stillCached = await client.getJwks()
  assert.ok(stillCached.keys.some((k) => k.kid === 'v1-a'), 'stale-but-valid cache still has v1-a')
  assert.equal(stub.calls.length, 1)

  time.advance(2) // total 301s -> TTL expired
  const v2 = await client.getJwks()
  assert.ok(!v2.keys.some((k) => k.kid === 'v1-a'), 'v1-a is gone after the TTL, refetched')
})

for (
  const [name, factory] of [
    ['a 3xx status', () => new Response(null, { status: 302 })],
    ['a 500 status', () => new Response('boom', { status: 500 })],
    ['broken JSON', () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a duplicate kid', () => jsonResponse({ keys: [key('dup'), key('dup')] })],
    ['21 keys', () => jsonResponse({ keys: Array.from({ length: 21 }, (_, i) => key(`k${i}`)) })],
  ] as const
) {
  test(`fetch failure (${name}) is jwks_unavailable and is not cached`, async () => {
    const time = clock(8_000_000)
    const stub = stubFetch([factory, factory])
    const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })
    await assert.rejects(() => client.getJwks())
    // No `force` here on purpose: if a failure were ever cached (e.g. an
    // empty JWKS on error), this second, ordinary call would silently return
    // it from cache instead of refetching, and the call count below would
    // stay at 1 instead of 2.
    await assert.rejects(() => client.getJwks())
    assert.equal(stub.calls.length, 2, 'nothing was cached from the failed attempt')
  })
}

test('exactly 20 keys is accepted', async () => {
  const time = clock(9_000_000)
  const stub = stubFetch([
    () => jsonResponse({ keys: Array.from({ length: 20 }, (_, i) => key(`k${i}`)) }),
  ])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })
  const result = await client.getJwks()
  assert.equal(result.keys.length, 20)
})

test('the request URL is the well-known JWKS path, exactly', async () => {
  const time = clock(10_000_000)
  const stub = stubFetch([() => jsonResponse({ keys: [key('a')] })])
  const client = createAppOidcJwksClient(ISSUER, { fetch: stub.fetch, now: time.now })
  await client.getJwks()
  assert.equal(stub.calls[0].url, URL_JWKS)
})
