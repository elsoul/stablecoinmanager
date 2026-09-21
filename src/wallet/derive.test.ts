import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveAddresses,
  deriveEvmAccount,
  deriveSolanaKeys,
  EVM_PATH,
  InvalidMnemonicError,
  SOLANA_PATH,
  WalletNotInitializedError,
} from './keys.ts'

// ---------------------------------------------------------------------------
// Golden derivation vectors.
//
// The Solana addresses are the SAME ones pinned by the proven implementation
// this module's slip10.ts was copied from
// (`wallet/packages/core/src/keyring/solana.test.ts`), which captured them from
// the trusted `ed25519-hd-key` implementation before that dependency was
// dropped. Reproducing them here is what proves the copy + the ed25519 public
// key step + the base58 encoding compose back into the original behavior.
//
// The EVM addresses are the two canonical public BIP-44 vectors: the Hardhat
// default account #0 and the abandon-x11-about account #0. They pin
// m/44'/60'/0'/0/0 against a value anyone can reproduce with MetaMask.
// ---------------------------------------------------------------------------
const ALL_ZERO =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TREZOR_2 =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const HARDHAT = 'test test test test test test test test test test test junk'

test('derivation paths are the wallet-compatible ones', () => {
  assert.equal(SOLANA_PATH(0), "m/44'/501'/0'/0'")
  assert.equal(SOLANA_PATH(1), "m/44'/501'/1'/0'")
  assert.equal(EVM_PATH, "m/44'/60'/0'/0/0")
})

test('solana: all-zero vector index 0 matches the trusted golden address', () => {
  assert.equal(
    deriveSolanaKeys(ALL_ZERO, 0).address,
    'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
  )
})

test('solana: all-zero vector index 1 pins the path segment (off-by-one guard)', () => {
  const a0 = deriveSolanaKeys(ALL_ZERO, 0).address
  const a1 = deriveSolanaKeys(ALL_ZERO, 1).address
  assert.notEqual(a0, a1)
  assert.equal(a1, 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb')
})

test('solana: a second mnemonic pins the address (not just the all-zero seed)', () => {
  assert.equal(
    deriveSolanaKeys(TREZOR_2, 0).address,
    'BLeUXTx9thHGT7VJUtF9vHEmfMDgW1nnKZ9UVer2CoLX',
  )
})

test('solana: key material has the expected shape', () => {
  const keys = deriveSolanaKeys(ALL_ZERO, 0)
  assert.equal(keys.seed.length, 32)
  assert.equal(keys.publicKey.length, 32)
  assert.match(keys.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
})

test('evm: hardhat account #0 matches the canonical public vector', () => {
  assert.equal(
    deriveEvmAccount(HARDHAT).address,
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  )
})

test('evm: all-zero vector account #0 matches the canonical public vector', () => {
  assert.equal(
    deriveEvmAccount(ALL_ZERO).address,
    '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  )
})

test('one mnemonic yields both wallets and derivation is deterministic', () => {
  const a = deriveAddresses(ALL_ZERO)
  const b = deriveAddresses(ALL_ZERO)
  assert.deepEqual(a, b)
  assert.equal(a.solana, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
  assert.equal(a.evm, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
})

test('an unset mnemonic is a distinct, actionable error', () => {
  assert.throws(() => deriveAddresses(''), WalletNotInitializedError)
  assert.throws(() => deriveAddresses('   '), WalletNotInitializedError)
})

test('an invalid mnemonic is rejected without echoing the phrase', () => {
  const bogus = 'zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz'
  assert.throws(
    () => deriveAddresses(bogus),
    (error: unknown) => {
      assert.ok(error instanceof InvalidMnemonicError)
      assert.ok(!error.message.includes('zzzz'))
      return true
    },
  )
  // A valid-wordlist phrase with a bad checksum must be rejected too.
  assert.throws(
    () =>
      deriveAddresses(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
      ),
    InvalidMnemonicError,
  )
})

test('surrounding whitespace does not change the derived wallet', () => {
  assert.equal(
    deriveSolanaKeys(`  ${ALL_ZERO}  `, 0).address,
    deriveSolanaKeys(ALL_ZERO, 0).address,
  )
})
