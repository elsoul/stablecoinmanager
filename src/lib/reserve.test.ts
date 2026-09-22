import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reserveDecision } from './reserve.ts'
import { atomicToDecimal } from './x402.ts'

// ---------------------------------------------------------------------------
// This is the decision that stands between a tool call and a signature.
// Everything here is about the two ways it can lose money: paying twice for
// one request, and letting two requests both pass a ceiling only one fits
// under.
// ---------------------------------------------------------------------------

const base = { existing: undefined, spentTodayEurc: 0, amountEurc: 1.21, dailyCeilingEurc: 200 }

test('a fresh key under the ceiling reserves', () => {
  assert.deepEqual(reserveDecision(base), { kind: 'reserve' })
})

test('a used key REPLAYS and never reserves again', () => {
  // The whole point of the idempotency key: a retried tool call must return
  // the first receipt, not sign a second payment.
  const row = { idempotency_key: 'k', status: 'settled', tx_hash: '0xabc' }
  const out = reserveDecision({ ...base, existing: row })
  assert.equal(out.kind, 'replay')
  assert.deepEqual(out.kind === 'replay' && out.row, row)
})

test('replay beats the ceiling', () => {
  // A caller retrying after a timeout must get its receipt even if the daily
  // ceiling has since been reached. Refusing would make an already-paid call
  // look unpaid, and the obvious next move — pay again — is the wrong one.
  const out = reserveDecision({
    ...base,
    existing: { idempotency_key: 'k', status: 'settled' },
    spentTodayEurc: 1000,
    dailyCeilingEurc: 200,
  })
  assert.equal(out.kind, 'replay')
})

test('replay beats a nonsense amount too', () => {
  const out = reserveDecision({
    ...base,
    existing: { idempotency_key: 'k' },
    amountEurc: Number.NaN,
  })
  assert.equal(out.kind, 'replay')
})

test('the daily ceiling counts what is already pending, not only settled', () => {
  assert.deepEqual(
    reserveDecision({ ...base, spentTodayEurc: 198.79, amountEurc: 1.21 }),
    { kind: 'reserve' },
    'exactly at the ceiling is allowed',
  )
  const over = reserveDecision({ ...base, spentTodayEurc: 198.8, amountEurc: 1.21 })
  assert.equal(over.kind, 'over_daily_ceiling')
})

test('an unreadable daily total fails CLOSED', () => {
  // If the ledger total cannot be read as a number, the safe answer is "you
  // have spent everything", not "you have spent nothing".
  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = reserveDecision({ ...base, spentTodayEurc: broken })
    assert.equal(out.kind, 'over_daily_ceiling', String(broken))
  }
})

test('an unreadable ceiling fails CLOSED', () => {
  const out = reserveDecision({ ...base, dailyCeilingEurc: Number.NaN })
  assert.equal(out.kind, 'over_daily_ceiling')
  assert.equal(out.kind === 'over_daily_ceiling' && out.limitEurc, 0)
})

test('a non-finite or non-positive amount is refused, not compared past', () => {
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const out = reserveDecision({ ...base, amountEurc: amount })
    assert.equal(out.kind, 'amount_not_finite', String(amount))
  }
})

test('the refusal names the numbers the caller needs', () => {
  const out = reserveDecision({ ...base, spentTodayEurc: 199.5, amountEurc: 2 })
  assert.equal(out.kind, 'over_daily_ceiling')
  if (out.kind !== 'over_daily_ceiling') return
  assert.equal(out.spentTodayEurc, 199.5)
  assert.equal(out.limitEurc, 200)
  assert.equal(out.requestedEurc, 2)
})

// ---------------------------------------------------------------------------
// The join, not the halves.
//
// `atomicToDecimal` returning '0' for a malformed amount is tested, and
// `reserveDecision` refusing a non-positive amount is tested. What is NOT
// implied by either is that the two compose into a refusal: a quote whose
// `amount` is junk must not become a 0 EURC payment that sails under every
// ceiling and gets signed. That composition is what x402_pay actually does, so
// it is driven here with the real functions rather than assumed.
// ---------------------------------------------------------------------------

test('a malformed quoted amount is refused, not read as zero', () => {
  for (const atomic of ['not-a-number', '', '1.5', '-1', '0x10', ' 100']) {
    const amountEurc = Number(atomicToDecimal(atomic, 6))
    const decision = reserveDecision({
      existing: undefined,
      spentTodayEurc: 0,
      amountEurc,
      dailyCeilingEurc: 200,
    })
    assert.equal(
      decision.kind,
      'amount_not_finite',
      `${JSON.stringify(atomic)} produced ${amountEurc} and was not refused`,
    )
  }
})

test('control: a well-formed amount from the same path IS reserved', () => {
  // Without this the test above would also pass if reserveDecision refused
  // everything, which is the shape a fail-closed check fails in.
  const amountEurc = Number(atomicToDecimal('1210000', 6))
  assert.equal(amountEurc, 1.21)
  assert.equal(
    reserveDecision({
      existing: undefined,
      spentTodayEurc: 0,
      amountEurc,
      dailyCeilingEurc: 200,
    }).kind,
    'reserve',
  )
})
