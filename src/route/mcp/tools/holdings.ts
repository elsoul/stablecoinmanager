import type { Env } from '@/types/env'
import { deriveAddresses } from '@/wallet/keys'
import {
  BASE_NETWORK,
  createGateway,
  READABLE_NETWORKS,
  unsupportedYet,
} from '@/chain/gateway'
import { formatAtomic, ok, type ToolResult } from '../result'

interface HoldingEntry {
  network: string
  address: string
  asset: string
  atomic: string
  human: string
  currency: string
}

export async function holdings(
  env: Env,
  args: { networks?: string[] } = {},
): Promise<ToolResult> {
  const addresses = deriveAddresses(env.WALLET_MNEMONIC ?? '')
  const erpc = createGateway(env)

  const requested = args.networks?.length
    ? args.networks
    : [...READABLE_NETWORKS]

  const entries: HoldingEntry[] = []
  const warnings: string[] = []
  const unsupported: unknown[] = []

  for (const network of requested) {
    if (network === BASE_NETWORK) {
      // Named explicitly rather than omitted: an agent that asked about Base
      // must be told the SDK cannot read it yet, not handed an empty list it
      // would read as "zero balance".
      unsupported.push(unsupportedYet('W1', 'Base (eip155:8453) balance reads'))
      continue
    }

    try {
      if (network === 'solana-mainnet') {
        const lamports = await erpc.solana.rpc
          .getBalance(addresses.solana)
          .send()
        const value = extractLamports(lamports)
        entries.push({
          network,
          address: addresses.solana,
          asset: 'SOL',
          atomic: value,
          human: formatAtomic(value, 9),
          currency: 'SOL',
        })
      } else if (network === 'eip155:1' || network === 'eip155:43114') {
        const namespace = network === 'eip155:1' ? erpc.ethereum : erpc.avalanche
        const hex = await namespace.rpc
          .eth_getBalance(addresses.evm, 'latest')
          .send()
        const value = BigInt(String(hex)).toString()
        entries.push({
          network,
          address: addresses.evm,
          asset: network === 'eip155:1' ? 'ETH' : 'AVAX',
          atomic: value,
          human: formatAtomic(value, 18),
          currency: network === 'eip155:1' ? 'ETH' : 'AVAX',
        })
      } else {
        warnings.push(`${network} is not a network this worker can read.`)
      }
    } catch (error) {
      warnings.push(
        `${network} balance read failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    }
  }

  return ok(
    { addresses, entries, unsupported },
    unsupported.length > 0
      ? [
        'Base balances need the ERPC SDK to gain a Base namespace (W1). ERPC credit top-up does NOT need it: paying an x402 402 is a signature plus HTTPS, and the facilitator submits the transaction.',
      ]
      : ['Call x402_inspect on a paid URL to see what a payment would cost.'],
    warnings,
  )
}

/** Solana getBalance answers either a bare number or `{ value }`. */
function extractLamports(response: unknown): string {
  if (typeof response === 'number' || typeof response === 'bigint') {
    return String(response)
  }
  if (response && typeof response === 'object' && 'value' in response) {
    return String((response as { value: unknown }).value)
  }
  return '0'
}
