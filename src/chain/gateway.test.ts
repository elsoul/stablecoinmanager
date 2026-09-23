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
  eth_chainId: '0x1',
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
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: RESULTS[body.method] }),
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
      { network: 'eip155:43114', ok: true, detail: 'chainId 0x1' },
    ],
  )
  // Positive control: the requests really went through the stub, to the
  // endpoints the SDK resolves by default.
  assert.equal(calls.length, 3)
  assert.ok(calls.every((url) => url.startsWith('https://')))
})
