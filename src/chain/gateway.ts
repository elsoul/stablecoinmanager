/**
 * The ONLY path from this worker to a chain.
 *
 * By design, chain reach comes from `@elsoul/erpc-sdk` and nowhere else. No
 * private RPC client, no direct provider URL, no quiet fallback. When the
 * published SDK cannot do something yet, the tool that needs it says so in its
 * result -- `unsupported_yet` with the wishlist id it is waiting on -- instead
 * of reaching around the SDK.
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
 * `src/transport/fetch.ts` is one line and contains no namespace identifier.
 * State the predicate with the number; that is what makes the next
 * re-measurement comparable.
 *
 * 🔴 **0.9.0 (2026-09-26) unblocks W1.** Measured in the published tarball:
 * `ErpcClient.base.rpc` (HTTP JSON-RPC only -- `eth_chainId`, `eth_getBalance`,
 * `eth_call`; no WebSocket), `DEFAULT_BASE_ENDPOINT = "https://base.erpc.global"`,
 * `baseEndpoint` / `baseRpc` config overrides, `TOKEN_CHAIN_IDS.baseMainnet =
 * "eip155:8453"`, and `tokens.base` = { ETH: deployment-0061, USDC:
 * deployment-0062, EURC: deployment-0063 }. The public export list of 0.8.1
 * is a strict subset of 0.9.0's (nothing removed or renamed); typecheck and
 * the full test suite passed unchanged on 0.9.0 before any code here moved.
 * Base is read with the same `apiKey` as Ethereum and Avalanche: the SDK
 * routes `base` to `baseEndpoint` through the same legacy HTTP transport.
 *
 * Data delta 0.8.1 -> 0.9.0, measured on the two published tarballs (`npm
 * pack` of each; predicate: `Object.keys(await import('dist/index.js'))` and
 * the lengths of the exported catalogues): public exports 93 -> 94
 * (+`DEFAULT_BASE_ENDPOINT`, nothing removed -- that is the "strict subset"
 * above, measured); `TOKEN_DEPLOYMENTS` 70 -> 73 (+deployment-0061/0062/0063
 * = Base ETH/USDC/EURC); `POOL_DEFINITIONS` 19 -> 19; `BRIDGE_CAPABILITIES_JSON`
 * 2 -> 4 entries, all Ethereum<->Solana (as-of 2026-09-16 -> 2026-09-17). So
 * the "exactly the two EURC" line above is a 0.8.1 fact. `bridgeRoute` in
 * `bridge.ts` still picks the first capability for a chain pair and takes no
 * token; harmless while nothing here signs a bridge, to be resolved before
 * it does.
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
export const READABLE_NETWORKS = [
  'solana-mainnet',
  'eip155:1',
  BASE_MAINNET_CAIP2_NETWORK,
  'eip155:43114',
] as const

/**
 * Base (eip155:8453) is readable since @elsoul/erpc-sdk 0.9.0 (`erpc.base.rpc`).
 * Paying an x402 402 on Base never needed it -- EIP-3009
 * `transferWithAuthorization` is a signature plus HTTPS and the facilitator
 * submits the transaction -- but balances did.
 */
export const BASE_NETWORK = BASE_MAINNET_CAIP2_NETWORK

/** The chain id each EVM namespace must answer; anything else is a wrong route. */
export const EXPECTED_CHAIN_IDS: Readonly<Record<string, string>> = {
  'eip155:1': '0x1',
  [BASE_MAINNET_CAIP2_NETWORK]: '0x2105',
  'eip155:43114': '0xa86a',
}

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
      network: BASE_MAINNET_CAIP2_NETWORK,
      run: async () => `chainId ${String(await erpc.base.rpc.eth_chainId().send())}`,
    },
    {
      network: 'eip155:43114',
      run: async () => `chainId ${String(await erpc.avalanche.rpc.eth_chainId().send())}`,
    },
  ]

  return await Promise.all(
    probes.map(async ({ network, run }) => {
      try {
        const detail = await run()
        // An endpoint that answers with the WRONG chain is not reachable in
        // any sense that matters: balances read there belong to another chain.
        const expected = EXPECTED_CHAIN_IDS[network]
        if (expected && detail !== `chainId ${expected}`) {
          return { network, ok: false, detail: `${detail} (expected ${expected})` }
        }
        return { network, ok: true, detail }
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
