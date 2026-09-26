/**
 * SLIP-0010 ed25519 derivation for the Solana key. `derive.test.ts` pins
 * golden addresses, so any change here that alters a derived address reddens.
 */
/**
 * SLIP-0010 ed25519 hierarchical key derivation, backed by `@noble/hashes`.
 *
 * This is the MV3/CSP-safe, platform-agnostic replacement for `ed25519-hd-key`.
 * `ed25519-hd-key` derives the same SLIP-0010 master/child keys but pulls the
 * legacy `create-hmac → cipher-base → readable-stream` (`crypto-browserify`)
 * chain, which assumes Node: it references the `process` global at import time
 * and its `cipher-base` constructor calls `StreamClass.call(this)` where the
 * `readable-stream` class is `undefined` in an MV3 service worker — throwing at
 * import/run time and taking the whole wallet down. It also drags a dead
 * `function-bind` `Function(string)` codegen that trips the CSP eval grep.
 *
 * The only cryptographic primitive here is HMAC-SHA512 from the audited
 * `@noble/hashes` (which `@elwallet/core` already depends on). SLIP-0010 ed25519
 * is a deterministic, fully-specified, hardened-only HMAC chain: master key from
 * the `'ed25519 seed'` HMAC, each child from `HMAC(chainCode, 0x00 || key ||
 * indexBE)`. This derivation is pinned byte-for-byte against `ed25519-hd-key` by
 * the golden vectors in `solana.test.ts`.
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha512.js'

const ED25519_CURVE = new TextEncoder().encode('ed25519 seed')
const HARDENED_OFFSET = 0x80000000

export type Slip10Node = { key: Uint8Array; chainCode: Uint8Array }

function masterKey(seed: Uint8Array): Slip10Node {
  const I = hmac(sha512, ED25519_CURVE, seed)
  return { key: I.slice(0, 32), chainCode: I.slice(32) }
}

function ckdPriv(parent: Slip10Node, index: number): Slip10Node {
  // data = 0x00 || parent.key (32) || index (uint32, big-endian)
  const data = new Uint8Array(1 + parent.key.length + 4)
  data[0] = 0
  data.set(parent.key, 1)
  new DataView(data.buffer).setUint32(1 + parent.key.length, index >>> 0, false)
  const I = hmac(sha512, parent.chainCode, data)
  return { key: I.slice(0, 32), chainCode: I.slice(32) }
}

/**
 * SLIP-0010 ed25519 derivation. ed25519 is hardened-only, so EVERY path segment
 * gets `+ HARDENED_OFFSET` regardless of the `'` notation. `seed` is the raw
 * BIP-39 seed bytes (64 bytes). Mirrors `ed25519-hd-key`'s `derivePath`
 * byte-for-byte (it operated on the hex form of the same bytes).
 */
export function deriveSlip10Ed25519(path: string, seed: Uint8Array): Slip10Node {
  const segments = path
    .split('/')
    .slice(1)
    .map((el) => parseInt(el.replace("'", ''), 10))
  return segments.reduce<Slip10Node>(
    (node, segment) => ckdPriv(node, segment + HARDENED_OFFSET),
    masterKey(seed),
  )
}
