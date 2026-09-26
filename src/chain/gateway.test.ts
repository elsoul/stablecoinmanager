import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Env } from '@/types/env'
import { createGateway, probeReachability } from './gateway.ts'

// ---------------------------------------------------------------------------
// The defect this file exists for:
//
// In production `wallet_status` reported "Unable to reach ERPC" for every
// namespace. The network was fine. @elsoul/erpc-sdk 0.8.0 stores
// `globalThis.fetch` in a private field and calls it as `this.#fetch(...)`.
// workerd refuses a fetch invoked with any `this` other than the global
// ("TypeError: Illegal invocation: function called with incorrect `this`
// reference"), and the SDK rewrites every thrown error to "Unable to reach
// ERPC", so the cause never surfaced. Node accepts the same call, which is why
// nothing here failed before deploy.
//
// Measured in local workerd (wrangler 4.104.0, compatibility_date 2026-05-12)
// against edge.erpc.global with a dummy key, 2026-09-23:
//   no `fetch` passed      -> ErpcTransportError: Unable to reach ERPC
//   wrapped `fetch` passed -> ErpcHttpError: HTTP 401   (the request arrived)
//
// Node is permissive, so the stub below enforces workerd's rule itself. Without
// it this test would go green against the broken gateway.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const RESULTS: Record<string, unknown> = {
  getSlot: 424242,
  // 🔴 The methods `holdings` actually calls: getBalance (Solana), and on each
  // EVM chain eth_chainId, eth_getBalance and eth_call (`balanceOf`). The probe
  // above uses getSlot and eth_chainId, so without these the detector covered
  // the reachability check and not the tool that reads money. Same transport,
  // but "same transport" is an inference and this file exists because an
  // inference about this transport was wrong in production.
  getBalance: { context: { slot: 1 }, value: 1234567890 },
  eth_getBalance: '0x1bc16d674ec80000',
  eth_call: '0x' + '0'.repeat(64),
}

/** Each EVM namespace answers its own chain id, as the real endpoints do. */
function chainIdFor(url: string): string {
  if (new URL(url).hostname === 'base.erpc.global') return '0x2105'
  if (new URL(url).pathname.startsWith('/ava')) return '0xa86a'
  return '0x1'
}

function installWorkerdFaithfulFetch(): string[] {
  const calls: string[] = []
  globalThis.fetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError(
        'Illegal invocation: function called with incorrect `this` reference.',
      )
    }
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string }
    const result = body.method === 'eth_chainId' ? chainIdFor(url) : RESULTS[body.method]
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  } as typeof fetch
  return calls
}

test('every namespace is reachable under workerd fetch rules', async () => {
  const calls = installWorkerdFaithfulFetch()

  const reachability = await probeReachability(
    createGateway({ ERPC_API_KEY: 'test-key-0000000000' } as Env),
  )

  assert.deepEqual(
    reachability.map(({ network, ok, detail }) => ({ network, ok, detail })),
    [
      { network: 'solana-mainnet', ok: true, detail: 'slot 424242' },
      { network: 'eip155:1', ok: true, detail: 'chainId 0x1' },
      { network: 'eip155:8453', ok: true, detail: 'chainId 0x2105' },
      { network: 'eip155:43114', ok: true, detail: 'chainId 0xa86a' },
    ],
  )
  // Positive control: the requests really went through the stub, to the
  // endpoints the SDK resolves by default -- Base to DEFAULT_BASE_ENDPOINT.
  assert.equal(calls.length, 4)
  assert.ok(calls.some((url) => new URL(url).hostname === 'base.erpc.global'))
  assert.ok(calls.every((url) => url.startsWith('https://')))
})

test('the balance reads holdings makes go through the same workerd rules', () => {
  // Not a rerun of the probe: `probeReachability` calls getSlot and
  // eth_chainId, `holdings` calls getBalance, eth_getBalance and eth_call
  // (six of its nine EVM reads are `balanceOf` calls). If a future
  // SDK binds fetch correctly on one path and not the other, the probe test
  // alone would stay green while wallet balances read as unreachable -- which
  // is the exact shape of the defect this file was created for, one method
  // over.
  //
  // Driven rather than asserted about: the stub below throws on any
  // `this !== globalThis`, as workerd does.
  const calls = installWorkerdFaithfulFetch()
  const erpc = createGateway({ ERPC_API_KEY: 'test-key-0000000000' } as Env)

  return Promise.all([
    erpc.solana.rpc.getBalance('11111111111111111111111111111111').send(),
    erpc.ethereum.rpc.eth_getBalance('0x0000000000000000000000000000000000000000', 'latest').send(),
    erpc.avalanche.rpc.eth_getBalance('0x0000000000000000000000000000000000000000', 'latest').send(),
    erpc.base.rpc.eth_getBalance('0x0000000000000000000000000000000000000000', 'latest').send(),
    erpc.base.rpc.eth_call(
      { to: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', data: `0x70a08231${'0'.repeat(64)}` },
      'latest',
    ).send(),
  ]).then((results) => {
    assert.equal(results.length, 5)
    // Positive control: the requests really went out, one per namespace plus
    // the `balanceOf` call on Base.
    assert.equal(calls.length, 5, `expected five requests, got ${JSON.stringify(calls)}`)
    assert.ok(calls.every((url) => url.startsWith('https://')))
  })
})

test('an EVM namespace that answers the wrong chain id is reported ok:false', async () => {
  const realFetchLocal = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string }
    const url = String(input instanceof Request ? input.url : input)
    // Base endpoint misrouted to Ethereum mainnet.
    const result = body.method === 'eth_chainId'
      ? (new URL(url).hostname === 'base.erpc.global' ? '0x1' : chainIdFor(url))
      : RESULTS[body.method]
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const reachability = await probeReachability(
      createGateway({ ERPC_API_KEY: 'test-key-0000000000' } as Env),
    )
    const base = reachability.find((r) => r.network === 'eip155:8453')
    assert.deepEqual(base, { network: 'eip155:8453', ok: false, detail: 'chainId 0x1 (expected 0x2105)' })
  } finally {
    globalThis.fetch = realFetchLocal
  }
})
