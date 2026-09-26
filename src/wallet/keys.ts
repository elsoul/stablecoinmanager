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
    super('WALLET_MNEMONIC is not set; run `pnpm wallet:init`')
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

/**
 * 🔴 There is no private-key PROPERTY here, and that is the point.
 *
 * A raw hex key-material pattern in `utils/redact.ts` looks like the obvious
 * guard. Measuring first said not to add one:
 *
 *   - Nothing in this worker turns key material into hex. `getHdKey`,
 *     `privateKey`, `toHex` and `bytesToHex` appear zero times outside tests
 *     AS CODE -- a plain grep finds five, all of them inside comments like
 *     this one, which is why the barrier tests strip comments before
 *     scanning. So the pattern would have had no producer.
 *   - A 0x-prefixed 64-hex string IS a transaction hash, which x402_pay
 *     returns on the success path and names in its guidance. A shape rule
 *     cannot tell the two apart, so adding one would redact the field the
 *     caller needs while catching nothing that exists.
 *
 * The real gap was that `seed` was a readable property whose only production
 * reader was `.address` -- one careless spread away from a payload, with no
 * barrier and no test saying so. A property that must never be read is an
 * enumeration of places not to read it, and this package has already paid
 * four times for guards shaped like that (see lib/networks.ts). So the key is
 * captured in a closure: there is nothing to spread, nothing to log, and
 * nothing for a pattern to have to recognise.
 */
export type SolanaKeys = {
  address: string
  /** Public. Safe to emit, though nothing currently does. */
  publicKey: Uint8Array
  /** Sign with the derived ed25519 key. The key itself has no accessor. */
  sign(message: Uint8Array): Uint8Array
}

export function deriveSolanaKeys(mnemonic: string, accountIndex = 0): SolanaKeys {
  const { seed } = normalize(mnemonic)
  const { key } = deriveSlip10Ed25519(SOLANA_PATH(accountIndex), seed)
  const privateSeed = Uint8Array.from(key)
  const publicKey = ed25519.getPublicKey(privateSeed)
  return {
    address: base58.encode(publicKey),
    publicKey,
    sign: (message) => ed25519.sign(message, privateSeed),
  }
}

/**
 * The EVM signer, with the account held in a closure rather than on a field.
 *
 * 🔴 This is the side that actually signs, and it had the property-shaped
 * risk the Solana side above was just rewritten to remove. viem's `HDAccount`
 * carries `getHdKey` as an OWN ENUMERABLE key -- measured: it appears in
 * `Object.keys(account)` and survives `{...account}` -- and
 * `getHdKey().privateKey` is a public accessor for the private key. Nothing
 * leaks today only because `JSON.stringify` drops functions and because no
 * caller reaches for it, which is the same "nobody would do that" the seed
 * property was relying on.
 *
 * Closing one side and leaving the other open is worse than leaving both: an
 * asymmetry reads as "the open one must have had a reason", which is the
 * exact note taken elsewhere in this package about one barrier existing
 * without its twin.
 *
 * `withAccount` hands the account to a callback and never returns it, so
 * there is no property to spread, serialise or forget about. viem owns the
 * account's shape, so a closure is the only place we can put it.
 *
 * 🔴 What is still reachable, stated rather than implied: a callback can
 * return the account (`withAccount((a) => a)`) or stash it for later. JS
 * cannot stop a callback from keeping its argument, and neither a type nor a
 * runtime check catches the stash form. This barrier removes the ACCIDENTAL
 * paths -- spread, serialise, log, a payload that happened to include the
 * signer -- and nothing more. Saying so here because the sibling barriers in
 * `lib/networks.ts` list their escapes, and a missing list reads as an empty
 * one.
 */
export type EvmSigner = {
  address: `0x${string}`
  withAccount<T>(use: (account: HDAccount) => T): T
}

export function deriveEvmSigner(mnemonic: string): EvmSigner {
  const account = deriveEvmAccount(mnemonic)
  return {
    address: account.address,
    withAccount: (use) => use(account),
  }
}

/**
 * Module-private on purpose: exporting it hands out the raw `HDAccount`,
 * which is the thing `deriveEvmSigner` exists to stop being reachable.
 */
function deriveEvmAccount(mnemonic: string): HDAccount {
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
    evm: deriveEvmSigner(mnemonic).address,
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
