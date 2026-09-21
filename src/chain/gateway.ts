/**
 * The ONLY path from this worker to a chain.
 *
 * Kawasaki's ruling for this thread: chain reach comes from `@elsoul/erpc-sdk`
 * and nowhere else. No private RPC client, no direct provider URL, no quiet
 * fallback. When the published SDK cannot do something yet, the tool that
 * needs it says so in its result -- `unsupported_yet` with the wishlist id it
 * is waiting on -- instead of reaching around the SDK.
 *
 * The capability boundary below is measured, not assumed. Against the
 * published tarball of @elsoul/erpc-sdk 0.8.0 (2026-09-21):
 *   `baseRpc`                  -> 0 occurrences
 *   `solanaRpc` / `ethereumRpc` / `avalancheCRpc` -> 11 each (positive control)
 *   `"eip155:8453"`            -> 0 occurrences
 *   bridge capability ids      -> exactly the two EURC Ethereum<->Solana ones
 * Re-measure against the tarball (never the GitHub source tree, which carries
 * unreleased additions) when a new version ships, and convert the
 * `unsupported_yet` branches the new version covers.
 */
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
export const BASE_NETWORK = 'eip155:8453'

export class ErpcApiKeyMissingError extends Error {
  constructor() {
    super('ERPC_API_KEY is not configured; set it with `wrangler secret put ERPC_API_KEY`')
    this.name = 'ErpcApiKeyMissingError'
  }
}

export type ErpcClient = ReturnType<typeof createErpcClient>

export function createGateway(env: Env): ErpcClient {
  if (!env.ERPC_API_KEY) throw new ErpcApiKeyMissingError()
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
