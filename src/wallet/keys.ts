/**
 * One mnemonic, two keys, three displayed wallets.
 *
 *   Solana  ed25519   m/44'/501'/0'/0'   (Phantom / Solflare compatible)
 *   EVM     secp256k1 m/44'/60'/0'/0/0   (MetaMask compatible; the SAME address
 *                                         is used on Ethereum, Base and
 *                                         Avalanche C-Chain)
 *
 * The mnemonic lives only in the `WALLET_MNEMONIC` wrangler secret. It is
 * re-derived per request, kept in local scope, and never logged, returned or
 * stored -- except by `wallet_export_seed`, which is an explicit, audited,
 * confirmation-gated read of the same secret.
 */
import { ed25519 } from '@noble/curves/ed25519'
import { base58 } from '@scure/base'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { mnemonicToAccount } from 'viem/accounts'
import type { HDAccount } from 'viem'
import { deriveSlip10Ed25519 } from './slip10'

export const SOLANA_PATH = (accountIndex = 0): string =>
  `m/44'/501'/${accountIndex}'/0'`
export const EVM_PATH = "m/44'/60'/0'/0/0"

export class WalletNotInitializedError extends Error {
  constructor() {
    super('WALLET_MNEMONIC is not set; run `pnpm -F mcp-stablecoin-manager wallet:init`')
    this.name = 'WalletNotInitializedError'
  }
}

export class InvalidMnemonicError extends Error {
  constructor() {
    // Deliberately says nothing about the value itself.
    super('WALLET_MNEMONIC is not a valid BIP-39 mnemonic')
    this.name = 'InvalidMnemonicError'
  }
}

export type SolanaKeys = {
  address: string
  /** 32-byte ed25519 private seed. Signing only -- never leaves the worker. */
  seed: Uint8Array
  publicKey: Uint8Array
}

export function deriveSolanaKeys(mnemonic: string, accountIndex = 0): SolanaKeys {
  const { seed } = normalize(mnemonic)
  const { key } = deriveSlip10Ed25519(SOLANA_PATH(accountIndex), seed)
  const privateSeed = Uint8Array.from(key)
  const publicKey = ed25519.getPublicKey(privateSeed)
  return { address: base58.encode(publicKey), seed: privateSeed, publicKey }
}

export function deriveEvmAccount(mnemonic: string): HDAccount {
  // viem validates the mnemonic itself, but we check first so the error message
  // is ours and carries no fragment of the phrase. viem is also handed the
  // normalized phrase, so the two derivations can never disagree about which
  // string they derived from.
  const { phrase } = normalize(mnemonic)
  return mnemonicToAccount(phrase, { path: EVM_PATH })
}

export function deriveAddresses(
  mnemonic: string,
): { solana: string; evm: `0x${string}` } {
  return {
    solana: deriveSolanaKeys(mnemonic).address,
    evm: deriveEvmAccount(mnemonic).address,
  }
}

/**
 * Single normalization point: both derivations consume exactly this phrase, so
 * a stray newline in the secret can never give the Solana and the EVM side two
 * different wallets.
 */
function normalize(mnemonic: string): { phrase: string; seed: Uint8Array } {
  const phrase = mnemonic.trim().replace(/\s+/g, ' ')
  if (!phrase) throw new WalletNotInitializedError()
  if (!validateMnemonic(phrase, wordlist)) throw new InvalidMnemonicError()
  return { phrase, seed: mnemonicToSeedSync(phrase) }
}
