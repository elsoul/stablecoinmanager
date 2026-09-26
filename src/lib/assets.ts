/**
 * Which (network, asset) pairs this worker is willing to pay, in order.
 *
 * The ordering is a preference, not a claim about what works. EURC is first
 * because it is the pair the proven client exercises (see chain/x402Client.ts);
 * USDC on Base is offered because a generic 402 challenge may name it, and it
 * has NOT been exercised end to end from here.
 *
 * Addresses are imported, never retyped. `constants/base.ts` carries the
 * official Circle contracts together with their provenance (and, for EURC, a
 * bytecode SHA read back on-chain). A second copy of a token address is a
 * thing that can silently drift into paying the wrong asset.
 */
import {
  EURC_BASE_DECIMALS,
  EURC_BASE_MAINNET_CONTRACT,
  USDC_BASE_MAINNET_CONTRACT,
} from '@constants/base'
import type { EffectivePolicyValue } from './policy'
import { BASE_NETWORK } from './x402'
import type { AssetPreference } from './x402'

export const EURC_BASE = EURC_BASE_MAINNET_CONTRACT
export const USDC_BASE = USDC_BASE_MAINNET_CONTRACT

const CATALOG: Array<AssetPreference & { symbol: string }> = [
  { network: BASE_NETWORK, assetAddress: EURC_BASE, label: 'EURC', symbol: 'EURC' },
  { network: BASE_NETWORK, assetAddress: USDC_BASE, label: 'USDC', symbol: 'USDC' },
]

/** The catalog, filtered by what the policy currently allows. */
/**
 * 🔴 Takes the EFFECTIVE policy, not a bare `Policy`.
 *
 * It was the last reader on the money path outside the brand. Harmless while
 * it read only `allowedAssets` and `allowedNetworks`, neither of which is
 * overridable -- and that is exactly the shape named at review:
 * one function outside the barrier reads as "the barrier covers everything"
 * until the day someone makes an asset list overridable, at which point this
 * is the only place still consulting the ceiling.
 *
 * Making it a type error today costs one word and removes a future silent
 * divergence, which is the trade the rest of this package has already made
 * three times.
 */
export function allowedAssetPreferences(policy: EffectivePolicyValue): AssetPreference[] {
  const assets = new Set(policy.allowedAssets.map((a) => a.toUpperCase()))
  return CATALOG.filter(
    (entry) => assets.has(entry.symbol) && policy.allowedNetworks.allows(entry.network),
  ).map(({ network, assetAddress, label }) => ({ network, assetAddress, label }))
}

/**
 * The subset an ERPC credit top-up may be paid in: EURC only.
 *
 * 🔴 This is NOT the policy's business and must not widen with it. Top-ups are
 * EURC-denominated by a standing ruling -- `constants/base.ts` records it on
 * USDC_BASE_MAINNET_CONTRACT: "USDC on Base is NOT accepted for credit top-ups
 * (design decision, 2026-09-10: top-ups are EURC-denominated only)".
 *
 * Without this, `erpc_topup` inherits x402_pay's preferences, and a 402 that
 * offered USDC would be paid in USDC -- correct as a payment, wrong as a
 * top-up, and wrong quietly. Relying on the server never offering USDC would
 * make a ruling depend on the other side's configuration.
 *
 * The policy still applies on top: it can narrow this to nothing (by removing
 * EURC or the Base network), it just cannot add USDC back.
 */
export function topupAssetPreferences(policy: EffectivePolicyValue): AssetPreference[] {
  return allowedAssetPreferences(policy).filter(
    (entry) => entry.assetAddress.toLowerCase() === EURC_BASE.toLowerCase(),
  )
}

/**
 * Decimals for the assets above. Both are 6, and the value is imported rather
 * than written: a wrong decimal count is a payment off by a factor of a
 * million, in whichever direction.
 */
export const ASSET_DECIMALS = EURC_BASE_DECIMALS
