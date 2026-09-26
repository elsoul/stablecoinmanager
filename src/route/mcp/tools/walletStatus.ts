import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import type { Env } from '@/types/env'
import { deriveAddresses, WalletNotInitializedError } from '@/wallet/keys'
import {
  createGateway,
  ErpcApiKeyMissingError,
  probeReachability,
  type Reachability,
} from '@/chain/gateway'
import { effectivePolicy } from '../policyFor'
import { fail, ok, type ToolResult } from '../result'

export async function walletStatus(env: Env): Promise<ToolResult> {
  // EFFECTIVE: the policy this reports is the one payments are checked
  // against, not the deploy-time ceiling.
  const { effective: policy } = await effectivePolicy(env)

  let addresses: { solana: string; evm: string } | null = null
  try {
    addresses = deriveAddresses(env.WALLET_MNEMONIC ?? '')
  } catch (error) {
    if (error instanceof WalletNotInitializedError) {
      return fail(
        { state: 'not_initialized', policy },
        [
          'Run `pnpm wallet:init` to generate a wallet and store it as the WALLET_MNEMONIC secret.',
          'Until then every money tool refuses.',
        ],
        ['No wallet is configured on this deployment.'],
      )
    }
    return fail({ state: 'invalid_mnemonic', policy }, [
      'The WALLET_MNEMONIC secret is not a valid BIP-39 phrase. Re-run wallet:init or restore the correct phrase.',
    ])
  }

  let reachability: Reachability[]
  let warnings: string[] = []
  try {
    reachability = await probeReachability(createGateway(env))
  } catch (error) {
    reachability = []
    warnings = [
      error instanceof ErpcApiKeyMissingError
        ? 'ERPC_API_KEY is not set, so no chain is reachable.'
        : 'Chain reachability could not be probed.',
    ]
  }

  const unreachable = reachability.filter((entry) => !entry.ok)

  return ok(
    {
      state: 'ready',
      addresses: {
        solana: addresses.solana,
        // One EVM key, three chains. Displaying it once per chain is what the
        // "three wallets" in the product description actually means.
        evm: addresses.evm,
        evmNetworks: ['eip155:1', BASE_MAINNET_CAIP2_NETWORK, 'eip155:43114'],
      },
      reachability,
      policy,
    },
    unreachable.length > 0
      ? [`Call holdings to see which balances are readable; ${unreachable.length} namespace(s) did not answer.`]
      : ['Call holdings to see balances, or x402_inspect on a paid URL.'],
    warnings,
  )
}
