/** Base (OP Stack L2) mainnet identifier used by ERPC EURC settlement via x402. */
export const BASE_MAINNET_CHAIN_ID = 8_453 as const

/** CAIP-2 network id the x402 protocol uses for Base mainnet. */
export const BASE_MAINNET_CAIP2_NETWORK = 'eip155:8453' as const

/** Canonical public API network label used by this project's own APIs. */
export const BASE_MAINNET_NETWORK = 'base-mainnet' as const

/**
 * Circle's official EURC contract on Base mainnet.
 * Source: https://developers.circle.com/stablecoins/eurc-contract-addresses
 * (fetched 2026-09-10); the live x402 facilitator advertises the same
 * address.
 */
export const EURC_BASE_MAINNET_CONTRACT =
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42' as const

/**
 * SHA-256 of the exact runtime bytecode at the official Base EURC proxy.
 * Reproducible with `eth_getCode` at Base mainnet block 51,131,951
 * (0x4a27453de5cc2324494de6bf74d135a3edc6739277c0dd0b35107bfbdf9e745e),
 * measured 2026-09-10 via https://mainnet.base.org.
 */
export const EURC_BASE_MAINNET_RUNTIME_CODE_SHA256 =
  'c9cf7c3f11c4d3d818801b5a965cea3bae6ff3b9b923242b91a9b4e5888e7835' as const

/** Exact runtime byte length covered by the pinned digest above. */
export const EURC_BASE_MAINNET_RUNTIME_CODE_BYTES = 1_798 as const

/**
 * EIP-712 domain of the Base EURC contract, read back on-chain 2026-09-10
 * (`name()` / `version()`). The x402 `exact` scheme carries these in `extra`
 * for EIP-3009 `transferWithAuthorization`.
 */
export const EURC_BASE_MAINNET_EIP712_NAME = 'EURC' as const
export const EURC_BASE_MAINNET_EIP712_VERSION = '2' as const

/** EURC uses six decimal places on Base. */
export const EURC_BASE_DECIMALS = 6 as const

/**
 * Public treasury address that receives Base EURC through this project's
 * x402 facilitator. The facilitator hands one `payTo` to every EVM asset, so
 * the address was confirmed 2026-09-10 against the `Transfer` log `to` of a
 * live per-call settlement
 * 0x79fad18e90df735606adf74e5aa4b3762eecc1eac860bc0e560e9e1096d1926c
 * (Base block 51,130,065 — a USDC payment; `tx.to` there is the token and
 * `tx.from` the facilitator, which is why the Transfer log, not the tx
 * envelope, is the citation). Lowercase on purpose: downstream consumers
 * either compare after `toLowerCase()` or validate with a lowercase-only
 * regex, and a checksummed constant would be rejected there rather than
 * normalised -- so keep this literal lowercase.
 */
export const ERPC_EURC_BASE_RECEIVING_WALLET =
  '0x490842c32b83653dfd06eeeb53b9dbbf5d87f597' as const

/**
 * Previously used Base treasuries that may still receive in-flight x402
 * settlements after a rotation. Downstream systems accept a Transfer to any
 * address in {current} ∪ {retired}; quotes and the x402 402 always advertise
 * the current one.
 */
export const ERPC_EURC_BASE_RETIRED_RECEIVING_WALLETS: readonly `0x${string}`[] =
  Object.freeze([])

/** Public transaction explorer prefix used by receipts and email. */
export const BASE_EXPLORER_TX_BASE_URL = 'https://basescan.org/tx/' as const

/**
 * Reference only. USDC on Base is NOT accepted for credit top-ups
 * (design decision, 2026-09-10: top-ups are EURC-denominated only).
 */
export const USDC_BASE_MAINNET_CONTRACT =
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const
