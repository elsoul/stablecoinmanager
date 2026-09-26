import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import { getTokenDeployment, tokens } from '@elsoul/erpc-sdk'
import type { Env } from '@/types/env'
import { deriveAddresses } from '@/wallet/keys'
import { createGateway, EXPECTED_CHAIN_IDS, READABLE_NETWORKS, type ErpcClient } from '@/chain/gateway'
import { formatAtomic, ok, type ToolResult } from '../result'
import { canonicalNetwork, SOLANA_MAINNET_CAIP2 } from '@/lib/networks'

export interface HoldingEntry {
  network: string
  address: string
  asset: string
  atomic: string
  human: string
  currency: string
}

/**
 * Something this tool was asked to read and did not. Every such case lands
 * here or in `warnings` -- never silently dropped, because an agent reads a
 * missing entry as a zero balance.
 */
export interface UnsupportedEntry {
  ok: false
  network: string
  asset: string
  error: 'not_read' | 'catalog_missing' | 'unknown_network'
  detail: string
}

/** The stablecoins read on every EVM chain, looked up in the SDK catalogue. */
const EVM_STABLES = ['EURC', 'USDC'] as const

type EvmRpc = Pick<ErpcClient['ethereum']['rpc'], 'eth_chainId' | 'eth_getBalance' | 'eth_call'>

interface EvmChain {
  rpc: (erpc: ErpcClient) => EvmRpc
  nativeSymbol: string
  /** The SDK catalogue's per-chain map of symbol -> deploymentId. */
  catalog: Readonly<Record<string, string>>
}

/**
 * One EVM key, three chains. Addresses and decimals of every token come from
 * the SDK catalogue (`tokens.<chain>` -> `getTokenDeployment`), never from a
 * literal here, so a catalogue correction reaches this tool with the SDK.
 */
const EVM_CHAINS: Readonly<Record<string, EvmChain>> = {
  'eip155:1': { rpc: (e) => e.ethereum.rpc, nativeSymbol: 'ETH', catalog: tokens.ethereum },
  [BASE_MAINNET_CAIP2_NETWORK]: { rpc: (e) => e.base.rpc, nativeSymbol: 'ETH', catalog: tokens.base },
  'eip155:43114': { rpc: (e) => e.avalanche.rpc, nativeSymbol: 'AVAX', catalog: tokens.avalancheC },
}

/** `balanceOf(address)` selector. */
const BALANCE_OF = '0x70a08231'

