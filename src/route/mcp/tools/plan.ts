import type { Env } from '@/types/env'
import { effectivePolicy } from '../policyFor'
import { catalogPools, catalogTokens } from '@/chain/catalog'
import { routableSwaps, swapRefusal, unsupported, WISH_REASON } from '@/lib/routes'
import { BASE_NETWORK } from '@/lib/x402'
import { bridgeCapabilities } from '@/chain/bridge'
import { ok, type ToolResult } from '../result'

export interface PlanArgs {
  /** Optional: ask about one route specifically. */
  fromSymbol?: string
  toSymbol?: string
  chainId?: string
}

/**
 * Answer "can you move X to Y?" honestly.
 *
 * 🔴 The reason this tool exists: the honest answer is usually "not yet, and
 * here is the specific thing that is missing". A tool that answers by
 * attempting and failing costs a signature. A tool that answers optimistically
 * costs trust, and it is the more likely failure -- a model asked whether it
 * can do something tends to say yes.
 *
 * So the capability map is DERIVED from the shipped catalogue at runtime, not
 * written down. A new SDK version changes the answers without anyone editing
 * this file, and nothing here can claim a route the catalogue cannot quote.
 */
export async function plan(env: Env, args: PlanArgs): Promise<ToolResult> {
  const { effective: policy } = await effectivePolicy(env)
  const routes = routableSwaps(catalogTokens(), catalogPools())

  const allowed = policy.allowedNetworks
  const withinPolicy = routes.filter((r) => allowed.allows(r.chainId))

  // Asked about a specific pair.
  if (args.fromSymbol && args.toSymbol) {
    const chain = args.chainId
    const match = withinPolicy.find(
      (r) =>
        r.inputSymbol.toUpperCase() === args.fromSymbol!.toUpperCase() &&
        r.outputSymbol.toUpperCase() === args.toSymbol!.toUpperCase() &&
        (chain === undefined || r.chainId === chain),
    )
    if (match) {
      return ok({ supported: true, route: match, policy }, [
        `Call swap with fromSymbol ${match.inputSymbol}, toSymbol ${match.outputSymbol}, ` +
          `chainId ${match.chainId} and an amountIn in atomic units.`,
      ])
    }

    const refusal = swapRefusal(
      chain ?? BASE_NETWORK,
      `${args.fromSymbol}/${args.toSymbol}`,
    )
    // A pair that is outside the policy is refused for a different reason than
    // one the SDK cannot quote, and the caller can act on only one of them.
    const blockedByPolicy = routes.some(
      (r) =>
        r.inputSymbol.toUpperCase() === args.fromSymbol!.toUpperCase() &&
        r.outputSymbol.toUpperCase() === args.toSymbol!.toUpperCase() &&
        !allowed.allows(r.chainId),
    )
    const reason = blockedByPolicy
      ? {
        needs: null,
        why:
          `${args.fromSymbol}->${args.toSymbol} is quotable, but not on a network this ` +
          `worker is allowed to use (${policy.allowedNetworks.describe()})`,
      }
      : { needs: refusal.needs, why: refusal.why }

    return ok(
      { supported: false, ...reason, policy },
      blockedByPolicy
        ? ['Change POLICY_ALLOWED_NETWORKS and redeploy, or choose an allowed network.']
        : ['Call plan with no arguments to see every route available today.'],
    )
  }

  // The whole picture.
  return ok(
    {
      swap: withinPolicy,
      bridge: {
        // 🔴 DERIVED and policy-filtered, not written down. Two defects met
        // here: a hardcoded list said "EURC Ethereum -> Solana" while the
        // code that answers a bridge request consulted the SDK, and nothing
        // applied `allowedNetworks` to it at all. So `plan` advertised routes
        // that `bridge` refused -- the caller was told to do a thing and then
        // told it was not allowed, with no way to reconcile the two
        // (steiner B-5, #14054). The same defect class as the curation
        // docblock that declared a rule the implementation did not have.
        //
        // `routes` and `elsewhere` are separate keys on purpose: an earlier
        // version put the available list under `supported` and then spread
        // `unsupported('W3')` over it, which replaced the list with `false`.
        // The type checker caught it; a caller would have seen "bridging is
        // unsupported" with the working routes silently gone.
        routes: bridgeCapabilities()
          .filter((c) =>
            allowed.allows(c.sourceChainId) &&
            allowed.allows(c.destinationChainId)
          )
          .map((c) => ({
            bridgeCapabilityId: c.bridgeCapabilityId,
            from: c.sourceChainId,
            to: c.destinationChainId,
          })),
        blockedByPolicy: bridgeCapabilities()
          .filter((c) =>
            !allowed.allows(c.sourceChainId) ||
            !allowed.allows(c.destinationChainId)
          )
          .map((c) => ({
            from: c.sourceChainId,
            to: c.destinationChainId,
            why: `not within allowedNetworks (${allowed.describe()})`,
          })),
        elsewhere: unsupported('W3'),
        note: 'bridge capability ids come from the SDK; Base in either direction is not among them',
      },
      base: unsupported('W1'),
      solanaSwap: unsupported('W4'),
      policy,
    },
    [
      'Call plan with fromSymbol and toSymbol to ask about one route.',
      'Everything listed under `swap` can be quoted today; the rest names what is missing.',
    ],
    Object.entries(WISH_REASON).map(([wish, why]) => `${wish}: ${why}`),
  )
}
