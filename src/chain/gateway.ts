/**
 * The ONLY path from this worker to a chain.
 *
 * Design ruling for this project: chain reach comes from `@elsoul/erpc-sdk`
 * and nowhere else. No private RPC client, no direct provider URL, no quiet
 * fallback. When the published SDK cannot do something yet, the tool that
 * needs it says so in its result -- `unsupported_yet` with the wishlist id it
 * is waiting on -- instead of reaching around the SDK.
 *
 * The capability boundary below is measured, not assumed. Re-fired against
 * the published tarball of @elsoul/erpc-sdk **0.8.1** (2026-09-24), which is
 * what this docblock instructed the next reader to do:
 *   (predicate: literal count in `dist/index.js`, which is what the package
 *    ships -- the tarball is dist + LICENSE + package.json + README only)
 *   `baseRpc`                  -> 0 occurrences
 *   `solanaRpc` / `ethereumRpc` / `avalancheCRpc` -> 11 each (positive control)
 *   `"eip155:8453"`            -> 0 occurrences
 *   bridge capability ids      -> exactly the two EURC Ethereum<->Solana ones
 *   catalogue                  -> 70 tokens / 19 pools / 4 routable swaps,
 *                                 0 Base tokens, 0 Solana pools with an
 *                                 adapter and a fee
 *
 * 🔴 **0.8.1 unblocks no wishlist item.** It is a transport fix (see
 * `createGateway`); every measurement above is byte-for-byte what 0.8.0
 * gave, including the counts of 11.
 *
 * An earlier revision of this block said "12 each, up from 11, because the
 * bundle grew by the new transport module". Both halves were wrong, and the
 * way they were wrong is worth keeping: the 12 came from counting
 * `dist/index.js` PLUS `*.d.ts` while the 11 it was compared against counted
 * one bundle, so a difference in predicate was reported as a difference in
 * the thing measured. The mechanism offered for it cannot hold either --
 * `src/transport/fetch.ts` is one line and contains no namespace identifier
 *. State the predicate with the number; that is what makes
 * the next re-measurement comparable.
 *
 * Re-measure against the tarball (never the GitHub source tree, which carries
 * unreleased additions) when a new version ships, and convert the
 * `unsupported_yet` branches the new version covers.
 */
import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import { createErpcClient } from '@elsoul/erpc-sdk'
import type { Env } from '@/types/env'

export type WishlistId = 'W1' | 'W2' | 'W3' | 'W4'

/** Networks this worker can READ today, through the SDK's namespaces. */
export const READABLE_NETWORKS = ['solana-mainnet', 'eip155:1', 'eip155:43114'] as const

/**
 * Base (eip155:8453) is deliberately absent from READABLE_NETWORKS: the SDK has
 * no Base namespace yet (W1). Note that this does NOT block the ERPC top-up --
 * paying an x402 402 with EIP-3009 `transferWithAuthorization` needs a
 * signature and an HTTPS request, not a Base RPC, and the facilitator submits
 * the transaction (the payer needs no ETH).
 */
export const BASE_NETWORK = BASE_MAINNET_CAIP2_NETWORK

export class ErpcApiKeyMissingError extends Error {
  constructor() {
    super('ERPC_API_KEY is not configured; set it with `wrangler secret put ERPC_API_KEY`')
    this.name = 'ErpcApiKeyMissingError'
  }
}

export type ErpcClient = ReturnType<typeof createErpcClient>

export function createGateway(env: Env): ErpcClient {
  if (!env.ERPC_API_KEY) throw new ErpcApiKeyMissingError()
  // 🔴 No `fetch` wrapper any more, and that is a deliberate downgrade of
  // this file's defences in exchange for a working detector.
  //
  // SDK 0.8.0 stored `globalThis.fetch` and called it as `this.#fetch(...)`;
  // workerd rejects that as an "Illegal invocation" and the SDK rewrote the
  // error to "Unable to reach ERPC", so production reached no chain at all
  // and the cause never surfaced. This worker passed a wrapper to bind it.
  //
  // 0.8.1 does the same wrapping itself. Measured in the published tarball:
  // it adds `src/transport/fetch.ts` with
  // `wrapFetch = (implementation) => (input, init) => implementation(input, init)`
  // and applies it at three construction sites -- the same one-line fix,
  // moved upstream.
  //
  // Keeping our wrapper would double-wrap harmlessly AND blind
  // `gateway.test.ts`, which drives every namespace through a stub that
  // enforces workerd's `this` rule. With our wrapper in place that test
  // passes whatever the SDK does; without it, the test is a live detector of
  // exactly this regression. Measured both ways:
  //     0.8.0 + wrapper -> 252 pass     0.8.0 - wrapper -> 251 pass / 1 fail
  //     0.8.1 + wrapper -> 252 pass     0.8.1 - wrapper -> 252 pass
  // A regression cannot reach production behind the detector either: the
  // deploy workflow runs Typecheck and Run tests before Deploy to Cloudflare.
  //
  // 🔴 Confirmed in REAL workerd, not only in the stub, because the stub is
  // this worker's own emulation of workerd's rule and the original defect was
  // invisible until a real one ran it. Isolated probe worker, wrangler 4.104.0,
  // compatibility_date 2026-05-12, dummy key, against edge.erpc.global
  // (2026-09-24):
  //
  //                    no wrapper                          with wrapper
  //     0.8.0   ErpcTransportError: Unable to reach ERPC   ErpcHttpError: HTTP 401
  //     0.8.1   ErpcHttpError: HTTP 401                    ErpcHttpError: HTTP 401
  //
  // HTTP 401 is the SUCCESS signature here: the dummy key was rejected by the
  // far end, so the request arrived.
  return createErpcClient({ apiKey: env.ERPC_API_KEY })
}

export interface Reachability {
  network: string
  ok: boolean
  detail: string
}

/**
 * One cheap call per namespace. This is how `wallet_status` reports that the
 * chain side is actually wired, rather than that the config parsed.
 */
export async function probeReachability(erpc: ErpcClient): Promise<Reachability[]> {
  const probes: Array<{ network: string; run: () => Promise<string> }> = [
    {
      network: 'solana-mainnet',
      run: async () => `slot ${String(await erpc.solana.rpc.getSlot().send())}`,
    },
    {
      network: 'eip155:1',
      run: async () => `chainId ${String(await erpc.ethereum.rpc.eth_chainId().send())}`,
    },
    {
      network: 'eip155:43114',
      run: async () => `chainId ${String(await erpc.avalanche.rpc.eth_chainId().send())}`,
    },
  ]

  return await Promise.all(
    probes.map(async ({ network, run }) => {
      try {
        return { network, ok: true, detail: await run() }
      } catch (error) {
        return {
          network,
          ok: false,
          detail: error instanceof Error ? error.message : 'unreachable',
        }
      }
    }),
  )
}

export function unsupportedYet(needs: WishlistId, what: string) {
  return {
    ok: false as const,
    error: 'unsupported_yet' as const,
    needs,
    detail: `${what} is not available in the published @elsoul/erpc-sdk yet (waiting on ${needs})`,
  }
}
