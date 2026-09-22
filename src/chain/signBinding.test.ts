import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import { mnemonicToAccount } from 'viem/accounts'
import {
  assertSignedMatchesTarget,
  signPayment,
  type SignTarget,
} from './x402Client.ts'

// ---------------------------------------------------------------------------
// The defect this file exists for (gilgamesh, #14018 B1):
//
// Every check x402_pay makes -- per-payment ceiling, daily ceiling, treasury
// fence, EURC-only for top-ups, the ledger row -- is computed from the
// requirement `selectRequirement` picked. `new x402Client()` with no argument
// installs the SDK default selector, `(version, accepts) => accepts[0]`. So a
// resource could list a large payment to an attacker FIRST and the reviewed
// one second: every policy check passes on the second, the ledger records the
// second, and the signature is for the first.
//
// It was reproduced by execution, so it is guarded by execution. A source
// test asserting "we pass a selector" would go green against a selector that
// returns the wrong element.
// ---------------------------------------------------------------------------

const MNEMONIC =
  'test test test test test test test test test test test junk'
const account = mnemonicToAccount(MNEMONIC)

const ATTACKER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const TREASURY = '0x490842c32b83653dfd06eeeb53b9dbbf5d87f597'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const EURC = '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42'
const NETWORK = 'eip155:8453'

/**
 * A 402 whose FIRST requirement is the hostile one.
 *
 * Built as a real v2 `PAYMENT-REQUIRED` header with the SDK's own encoder,
 * because that is where the rail actually puts requirements. Measured in
 * @x402/core 2.13.0: `getPaymentRequiredResponse` reads that header first and
 * only falls back to a body whose `x402Version === 1` -- and the v1 path
 * resolves networks by NAME ("base"), while this rail and this worker speak
 * CAIP-2 ("eip155:8453"). The reference client passes the live response
 * headers for exactly this reason; a hand-written v1 body would be a fixture
 * of a shape nothing sends.
 */
const REQUIREMENTS = [
  {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amount: '49000000',
    payTo: ATTACKER,
    maxTimeoutSeconds: 600,
    extra: { name: 'USD Coin', version: '2' },
  },
  {
    scheme: 'exact',
    network: NETWORK,
    asset: EURC,
    amount: '10000',
    payTo: TREASURY,
    maxTimeoutSeconds: 600,
    extra: { name: 'EURC', version: '2' },
  },
]

function divergentChallenge() {
  const header = encodePaymentRequiredHeader({
    x402Version: 2,
    accepts: REQUIREMENTS,
  } as never)
  const headers = new Headers()
  headers.set('PAYMENT-REQUIRED', header)
  // The body carries the same list, which is what normalizeAccepts and the
  // policy fences read -- mirroring the rail and the reference client.
  return { headers, body: { x402Version: 2, accepts: REQUIREMENTS } }
}

/** The requirement a policy-checked worker would have chosen: the second. */
const CHOSEN: SignTarget = {
  scheme: 'exact',
  network: NETWORK,
  asset: EURC,
  amountAtomic: '10000',
  payTo: TREASURY,
}

test('the signature is for the requirement we chose, not the first one offered', async () => {
  const signed = await signPayment(account, divergentChallenge(), CHOSEN)

  // The whole finding in two assertions.
  assert.equal(signed.to?.toLowerCase(), TREASURY, 'signed payee is the treasury')
  assert.equal(signed.value, '10000', 'signed amount is the chosen amount')

  // And explicitly NOT the hostile first entry.
  assert.notEqual(signed.to?.toLowerCase(), ATTACKER)
  assert.notEqual(signed.value, '49000000')
})

