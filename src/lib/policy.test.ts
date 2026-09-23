import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkPayment,
  describeViolation,
  ERPC_TREASURY_BASE,
  loadPolicy,
  type EffectivePolicyValue,
  type Policy,
  PolicyConfigError,
} from './policy.ts'
import type { Env } from '@/types/env'
import { networkAllowlist } from './networks.ts'

/**
 * Test-only mint for the effective-policy brand.
 *
 * Production has exactly ONE mint (`applyOverrides`), which is what makes a
 * deploy-time ceiling reaching `checkPayment` a compile error. These unit
 * tests drive `checkPayment` directly on hand-written policies, so they have
 * to say so out loud rather than have the barrier quietly not apply.
 */
const asEffective = (p: Policy): EffectivePolicyValue => p as EffectivePolicyValue

const POLICY: Policy = {
  allowedPayTo: ERPC_TREASURY_BASE,
  maxEurcPerPayment: 50,
  maxEurcPerDay: 200,
  allowedNetworks: networkAllowlist(['eip155:8453', 'solana-mainnet']),
  allowedAssets: ['EURC', 'USDC'],
  allowAnyPayTo: false,
  maxSlippageBps: 50,
  maxDeadlineSeconds: 600,
}

const topup = {
  amountEurcEquivalent: '1.21',
  network: 'eip155:8453',
  asset: 'EURC',
  payTo: ERPC_TREASURY_BASE,
}

test('the canary payment passes every ceiling', () => {
  assert.deepEqual(checkPayment(asEffective(POLICY), topup, 0), [])
})

test('an absent var uses the documented default', () => {
  const policy = loadPolicy({} as Env)
  assert.equal(policy.maxEurcPerPayment, 50)
  assert.equal(policy.maxEurcPerDay, 200)
  assert.deepEqual(policy.allowedNetworks.toJSON(), ['eip155:8453', 'solana-mainnet'])
  assert.deepEqual(policy.allowedAssets, ['EURC', 'USDC'])
  assert.equal(policy.maxSlippageBps, 50)
  assert.equal(policy.maxDeadlineSeconds, 600)
})

test('a present but usable var is read', () => {
  const policy = loadPolicy({
    POLICY_MAX_EURC_PER_PAYMENT: '10',
    POLICY_ALLOWED_NETWORKS: ' eip155:8453 ',
  } as unknown as Env)
  assert.equal(policy.maxEurcPerPayment, 10)
  assert.deepEqual(policy.allowedNetworks.toJSON(), ['eip155:8453'])
})

test('a present but UNUSABLE var throws instead of falling back to the wider default', () => {
  // The failure that matters: the fallback is always the wider value, so a
  // typo ("5O" for "50") silently restoring the default ceiling is the one
  // direction this must not fail in.
  const cases: Array<[string, string]> = [
    ['POLICY_MAX_EURC_PER_DAY', 'not-a-number'],
    ['POLICY_MAX_EURC_PER_DAY', ''],
    ['POLICY_MAX_EURC_PER_PAYMENT', '5O'],
    ['POLICY_MAX_EURC_PER_PAYMENT', '0'],
    ['POLICY_MAX_SLIPPAGE_BPS', '-5'],
    ['POLICY_MAX_DEADLINE_SECONDS', '0'],
    ['POLICY_ALLOWED_NETWORKS', ''],
    ['POLICY_ALLOWED_ASSETS', ' , '],
  ]
  for (const [name, value] of cases) {
    assert.throws(
      () => loadPolicy({ [name]: value } as unknown as Env),
      PolicyConfigError,
      `${name}=${JSON.stringify(value)} must refuse, not widen`,
    )
  }
})

test('POLICY_ALLOW_ANY_PAYTO only opens on the exact string "true"', () => {
  // Nothing else set: an empty list var now throws, so the base must be bare.
  const base = {} as unknown as Env
  for (const value of ['false', 'TRUE', '1', 'yes', '', undefined]) {
    const policy = loadPolicy({ ...base, POLICY_ALLOW_ANY_PAYTO: value } as Env)
    assert.equal(policy.allowAnyPayTo, false, `${String(value)} must not open payTo`)
  }
  assert.equal(
    loadPolicy({ ...base, POLICY_ALLOW_ANY_PAYTO: 'true' } as Env).allowAnyPayTo,
    true,
  )
})

