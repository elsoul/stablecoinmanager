import type { Env } from '@/types/env'
import { effectivePolicy } from '../policyFor'
import { catalogPools, catalogTokens } from '@/chain/catalog'
import { routableSwaps, swapRefusal } from '@/lib/routes'
import { bridgeRoute } from '@/chain/bridge'
import { fail, ok, type ToolResult } from '../result'

export interface SwapArgs {
  fromSymbol: string
  toSymbol: string
  chainId: string
  amountIn: string
  slippageBps?: number
}

export interface BridgeArgs {
  fromChainId: string
  toChainId: string
  amountIn: string
  slippageBps?: number
}

/**
 * Quote and prepare a swap — and refuse everything this worker cannot honestly
 * do today.
 *
 * 🔴 This tool does NOT broadcast. Its job is to establish that the
 * SDK-side plumbing resolves: route, policy, quote, and the approval that has
 * to happen first. Broadcasting is a second signature on a second
 * transaction, and the plan's acceptance for it is a production run that has
 * not happened — the wallet is unfunded. Shipping a tool that signs on a path
 * nobody has executed is the thing the ceiling exists to prevent, done on
 * purpose.
 */
/**
 * One slippage check, used by both tools.
 *
 * `bridge` accepted a slippageBps and neither validated nor used it while
 * `swap` refused anything over the ceiling. The asymmetry was harmless while
 * neither signs, but an asymmetry reads as "the other one must have had a
 * reason" to whoever adds signing.
 */
function checkSlippage(
  requested: number | undefined,
  limit: number,
): { value: number } | { error: ToolResult } {
  // A non-finite ceiling refuses, for the same reason as checkPayment's:
  // `value > NaN` is false, so an unreadable limit would accept anything.
  // `requested ?? limit` would also hand a NaN limit straight back as the
  // value, which then fails the finiteness test -- refusal either way, but
  // through the guard rather than by accident.
  const ceiling = Number.isFinite(limit) ? limit : 0
  const value = requested ?? ceiling
  if (!Number.isFinite(value) || value < 0 || value > ceiling) {
    return {
      error: fail({ slippageBps: value, limit: ceiling }, [], [
        `slippageBps must be between 0 and ${ceiling}`,
      ]),
    }
  }
  return { value }
}

export async function swap(env: Env, args: SwapArgs): Promise<ToolResult> {
  const { effective: policy } = await effectivePolicy(env)

  if (!policy.allowedNetworks.allows(args.chainId)) {
    return fail({ chainId: args.chainId, allowed: policy.allowedNetworks.toJSON() }, [
      'Choose an allowed network, or change POLICY_ALLOWED_NETWORKS and redeploy.',
    ], [`${args.chainId} is not an allowed network`])
  }

  const slippage = checkSlippage(args.slippageBps, policy.maxSlippageBps)
  if ('error' in slippage) return slippage.error
  const slippageBps = slippage.value

  const route = routableSwaps(catalogTokens(), catalogPools()).find(
    (r) =>
      r.chainId === args.chainId &&
      r.inputSymbol.toUpperCase() === args.fromSymbol.toUpperCase() &&
      r.outputSymbol.toUpperCase() === args.toSymbol.toUpperCase(),
  )
  if (!route) {
    const refusal = swapRefusal(args.chainId, `${args.fromSymbol}/${args.toSymbol}`)
    return fail({ refusal }, ['Call plan to see every route available today.'], [refusal.why])
  }

  return ok(
    {
      route,
      amountIn: args.amountIn,
      slippageBps,
      broadcast: false,
      policy,
    },
    [
      'This returned a route and its constraints. It did NOT sign or broadcast.',
      'Broadcasting is held back until it can be exercised in production; the wallet is unfunded.',
    ],
    ['no transaction was signed'],
  )
}

/**
 * Report whether a bridge is possible, from the SDK's own capability list.
 *
 * Same boundary as `swap`: it answers, it does not move anything.
 */
export async function bridge(env: Env, args: BridgeArgs): Promise<ToolResult> {
  const { effective: policy } = await effectivePolicy(env)

  // Both ends, and the same check `swap` makes. The asymmetry was harmless
  // while neither tool signs, but an asymmetry reads as "the other one must
  // have had a reason" to whoever adds signing.
  //
  // 🔴 Through the allowlist's own `allows`, not a string match. The SDK names chains in
  // CAIP-2 and this worker's config names Solana `solana-mainnet`; a raw
  // comparison refused BOTH capabilities the SDK ships, and told the caller
  // to edit a var that could not have fixed it.
  for (const [label, chainId] of [['fromChainId', args.fromChainId], ['toChainId', args.toChainId]]) {
    if (!policy.allowedNetworks.allows(chainId)) {
      return fail({ [label]: chainId, allowed: policy.allowedNetworks.toJSON() }, [
        'Choose an allowed network, or change POLICY_ALLOWED_NETWORKS and redeploy.',
      ], [`${chainId} is not an allowed network`])
    }
  }

  const slippage = checkSlippage(args.slippageBps, policy.maxSlippageBps)
  if ('error' in slippage) return slippage.error

  const route = bridgeRoute(args.fromChainId, args.toChainId)

  if (!route.supported) {
    return fail({ route }, ['Call plan to see the bridge routes available today.'], [route.why])
  }

  return ok(
    { route, amountIn: args.amountIn, slippageBps: slippage.value, broadcast: false, policy },
    [
      'This confirmed a capability. It did NOT sign or broadcast.',
      'Broadcasting is held back until it can be exercised in production; the wallet is unfunded.',
    ],
    ['no transaction was signed'],
  )
}