test('a chosen requirement absent from the challenge refuses rather than falling back', async () => {
  // Fail closed. The failure mode being guarded is a selector that cannot find
  // its target and returns `accepts[0]` "to make progress".
  const absent: SignTarget = { ...CHOSEN, amountAtomic: '999999' }
  await assert.rejects(
    () => signPayment(account, divergentChallenge(), absent),
    (error: Error) => {
      assert.match(error.message, /not among the 2 requirement\(s\)/)
      assert.match(error.message, /nothing was signed/)
      return true
    },
  )
})

test('control: signing the FIRST requirement is what a correct binding must prevent', async () => {
  // Negative control for the two tests above. If this one could not sign the
  // hostile entry at all -- because the fixture is malformed, or the scheme is
  // unregistered -- then the assertions above would pass for the wrong reason.
  // Here the hostile entry IS the chosen one, so it must sign cleanly.
  const hostileChosen: SignTarget = {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amountAtomic: '49000000',
    payTo: ATTACKER,
  }
  const signed = await signPayment(account, divergentChallenge(), hostileChosen)
  assert.equal(signed.to?.toLowerCase(), ATTACKER)
  assert.equal(signed.value, '49000000')
})

// ---------------------------------------------------------------------------
// Barrier 2, measured WITHOUT barrier 1.
//
// The three tests above all pass because the selector works. Delete barrier 2
// entirely and they stay green -- so the suite proved barrier 1, not two
// independent barriers. Barrier 2 exists because barrier 1 depends on SDK
// behaviour this worker does not own, and a defence whose only evidence is
// the other defence working has not been verified (gilgamesh N6, #14018).
//
// These drive it directly with payloads a broken barrier 1 would produce.
// ---------------------------------------------------------------------------

/** A payload shaped the way @x402/core 2.13.0 actually returns one. */
function payloadFor(requirement: Record<string, unknown>) {
  return {
    x402Version: 2,
    accepted: requirement,
    payload: {
      authorization: {
        from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        to: String(requirement.payTo),
        value: String(requirement.amount),
      },
    },
  }
}

test('barrier 2 alone rejects a payload for a different requirement', () => {
  assert.throws(
    () => assertSignedMatchesTarget(payloadFor(REQUIREMENTS[0]), CHOSEN),
    /accepted a different requirement/,
  )
  // Control: the matching payload passes, so the rejection above is about the
  // divergence and not about the fixture being unusable.
  assert.doesNotThrow(() => assertSignedMatchesTarget(payloadFor(REQUIREMENTS[1]), CHOSEN))
})

test('barrier 2 alone catches an asset swap that payee and amount cannot see', () => {
  // 🔴 The case the two-field version could not see: same payee, same amount,
  // different token contract. This is why barrier 2 reads `accepted` and not
  // only the EIP-3009 authorization.
  const sameMoneyDifferentToken = {
    ...REQUIREMENTS[1],
    asset: USDC,
  }
  const payload = payloadFor(sameMoneyDifferentToken)
  assert.equal(payload.payload.authorization.to, CHOSEN.payTo)
  assert.equal(payload.payload.authorization.value, CHOSEN.amountAtomic)
  assert.throws(() => assertSignedMatchesTarget(payload, CHOSEN), /accepted a different requirement/)
})

test('barrier 2 alone rejects a payload with no accepted record at all', () => {
  // Fail closed: a payload shape that does not carry the field must not be
  // read as "nothing to compare, therefore fine".
  assert.throws(
    () => assertSignedMatchesTarget({ payload: { authorization: {} } }, CHOSEN),
    /accepted a different requirement/,
  )
  assert.throws(() => assertSignedMatchesTarget(undefined, CHOSEN), /accepted a different requirement/)
})

test('barrier 2 alone rejects an authorization that disagrees with its own accepted record', () => {
  // The signer could record the right requirement and sign a different
  // transfer. `accepted` and the authorization are separate objects, so both
  // are checked.
  const payload = payloadFor(REQUIREMENTS[1])
  payload.payload.authorization.value = '49000000'
  assert.throws(() => assertSignedMatchesTarget(payload, CHOSEN), /signed amount 49000000/)
})
