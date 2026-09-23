/**
 * What this worker can actually do today, and why it cannot do the rest.
 *
 * `plan` exists because the honest answer to "can you move X to Y?" is usually
 * "not yet, and here is the specific thing that is missing". A tool that
 * answers by attempting and failing costs a signature; a tool that answers by
 * guessing costs trust. So the capability map is derived from the SDK
 * catalogue at runtime and the gaps are named with the wishlist item that
 * would close them.
 *
 * Measured against @elsoul/erpc-sdk 0.8.0 (2026-09-22). None of these numbers
 * are written down here -- the shape is, and the catalogue answers the rest,
 * so a new SDK version changes the answers without changing this file.
 */
import { canonicalNetwork, SOLANA_MAINNET_CAIP2 } from './networks'
import { BASE_NETWORK } from './x402'

/** Wishlist items from the plan's appendix A, in the order they unblock. */
export type Wish = 'W1' | 'W2' | 'W3' | 'W4'

export const WISH_REASON: Record<Wish, string> = {
  W1: 'the SDK has no Base RPC namespace, so Base balances cannot be read',
  W2: 'the SDK has no reviewed Base pool, so a Base swap cannot be quoted',
  W3: 'the SDK ships no Mayan capability into or out of Base',
  W4: 'the Solana pools are catalogued but carry no fee and no quote adapter, so a Solana swap cannot be quoted',
}

export interface Unsupported {
  readonly supported: false
  readonly needs: Wish
  readonly why: string
}

export interface SupportedSwap {
  readonly supported: true
  readonly chainId: string
  readonly poolDefinitionId: string
  readonly inputTokenDeploymentId: string
  readonly outputTokenDeploymentId: string
  readonly inputSymbol: string
  readonly outputSymbol: string
}

export function unsupported(needs: Wish): Unsupported {
  return { supported: false, needs, why: WISH_REASON[needs] }
}

/**
 * The catalogue rows this module needs, in the shape the SDK exposes them.
 * Declared structurally rather than imported so the decision logic can be
 * driven directly by a test instead of re-implemented in one.
 */
export interface TokenRow {
  readonly deploymentId: string
  readonly chainId: string
  readonly symbol: string
  readonly standard: string
  readonly status: string
}

export interface PoolRow {
  readonly poolDefinitionId: string
  readonly chainId: string
  readonly token0DeploymentId: string
  readonly token1DeploymentId: string
  readonly adapterKind: string
  readonly feeNumerator: string | null
  readonly feeDenominator: string | null
  readonly status: string
}

/**
 * A pool this worker is willing to route a payment through.
 *
 * 🔴 Three conditions, and each one exists because of something measured in
 * the shipped catalogue rather than as a general precaution:
 *
 *   1. Both tokens resolve in the curated token table. The catalogue also
 *      carries pools whose tokens are `discovered-token-<hash>` — real pools,
 *      but not reviewed ones, and a money tool should not route through a
 *      token nobody named.
 *   2. The adapter can be quoted. `solana-orca-whirlpool` and
 *      `solana-raydium-clmm` appear as catalogue data with no quote code.
 *   3. The fee is present. A constant-product quote is arithmetic on the fee;
 *      the Solana rows carry null for both halves of it.
 *
 * Conditions 2 and 3 agree today, on purpose: if a future SDK adds a quote
 * adapter but still ships null fees, this refuses rather than quoting zero.
 */
/**
 * Is this a REVIEWED token, or one the catalogue discovered?
 *
 * 🔴 A positive allowlist on the id shape, for two reasons measured on the
 * shipped catalogue (@elsoul/erpc-sdk 0.8.0):
 *
 *   1. The `discovered-` marker is on `deploymentId`, NOT on `symbol` -- a
 *      discovered token's symbol is its contract address. An earlier version
 *      of this guard tested `symbol.startsWith('discovered-')`, which matched
 *      0 of 70 tokens and therefore could not fail, while 20 of 32 routes
 *      touched a discovered token. The docblock below claimed curation the
 *      code never performed (steiner B-2, #14054).
 *   2. Allowlist rather than denylist: `deployment-<n>` is the curated form,
 *      so a future catalogue that names discovered entries differently is
 *      excluded by default instead of admitted by default.
 */
