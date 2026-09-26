/**
 * The bridge leg: Mayan Swift v2, as far as the published SDK goes.
 *
 * The capability list is PARSED from the SDK at runtime rather than written
 * down here. As measured on 2026-09-21, the SDK exposed two capabilities --
 * EURC between Ethereum and Solana -- and that number is exactly the kind of
 * fact that goes stale in a comment while the code keeps working.
 * Reading it means a new SDK version changes the answer without an edit, and
 * nothing here can offer a route the SDK does not carry.
 */
import { BRIDGE_CAPABILITIES_JSON } from '@elsoul/erpc-sdk'
import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import { unsupported, type Unsupported } from '@/lib/routes'
import { canonicalNetwork } from '@/lib/networks'

export interface BridgeCapability {
  readonly bridgeCapabilityId: string
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceTokenDeploymentId: string
  readonly destinationTokenDeploymentId: string
  readonly status: string
}

/** Active capabilities, as the shipped SDK carries them. */
export function bridgeCapabilities(): BridgeCapability[] {
  const parsed = JSON.parse(BRIDGE_CAPABILITIES_JSON) as BridgeCapability[]
  return parsed.filter((c) => c.status === 'active')
}

export type BridgeRoute =
  | { readonly supported: true; readonly capability: BridgeCapability }
  | Unsupported
  | { readonly supported: false; readonly needs: null; readonly why: string }

/**
 * Can this worker bridge from A to B?
 *
 * 🔴 Direction matters and is not symmetric in general: the SDK lists each
 * direction as its own capability, so "EURC Ethereum -> Solana" existing tells
 * you nothing about the reverse. Both happen to ship today; asking the list
 * rather than assuming symmetry is what keeps that a fact rather than a habit.
 */
export function bridgeRoute(sourceChainId: string, destinationChainId: string): BridgeRoute {
  // Canonical on both sides. The SDK names chains in CAIP-2 while this
  // worker's own vocabulary says `solana-mainnet`, and BridgeArgs takes free
  // strings -- so `bridgeRoute('eip155:1', 'solana-mainnet')` used to answer
  // "the SDK ships no Mayan capability ... this is not a wishlist gap" about
  // a capability that exists.
  const from = canonicalNetwork(sourceChainId)
  const to = canonicalNetwork(destinationChainId)
  const capability = bridgeCapabilities().find(
    (c) =>
      canonicalNetwork(c.sourceChainId) === from &&
      canonicalNetwork(c.destinationChainId) === to,
  )
  if (capability) return { supported: true, capability }

  // Base in either direction is the wishlist item, and saying so is more
  // useful than "no capability found" -- it tells the caller whether to wait
  // or to choose a different pair.
  if (
    from === canonicalNetwork(BASE_MAINNET_CAIP2_NETWORK) ||
    to === canonicalNetwork(BASE_MAINNET_CAIP2_NETWORK)
  ) {
    return unsupported('W3')
  }
  return {
    supported: false,
    needs: null,
    why:
      `the SDK ships no Mayan capability from ${sourceChainId} to ${destinationChainId}; ` +
      'this is not a wishlist gap, so another pair may work today',
  }
}