export function balanceOfCalldata(owner: string): string {
  const hex = owner.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not an EVM address: ${owner}`)
  return `${BALANCE_OF}${hex.padStart(64, '0')}`
}

/**
 * An eth_getBalance QUANTITY as a decimal string. The spec spelling of zero is
 * `0x0`; a bare `0x` is not a quantity and throws, so it lands in `warnings`
 * rather than reading as a balance of zero.
 */
export function hexToAtomic(value: unknown): string {
  const raw = String(value)
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error(`unexpected RPC quantity: ${raw.slice(0, 80)}`)
  return BigInt(raw).toString()
}

/**
 * A `balanceOf` eth_call result as a decimal string. `balanceOf` returns one
 * ABI word (32 bytes), so anything else is not a balance. In particular an
 * empty `0x` is what a node answers for a call to an address with NO CONTRACT
 * CODE -- a wrong-chain route, a lagging node, a catalogue error -- and reading
 * that as 0 would be exactly the implicit zero this tool promises never to
 * report.
 */
export function wordToAtomic(value: unknown): string {
  const raw = String(value)
  if (raw === '0x') {
    throw new Error('eth_call returned no data (no contract code at the token address on this endpoint?)')
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`unexpected eth_call result: ${raw.slice(0, 80)}`)
  return BigInt(raw).toString()
}

export async function holdings(
  env: Env,
  args: { networks?: string[] } = {},
): Promise<ToolResult> {
  const addresses = deriveAddresses(env.WALLET_MNEMONIC ?? '')
  const erpc = createGateway(env)
  const { entries, unsupported, warnings } = await readHoldings(erpc, addresses, args.networks)
  return ok(
    { addresses, entries, unsupported },
    ['Call x402_inspect on a paid URL to see what a payment would cost.'],
    warnings,
  )
}

/**
 * The read itself, separated from key derivation so tests (and a live check
 * against a known funded address) drive the exact code the tool runs.
 */
export async function readHoldings(
  erpc: ErpcClient,
  addresses: { solana: string; evm: `0x${string}` },
  networks?: readonly string[],
): Promise<{ entries: HoldingEntry[]; unsupported: UnsupportedEntry[]; warnings: string[] }> {

  // 🔴 De-duplicated by CANONICAL id, keeping the first spelling the caller
  // used. `solana-mainnet` and `solana:5eykt4...` are one chain, so asking for
  // both used to return two entries for the same balance -- and a model that
  // adds up what it is handed would report double the holdings.
  const requested: string[] = []
  const seen = new Set<string>()
  for (const network of networks?.length ? networks : READABLE_NETWORKS) {
    const canonical = canonicalNetwork(network)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    requested.push(network)
  }

  const entries: HoldingEntry[] = []
  const warnings: string[] = []
  const unsupported: UnsupportedEntry[] = []

  const failure = (network: string, asset: string, error: unknown) => {
    warnings.push(
      `${network} ${asset} balance read failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  // Networks are independent reads; one slow chain must not serialise the rest.
  await Promise.all(requested.map(async (network) => {
    // Canonical for the dispatch, raw for what we echo back.
    const chain = canonicalNetwork(network)

    if (chain === SOLANA_MAINNET_CAIP2) {
      try {
        const lamports = await erpc.solana.rpc.getBalance(addresses.solana).send()
        const value = extractLamports(lamports)
        entries.push({
          network,
          address: addresses.solana,
          asset: 'SOL',
          atomic: value,
          human: formatAtomic(value, 9),
          currency: 'SOL',
        })
      } catch (error) {
        failure(network, 'SOL', error)
      }
      // Stated, not omitted: SPL token accounts are not read by this tool.
      unsupported.push({
        ok: false,
        network,
        asset: 'EURC, USDC (SPL)',
        error: 'not_read',
        detail: 'Solana SPL token balances are not read by holdings yet; only native SOL is reported.',
      })
      return
    }

    const evm = Object.hasOwn(EVM_CHAINS, chain) ? EVM_CHAINS[chain] : undefined
    if (!evm) {
      unsupported.push({
        ok: false,
        network,
        asset: '*',
        error: 'unknown_network',
        detail: `${network} is not a network this worker can read (readable: ${READABLE_NETWORKS.join(', ')}).`,
      })
      return
    }

    const rpc = evm.rpc(erpc)

    // Ask the endpoint which chain it is BEFORE trusting any balance from it.
    // `wallet_status` already refuses a namespace that answers the wrong chain
    // id; holdings must not be looser than the probe, or Ethereum's ETH would
    // be reported as Base ETH with no warning. One extra round trip per EVM
    // chain; every asset of a misrouted chain becomes a warning, so the number
    // of missing entries is explicit.
    const expected = EXPECTED_CHAIN_IDS[chain]
    try {
      const answered = String(await rpc.eth_chainId().send())
      if (expected && answered !== expected) {
        throw new Error(`endpoint answered chainId ${answered} (expected ${expected})`)
      }
    } catch (error) {
      for (const asset of [evm.nativeSymbol, ...EVM_STABLES]) failure(network, asset, error)
      return
    }

    const reads: Promise<void>[] = []

    reads.push((async () => {
      try {
        const value = hexToAtomic(await rpc.eth_getBalance(addresses.evm, 'latest').send())
        entries.push({
          network,
          address: addresses.evm,
          asset: evm.nativeSymbol,
          atomic: value,
          human: formatAtomic(value, 18),
          currency: evm.nativeSymbol,
        })
      } catch (error) {
        failure(network, evm.nativeSymbol, error)
      }
    })())

    for (const symbol of EVM_STABLES) {
      const deploymentId = Object.hasOwn(evm.catalog, symbol) ? evm.catalog[symbol] : undefined
      const deployment = deploymentId ? getTokenDeployment(deploymentId) : undefined
      if (!deployment || !deployment.address || deployment.chainId !== chain) {
        unsupported.push({
          ok: false,
          network,
          asset: symbol,
          error: 'catalog_missing',
          detail: `The @elsoul/erpc-sdk token catalogue has no usable ${symbol} deployment on ${chain}.`,
        })
        continue
      }
      const { address: token, decimals } = deployment
      reads.push((async () => {
        try {
          const value = wordToAtomic(
            await rpc
              .eth_call({ to: token, data: balanceOfCalldata(addresses.evm) }, 'latest')
              .send(),
          )
          entries.push({
            network,
            address: addresses.evm,
            asset: symbol,
            atomic: value,
            human: formatAtomic(value, decimals),
            currency: symbol,
          })
        } catch (error) {
          failure(network, symbol, error)
        }
      })())
    }
    await Promise.all(reads)
  }))

  // Stable output order regardless of which RPC answered first.
  const order = (network: string) => requested.indexOf(network)
  entries.sort((a, b) => order(a.network) - order(b.network) || a.asset.localeCompare(b.asset))
  unsupported.sort((a, b) => order(a.network) - order(b.network) || a.asset.localeCompare(b.asset))

  return { entries, unsupported, warnings }
}

/** Solana getBalance answers either a bare number or `{ value }`. */
function extractLamports(response: unknown): string {
  if (typeof response === 'number' || typeof response === 'bigint') {
    return String(response)
  }
  if (response && typeof response === 'object' && 'value' in response) {
    return String((response as { value: unknown }).value)
  }
  throw new Error('unexpected getBalance result shape')
}