test('a payment over the per-payment ceiling is refused, not clamped', () => {
  const violations = checkPayment(
    asEffective(POLICY),
    { ...topup, amountEurcEquivalent: '50.01' },
    0,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'amount_over_per_payment')
  assert.match(describeViolation(violations[0]), /per-payment ceiling of 50/)
})

test('the daily ceiling counts what was already spent today', () => {
  assert.deepEqual(checkPayment(asEffective(POLICY), { ...topup, amountEurcEquivalent: '40' }, 160), [])
  const violations = checkPayment(
    asEffective(POLICY),
    { ...topup, amountEurcEquivalent: '40' },
    170,
  )
  assert.equal(violations[0].kind, 'amount_over_daily')
})

test('a non-numeric amount is refused instead of comparing its way through', () => {
  // NaN > limit is false, so a missing guard here lets any junk amount pass.
  for (const amount of ['NaN', '', 'abc', '-1', '0', 'Infinity']) {
    const violations = checkPayment(
      asEffective(POLICY),
      { ...topup, amountEurcEquivalent: amount },
      0,
    )
    assert.ok(
      violations.some((v) => v.kind === 'amount_not_finite' || v.kind === 'amount_over_per_payment'),
      `${amount} must be refused`,
    )
  }
})

test('an unlisted network or asset is refused', () => {
  assert.equal(
    checkPayment(asEffective(POLICY), { ...topup, network: 'eip155:1' }, 0)[0].kind,
    'network_not_allowed',
  )
  assert.equal(
    checkPayment(asEffective(POLICY), { ...topup, asset: 'DAI' }, 0)[0].kind,
    'asset_not_allowed',
  )
})

test('an asset matches case-insensitively but a payee must match exactly', () => {
  assert.deepEqual(checkPayment(asEffective(POLICY), { ...topup, asset: 'eurc' }, 0), [])
  const violations = checkPayment(
    asEffective(POLICY),
    { ...topup, payTo: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    0,
  )
  assert.equal(violations[0].kind, 'payto_not_allowed')
})

test('a payee outside the treasury is allowed only when the policy is opened', () => {
  const opened = { ...POLICY, allowAnyPayTo: true }
  assert.deepEqual(
    checkPayment(asEffective(opened), { ...topup, payTo: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, 0),
    [],
  )
})

test('a non-finite slippage or deadline is refused, not compared past', () => {
  // Same shape as the amount guard: NaN > limit is false, and these values
  // arrive from tool arguments, so "not a number" is a shape a caller sends.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(
      checkPayment(asEffective(POLICY), { ...topup, slippageBps: bad }, 0)[0]?.kind,
      'slippage_not_finite',
      `slippageBps ${String(bad)}`,
    )
    assert.equal(
      checkPayment(asEffective(POLICY), { ...topup, deadlineSeconds: bad }, 0)[0]?.kind,
      'deadline_not_finite',
      `deadlineSeconds ${String(bad)}`,
    )
  }
})

test('slippage and deadline ceilings are enforced when supplied', () => {
  assert.deepEqual(checkPayment(asEffective(POLICY), { ...topup, slippageBps: 50, deadlineSeconds: 600 }, 0), [])
  assert.equal(
    checkPayment(asEffective(POLICY), { ...topup, slippageBps: 51 }, 0)[0].kind,
    'slippage_over_limit',
  )
  assert.equal(
    checkPayment(asEffective(POLICY), { ...topup, deadlineSeconds: 601 }, 0)[0].kind,
    'deadline_over_limit',
  )
})

test('every violation kind renders a message naming the limit it broke', () => {
  const all = checkPayment(
    asEffective(POLICY),
    {
      amountEurcEquivalent: '999',
      network: 'eip155:1',
      asset: 'DAI',
      payTo: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      slippageBps: 5000,
      deadlineSeconds: 99999,
    },
    195,
  )
  // 7, not 6: 999 EURC breaks the per-payment ceiling AND the daily one.
  assert.equal(all.length, 7)
  assert.deepEqual(
    all.map((v) => v.kind).sort(),
    [
      'amount_over_daily',
      'amount_over_per_payment',
      'asset_not_allowed',
      'deadline_over_limit',
      'network_not_allowed',
      'payto_not_allowed',
      'slippage_over_limit',
    ],
  )
  for (const violation of all) {
    const text = describeViolation(violation)
    assert.ok(text.length > 0)
    assert.ok(!text.includes('undefined'), text)
  }
})
