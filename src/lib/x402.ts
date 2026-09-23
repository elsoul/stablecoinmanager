/**
 * Reading a 402, as data.
 *
 * The signing itself is `@x402/core` + `@x402/evm`, exactly as the proven
 * client in `api/erpc/x402-rpc-api/.e2e-local/run-e2e-topup.mjs` does it.
 * What lives here is the part that decides *whether we are willing to pay*,
 * kept free of the SDK and of `cloudflare:workers` so it can be driven
 * directly by tests rather than re-implemented in them.
 */
import {
  BASE_MAINNET_CAIP2_NETWORK,
  ERPC_EURC_BASE_RECEIVING_WALLET,
} from '@constants/base'
import { canonicalNetwork } from './networks'

/** The treasury, from the repo's own constant rather than a second copy. */
export const ERPC_TREASURY_BASE = ERPC_EURC_BASE_RECEIVING_WALLET

export const BASE_NETWORK = BASE_MAINNET_CAIP2_NETWORK

export interface Requirement {
  scheme?: string
  network?: string
  asset?: string
  amount?: string
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
  [key: string]: unknown
}

export interface NormalizedRequirement {
  index: number
  scheme: string
  network: string
  asset: string
  amountAtomic: string
  payTo: string
  maxTimeoutSeconds?: number
  extraKeys: string[]
  /** Can this worker sign it at all? EVM exact only, today. */
  payable: boolean
  unpayableReason?: string
}

/**
 * Normalize the `accepts` array of a 402 body.
 *
 * Everything a caller decides on comes from here, so it never has to read the
 * raw body — and `extraKeys` is surfaced because #13782 was a volatile field
 * inside `extra` turning a correct signature into `price_mismatch`. Comparing
 * the KEY SET across two probes catches that before any money moves; comparing
 * the whole `extra` would flag every legitimate quote refresh.
 */
export function normalizeAccepts(accepts: unknown): NormalizedRequirement[] {
  if (!Array.isArray(accepts)) return []
  return accepts.map((raw, index) => {
    const req = (raw ?? {}) as Requirement
    const network = String(req.network ?? '')
    const scheme = String(req.scheme ?? 'exact')
    const extra = (req.extra ?? {}) as Record<string, unknown>

    let payable = true
    let unpayableReason: string | undefined
    if (!network.startsWith('eip155:')) {
      payable = false
      unpayableReason =
        `this worker signs EVM (eip155:*) requirements only; ${network || '(no network)'} needs a scheme it cannot sign yet`
    } else if (scheme !== 'exact') {
      payable = false
      unpayableReason = `unsupported x402 scheme: ${scheme}`
    }

    return {
      index,
      scheme,
      network,
      asset: String(req.asset ?? ''),
      amountAtomic: String(req.amount ?? ''),
      payTo: String(req.payTo ?? ''),
      maxTimeoutSeconds: typeof req.maxTimeoutSeconds === 'number'
        ? req.maxTimeoutSeconds
        : undefined,
      extraKeys: Object.keys(extra).sort(),
      payable,
      unpayableReason,
    }
  })
}

/**
 * Pick which requirement to pay.
 *
 * Preference is by (network, asset) in the order the plan fixes: EURC on Base
 * first, then USDC on Base. A requirement this worker cannot sign is never
 * chosen, and choosing nothing is an answer rather than a fallback to
 * whatever happened to be first.
 */
export interface AssetPreference {
  network: string
  assetAddress: string
  label: string
}

export function selectRequirement(
  requirements: readonly NormalizedRequirement[],
  preferences: readonly AssetPreference[],
): { chosen?: NormalizedRequirement; reason?: string } {
  const payable = requirements.filter((r) => r.payable)
  if (payable.length === 0) {
    return {
      reason: requirements.length === 0
        ? 'the 402 carried no requirements'
        : `none of the ${requirements.length} requirement(s) can be signed by this worker`,
    }
  }
  // 🔴 The canonicalisation here is a NO-OP today, and stays anyway.
  // `normalizeAccepts` marks anything outside `eip155:*` unpayable before
  // this runs, and eip155 ids have one spelling, so no alias can reach the
  // comparison (steiner N-18, #14054). It is here because the alternative --
  // one comparison in this file spelled differently from the six others --
  // is how the vocabulary split got in the first place. Recorded rather than
  // removed, so the next reader knows it was measured and not cargo.
  for (const preference of preferences) {
    const match = payable.find(
      (r) =>
        canonicalNetwork(r.network) === canonicalNetwork(preference.network) &&
        r.asset.toLowerCase() === preference.assetAddress.toLowerCase(),
    )
    if (match) return { chosen: match }
  }
  return {
    reason: `no requirement matched the allowed assets (${
      preferences.map((p) => `${p.label} on ${p.network}`).join(', ')
    })`,
  }
}

/** Atomic units -> a decimal string, without floating point. */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) return '0'
  const padded = atomic.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : ''
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

/**
 * Two probes of the same 402 must agree on the SHAPE of `extra`.
 *
 * Returns the keys that appeared in one probe and not the other. A non-empty
 * result means the requirement carries something that changes between reads,
 * which is the #13782 failure: sign against probe A, submit, and the server
 * compares against probe B.
 */
export function extraKeyDrift(a: readonly string[], b: readonly string[]): string[] {
  const left = new Set(a)
  const right = new Set(b)
  return [...new Set([...a, ...b])].filter((k) => left.has(k) !== right.has(k)).sort()
}
