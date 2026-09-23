import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519'
import {
  deriveAddresses,
  deriveEvmSigner,
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

/**
 * Source with comments removed.
 *
 * 🔴 A barrier that scans raw text matches its own explanation. All three
 * barriers below fired on the comment that describes them -- `x402Pay.ts`
 * says "getHdKey is an own enumerable key", which is the sentence warning
 * people off it. A guard that cannot tell code from prose reports the
 * warning as the violation, and the natural repair is to stop writing the
 * warning.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

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

test('solana: the derived key signs, and is not reachable as a value', () => {
  const keys = deriveSolanaKeys(ALL_ZERO, 0)
  assert.equal(keys.publicKey.length, 32)
  assert.match(keys.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

  // 🔴 This replaces `assert.equal(keys.seed.length, 32)`. That assertion
  // measured the shape of material that should not have been reachable at
  // all, and reading it in a test is the same move a careless payload makes.
  // Signing proves the key is correct without anyone holding it.
  const message = new TextEncoder().encode('stablecoin-manager derive test')
  const signature = keys.sign(message)
  assert.equal(signature.length, 64)
  assert.ok(
    ed25519.verify(signature, message, keys.publicKey),
    'the signature must verify against the derived public key',
  )
  assert.ok(
    !ed25519.verify(signature, new TextEncoder().encode('other'), keys.publicKey),
    'control: a different message must not verify',
  )

  // And the key has no accessor. JSON.stringify is what a payload does.
  const serialised = JSON.stringify(keys)
  assert.ok(!serialised.includes('seed'), `key material surfaced: ${serialised}`)
  assert.deepEqual(
    Object.keys(keys).filter((k) => k !== 'address' && k !== 'publicKey' && k !== 'sign'),
    [],
    'SolanaKeys must expose only address, publicKey and sign',
  )
})

test('BARRIER: no production file reads key material off the derivation', () => {
  // The closure is the barrier; this pins that nothing walked around it by
  // reintroducing an accessor. Scanning src rather than one directory,
  // because scoping a guard to the place the last defect was found is how
  // B-7 survived the B-5 fix in this same package.
  const root = join(import.meta.dirname, '..')
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      if (full.endsWith(join('wallet', 'keys.ts'))) continue // the derivation itself
      if (full.endsWith(join('wallet', 'slip10.ts'))) continue // the KDF it calls
      const source = readFileSync(full, 'utf8')
      if (/\b(getHdKey|privateKey|privateSeed|bytesToHex)\b/.test(code(source))) {
        offenders.push(full.slice(root.length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    offenders,
    [],
    `these name key material directly: ${offenders.join(', ')}`,
  )
})

test('evm: hardhat account #0 matches the canonical public vector', () => {
  assert.equal(
    deriveEvmSigner(HARDHAT).address,
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  )
})

test('evm: all-zero vector account #0 matches the canonical public vector', () => {
  assert.equal(
    deriveEvmSigner(ALL_ZERO).address,
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

test('evm: the account is reachable only inside withAccount', () => {
  // 🔴 gilgamesh P1. viem's HDAccount carries `getHdKey` as an OWN ENUMERABLE
  // key -- measured -- and `getHdKey().privateKey` is a public accessor for
  // the private key. Nothing leaked because JSON.stringify drops functions
  // and nobody called it, which is the same "nobody would do that" the Solana
  // seed property was relying on. Closing one side and leaving the other open
  // is worse than leaving both: the asymmetry reads as a decision.
  const signer = deriveEvmSigner(HARDHAT)

  assert.deepEqual(Object.keys(signer).sort(), ['address', 'withAccount'])
  assert.deepEqual(Object.getOwnPropertyNames(signer).sort(), ['address', 'withAccount'])
  assert.equal(Object.getOwnPropertySymbols(signer).length, 0)

  const serialised = JSON.stringify(signer)
  assert.ok(!serialised.includes('getHdKey'), `account surfaced: ${serialised}`)
  assert.ok(!serialised.includes('privateKey'), `account surfaced: ${serialised}`)

  // Spreading is the move that actually happens in a payload, and it is what
  // carried getHdKey before.
  assert.deepEqual(Object.keys({ ...signer }).sort(), ['address', 'withAccount'])

  // And the account is still usable where it is needed -- the barrier must
  // not be "nothing works".
  const address = signer.withAccount((account) => account.address)
  assert.equal(address, signer.address)
  assert.equal(address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
})

test('BARRIER: the raw EVM account has no production reader', () => {
  // The closure only helps while nothing exports a way around it. `withAccount`
  // is the single door; this pins that no production file opens another.
  const root = join(import.meta.dirname, '..')
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      if (full.endsWith(join('wallet', 'keys.ts'))) continue // where it is derived
      const source = readFileSync(full, 'utf8')
      if (/\bderiveEvmAccount\b|\bgetHdKey\b/.test(code(source))) {
        offenders.push(full.slice(root.length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], `these reach past withAccount: ${offenders.join(', ')}`)
})

test('BARRIER: the Solana signer is still unreached from production', () => {
  // `sign()` exists so the derived key can be verified without anyone holding
  // it, and W4 (Solana swap) will need it. Until then it is a signing
  // capability with no caller, so its provenance condition is pinned here
  // rather than left in a docblock: gilgamesh P2/oracle note, #14067 --
  // whatever bytes it signs must be constructed by this worker, never passed
  // through from a tool argument. PR-2 already paid for a signer that signed
  // something other than what was checked.
  const root = join(import.meta.dirname, '..')
  const callers: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      if (full.endsWith(join('wallet', 'keys.ts'))) continue
      const body = code(readFileSync(full, 'utf8'))
      if (!/\bderiveSolanaKeys\s*\(/.test(body)) continue
      // A caller exists; the question is what it takes off the result.
      // `.address` is the only reader today. `utils/state.ts` HMAC-signs the
      // OAuth state and matched an earlier, broader `.sign(` rule -- a guard
      // wide enough to catch unrelated signing is a guard that gets relaxed.
      if (/deriveSolanaKeys\s*\([^)]*\)\s*\.\s*(?!address)/.test(body)) {
        callers.push(full.slice(root.length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    callers,
    [],
    'a caller appeared: confirm the signed bytes are worker-constructed, then update this test',
  )
})

test('the comment stripper: what it hides, measured rather than assumed', () => {
  // 🔴 gilgamesh R2-N2. `code()` solved barriers firing on their own warning
  // text and introduced the mirror failure: it can hide a real violation.
  // That is acceptable only while the limit is known, because `code()` is a
  // backstop behind a structural barrier -- `deriveEvmAccount` is
  // module-private -- and an unmeasured limit is how a backstop quietly
  // becomes the only guard.
  //
  // 🔴 The review named three shapes and one of them was wrong. Regex
  // literals were measured here and do NOT hide: a bare `//` cannot appear
  // in one, since it would close the literal. Template literals do, and they
  // were not on the list. Copying the three across without driving them
  // would have pinned a case that does not exist while leaving a real one
  // unnamed -- the same transcription slip this PR already corrected once in
  // the plan doc.
  assert.match(code('const u = "https://x"; getHdKey()'), /getHdKey/, 'a URL must not eat the line')
  assert.doesNotMatch(code('// getHdKey()'), /getHdKey/, 'a real comment is removed')

  // Measured VISIBLE (the stripper does not hide these):
  assert.match(code(String.raw`const re = /a\/\/b/; getHdKey()`), /getHdKey/, 'escaped slashes in a regex')
  assert.match(code('const re = /[/]/; getHdKey()'), /getHdKey/, 'a slash in a character class')
  assert.match(code('const x = a / b; // note\ngetHdKey()'), /getHdKey/, 'division before a comment')

  // Measured HIDDEN (the known limit, in full):
  assert.doesNotMatch(code('const s = "a // getHdKey()"'), /getHdKey/, 'bare // in a string literal')
  assert.doesNotMatch(code('const t = `a // getHdKey()`'), /getHdKey/, 'bare // in a template literal')
  assert.doesNotMatch(
    code('const s = "/*"; getHdKey(); const t = "*/"'),
    /getHdKey/,
    'a block comment opened inside a string literal',
  )
})