const CURATED_DEPLOYMENT_ID = /^deployment-\d+$/

function isCurated(token: TokenRow | undefined): boolean {
  return token !== undefined && CURATED_DEPLOYMENT_ID.test(token.deploymentId)
}

/**
 * The same question about the POOL.
 *
 * 🔴 Curating both tokens said nothing about the pool that joins them.
 * Measured on the shipped catalogue: 12 routes survived token curation and
 * **8 of them ran through a `discovered-pool-*`** -- two reviewed tokens
 * joined by a pool nobody reviewed, which is a different claim from "this
 * pair is fine" (steiner N-10, #14054).
 *
 * The id shapes are `pool-<n>` and `discovered-pool-<n>`, and the allowlist
 * is positive for the reason the token one is: a catalogue that renames its
 * discovered entries is then excluded by default rather than admitted.
 *
 * Effect, measured: 12 routes -> 4, all four on named pairs
 * (USDC/WETH on Ethereum, WAVAX/USDC on Avalanche).
 */
const CURATED_POOL_ID = /^pool-\d+$/

export const QUOTABLE_ADAPTERS = ['evm-constant-product-v2'] as const

export function routableSwaps(
  tokens: readonly TokenRow[],
  pools: readonly PoolRow[],
): SupportedSwap[] {
  const byId = new Map(tokens.filter((t) => t.status === 'active').map((t) => [t.deploymentId, t]))
  const routes: SupportedSwap[] = []

  for (const pool of pools) {
    if (pool.status !== 'active') continue
    if (!CURATED_POOL_ID.test(pool.poolDefinitionId)) continue
    if (!isCurated(byId.get(pool.token0DeploymentId))) continue
    if (!isCurated(byId.get(pool.token1DeploymentId))) continue
    if (!(QUOTABLE_ADAPTERS as readonly string[]).includes(pool.adapterKind)) continue
    if (pool.feeNumerator === null || pool.feeDenominator === null) continue

    const a = byId.get(pool.token0DeploymentId)
    const b = byId.get(pool.token1DeploymentId)
    if (!a || !b) continue

    // Both directions: an exact-input swap can start from either side.
    for (const [input, output] of [[a, b], [b, a]] as const) {
      // The preparation's transaction is `value: '0'` and its path entries are
      // `standard: 'erc20'`, so a native asset cannot be the INPUT. It can
      // still be an output symbol in the catalogue, which is why only the
      // input side is checked here.
      if (input.standard !== 'erc20') continue
      routes.push({
        supported: true,
        chainId: pool.chainId,
        poolDefinitionId: pool.poolDefinitionId,
        inputTokenDeploymentId: input.deploymentId,
        outputTokenDeploymentId: output.deploymentId,
        inputSymbol: input.symbol,
        outputSymbol: output.symbol,
      })
    }
  }
  return routes
}

/**
 * Why a requested swap is not routable.
 *
 * Two different "no" answers, kept apart because they tell the caller to do
 * different things. A wishlist gap means waiting for the SDK; `no-pool` means
 * this pair is not reviewed and another pair might work today.
 */
export type SwapRefusal =
  | Unsupported
  | { readonly supported: false; readonly needs: null; readonly why: string }

export function swapRefusal(chainId: string, pairLabel: string): SwapRefusal {
  // Canonical first: `solana-mainnet` is a spelling this worker itself hands
  // to the model (holdings, plan.blockedByPolicy), and the raw form fell
  // through to `needs: null` -- "not a wishlist gap" about a wishlist gap.
  const chain = canonicalNetwork(chainId)
  if (chain === canonicalNetwork(BASE_NETWORK)) return unsupported('W2')
  if (chain === SOLANA_MAINNET_CAIP2 || chain.startsWith('solana:')) {
    return unsupported('W4')
  }
  return {
    supported: false,
    needs: null,
    why:
      `no reviewed pool for ${pairLabel} on ${chainId}; this is not a wishlist ` +
      'gap, so another pair on the same chain may be routable today',
  }
}
