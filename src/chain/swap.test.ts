import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalGap, assertNoNativeValue, planSwap } from './swap.ts'

// ---------------------------------------------------------------------------
// The allowance comparison is the part most likely to be wrong in a way that
// costs money quietly: these are atomic-unit decimal strings, and comparing
// them as strings is both easy to write and wrong on the common amounts.
// ---------------------------------------------------------------------------

test('🔴 the allowance comparison is numeric, not lexicographic', () => {
  // '10' < '9' as strings. A string comparison here reports "allowance is
  // enough" when it is not, the swap reverts, and the gas is gone.
  assert.deepEqual(approvalGap('9', '10'), { needsApproval: true, shortfall: '1' })
  assert.deepEqual(approvalGap('10', '9'), { needsApproval: false, shortfall: '0' })

  // And at the scale these actually occur: 1e18 vs 9e17.
  assert.equal(approvalGap('900000000000000000', '1000000000000000000').needsApproval, true)
  assert.equal(approvalGap('1000000000000000000', '900000000000000000').needsApproval, false)
})

test('exact allowance needs no approval; one unit short does', () => {
  assert.equal(approvalGap('1000', '1000').needsApproval, false)
  assert.deepEqual(approvalGap('999', '1000'), { needsApproval: true, shortfall: '1' })
})

test('an unreadable allowance fails CLOSED', () => {
  // Assume an approval is needed. A wrong "no approval needed" costs a
  // reverted swap; a wrong "approval needed" costs one redundant approval.
  for (const junk of ['', 'abc', '1.5', '-1', 'NaN']) {
    assert.equal(approvalGap(junk, '1000').needsApproval, true, `${junk} must fail closed`)
    assert.equal(approvalGap('1000', junk).needsApproval, true, `${junk} required must fail closed`)
  }
})

test('a preparation that moves native value is refused', () => {
  // Measured on the SDK: `transaction.value` is the literal '0' and path
  // entries are erc20, so a non-zero value means something changed
  // underneath us. Refuse rather than sign it.
  const prep = (value: string) =>
    ({ transaction: { value } }) as unknown as Parameters<typeof assertNoNativeValue>[0]

  assert.doesNotThrow(() => assertNoNativeValue(prep('0')))
  assert.throws(() => assertNoNativeValue(prep('1')), /moves native value/)
  assert.throws(() => assertNoNativeValue(prep('1000000000000000000')), /moves native value/)
})

test('planSwap reports the approval gap without signing anything', async () => {
  // The tool must be able to tell a caller "this needs an approval first"
  // before any signature exists.
  let called = 0
  const simulation = {
    currentAllowance: '500',
    preparation: {
      allowance: { requiredAmount: '1000' },
      transaction: { value: '0' },
    },
  }
  const plan = await planSwap(
    {
      simulateExactInputSwap: async () => {
        called += 1
        return simulation as never
      },
    },
    {} as never,
  )
  assert.equal(called, 1, 'simulation is what produces the plan')
  assert.equal(plan.needsApproval, true)
  assert.equal(plan.approvalShortfall, '500')
  assert.equal(plan.preparation, simulation.preparation, 'the preparation is carried through')
})
