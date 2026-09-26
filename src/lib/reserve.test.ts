import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OVERRIDE_ROWS_SQL,
  refusalReasons,
  policyFromOverrideRows,
  refuseEverything,
  reserveDecision,
} from './reserve.ts'
import { atomicToDecimal } from './x402.ts'
import {
  ERPC_TREASURY_BASE,
  loadPolicy,
  type Policy,
  type PolicyViolation,
} from './policy.ts'
import { networkAllowlist } from './networks.ts'

// ---------------------------------------------------------------------------
// This is the decision that stands between a tool call and a signature.
// Everything here is about the two ways it can lose money: paying twice for
// one request, and letting two requests both pass a ceiling only one fits
// under.
// ---------------------------------------------------------------------------

/**
 * The deploy-time ceiling as the tests use it.
 *
 * 🔴 It is `loadPolicy({})`, i.e. the BUILT-IN DEFAULTS, and calling it "the
 * shipped ceiling" is only true because the shipped `[vars]` are identical to
 * them -- which the test named "the shipped [vars] are identical to the
 * built-in defaults" pins. If that test ever reddens, this fixture stops
 * standing in for the deployed config and the cases using it have to be
 * re-read.
 */
const CEILING: Policy = loadPolicy({} as never)

const INTENT = {
  amountEurcEquivalent: '1.21',
  network: 'eip155:8453',
  asset: 'EURC',
  payTo: ERPC_TREASURY_BASE,
}

/**
 * The daily ceiling now travels inside the policy, because the decision runs
 * `checkPayment` itself rather than being handed a single number. A helper
 * keeps the existing cases readable.
 */
const withDaily = (maxEurcPerDay: number): Policy => ({ ...CEILING, maxEurcPerDay })

const base = {
  existing: undefined,
  spentTodayEurc: 0,
  policy: policyFromOverrideRows(withDaily(200), []),
  intent: INTENT,
}

/** The amount now travels in the intent, so the cases set it there. */
const paying = (eurc: number | string) => ({
  ...INTENT,
  amountEurcEquivalent: String(eurc),
})

test('a fresh key under the ceiling reserves', () => {
  assert.deepEqual(reserveDecision(base), { kind: 'reserve', amountEurc: 1.21 })
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
    policy: policyFromOverrideRows(withDaily(200), []),
  })
  assert.equal(out.kind, 'replay')
})

test('replay beats a nonsense amount too', () => {
  const out = reserveDecision({
    ...base,
    existing: { idempotency_key: 'k' },
    intent: paying(Number.NaN),
  })
  assert.equal(out.kind, 'replay')
})

test('the daily ceiling counts what is already pending, not only settled', () => {
  assert.deepEqual(
    reserveDecision({ ...base, spentTodayEurc: 198.79, intent: paying(1.21) }),
    { kind: 'reserve', amountEurc: 1.21 },
    'exactly at the ceiling is allowed',
  )
  const over = reserveDecision({ ...base, spentTodayEurc: 198.8, intent: paying(1.21) })
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
  const out = reserveDecision({ ...base, policy: policyFromOverrideRows(withDaily(Number.NaN), []) })
  assert.equal(out.kind, 'over_daily_ceiling')
  assert.equal(out.kind === 'over_daily_ceiling' && out.limitEurc, 0)
})

test('a non-finite or non-positive amount is refused, not compared past', () => {
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const out = reserveDecision({ ...base, intent: paying(amount) })
    assert.equal(out.kind, 'amount_not_finite', String(amount))
  }
})

test('the refusal names the numbers the caller needs', () => {
  const out = reserveDecision({ ...base, spentTodayEurc: 199.5, intent: paying(2) })
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
      policy: policyFromOverrideRows(withDaily(200), []),
      intent: { ...INTENT, amountEurcEquivalent: String(amountEurc) },
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
      policy: policyFromOverrideRows(withDaily(200), []),
      intent: { ...INTENT, amountEurcEquivalent: String(amountEurc) },
    }).kind,
    'reserve',
  )
})

test('a non-finite CEILING fails closed, not just a non-finite amount', () => {
  // 🔴 `x > NaN` is false, so an unreadable limit silently inverts from a
  // brake into a pass. The daily side used to be guarded here in
  // reserveDecision; the per-payment side was guarded NOWHERE -- measured, a
  // NaN maxEurcPerPayment let every amount through and no test noticed. The
  // guard now lives in checkPayment, where the comparison is.
  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const perPayment = reserveDecision({
      ...base,
      policy: policyFromOverrideRows({ ...CEILING, maxEurcPerPayment: broken }, []),
      intent: paying(1.21),
    })
    assert.equal(
      perPayment.kind,
      'policy_violation',
      `maxEurcPerPayment=${broken} must refuse, not pass`,
    )

    const daily = reserveDecision({
      ...base,
      policy: policyFromOverrideRows(withDaily(broken), []),
      intent: paying(1.21),
    })
    assert.equal(daily.kind, 'over_daily_ceiling', `maxEurcPerDay=${broken} must refuse`)
  }

  // 🔴 All FOUR ceilings, not just the two about money. Two of
  // four being guarded reads as a decision about the other two.
  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const slippage = reserveDecision({
      ...base,
      policy: policyFromOverrideRows({ ...CEILING, maxSlippageBps: broken }, []),
      intent: { ...paying(1.21), slippageBps: 9999 },
    })
    assert.equal(
      slippage.kind,
      'policy_violation',
      `maxSlippageBps=${broken} must refuse 9999 bps, not pass it`,
    )

    const deadline = reserveDecision({
      ...base,
      policy: policyFromOverrideRows({ ...CEILING, maxDeadlineSeconds: broken }, []),
      intent: { ...paying(1.21), deadlineSeconds: 999999 },
    })
    assert.equal(
      deadline.kind,
      'policy_violation',
      `maxDeadlineSeconds=${broken} must refuse 999999s, not pass it`,
    )
  }

  // Control: a finite ceiling still reserves, so this is not "refuse always".
  assert.equal(reserveDecision(base).kind, 'reserve')
  assert.equal(
    reserveDecision({ ...base, intent: { ...INTENT, slippageBps: 50, deadlineSeconds: 600 } }).kind,
    'reserve',
    'control: values at the shipped ceilings still reserve',
  )
})

test('refuseEverything refuses a payment the shipped ceiling allows', () => {
  // 🔴 This was the money path's fail-closed exit and it had NO
  // executable control: replacing its body with a fully permissive policy
  // left 240 pass / 0 fail. The only guard was a source pin asserting the
  // CALL still exists, which sees deletion and not neutering -- the exact
  // subject this PR's own commit message claimed to be closing.
  //
  // The import was already here and never called. That is what an
  // un-landed test looks like from the outside.
  const intent = {
    amountEurcEquivalent: '1.21',
    network: 'eip155:8453',
    asset: 'EURC',
    payTo: ERPC_TREASURY_BASE,
  }
  const reserveArgs = { existing: undefined, spentTodayEurc: 0, intent }

  // Control first: the shipped ceiling allows this payment.
  assert.equal(
    reserveDecision({ ...reserveArgs, policy: policyFromOverrideRows(CEILING, []) }).kind,
    'reserve',
    'control: the deploy-time ceiling allows 1.21 EURC to the treasury',
  )

  // The refusal must refuse the same payment.
  const refused = reserveDecision({ ...reserveArgs, policy: refuseEverything() })
  assert.notEqual(refused.kind, 'reserve', 'refuseEverything must refuse')

  // And every dimension must be closed, not just the amount: a version that
  // zeroes the ceilings but leaves the allowlists open still pays the wrong
  // payee on the wrong network.
  const policy = refuseEverything()
  assert.equal(policy.maxEurcPerPayment, 0)
  assert.equal(policy.maxEurcPerDay, 0)
  assert.equal(policy.maxSlippageBps, 0)
  assert.equal(policy.maxDeadlineSeconds, 0)
  assert.deepEqual(policy.allowedAssets, [])
  assert.deepEqual(policy.allowedNetworks.toJSON(), [])
  assert.equal(policy.allowAnyPayTo, false)
  assert.equal(policy.allowedPayTo, '')

  // 🔴 Driven, one dimension at a time, from a baseline that RESERVES.
  //
  // The first version of this loop did not discriminate anything. Its three
  // probes all carried a positive amount, so `maxEurcPerPayment: 0` refused
  // them whatever the allowlists said, and one of them used the same network
  // as the control -- it changed nothing. Proof: with a weakened
  // refuseEverything, deleting the eight property assertions above and
  // keeping the loop left 243 pass / 0 fail.
  //
  // So each case takes the shipped ceiling, which reserves, and closes
  // exactly ONE field to the value refuseEverything() uses. Any refusal is
  // then attributable to that field and to nothing else.
  const closed = refuseEverything()
  const open = { ...CEILING }

  assert.equal(
    reserveDecision({ ...reserveArgs, policy: policyFromOverrideRows(open, []) }).kind,
    'reserve',
    'baseline: nothing closed, the payment reserves',
  )

  for (
    const [label, ceiling, probe] of [
      ['maxEurcPerPayment', { ...open, maxEurcPerPayment: closed.maxEurcPerPayment }, intent],
      ['maxEurcPerDay', { ...open, maxEurcPerDay: closed.maxEurcPerDay }, intent],
      ['allowedNetworks', { ...open, allowedNetworks: closed.allowedNetworks }, intent],
      ['allowedAssets', { ...open, allowedAssets: [...closed.allowedAssets] }, intent],
      ['allowedPayTo', { ...open, allowedPayTo: closed.allowedPayTo }, intent],
      [
        'maxSlippageBps',
        { ...open, maxSlippageBps: closed.maxSlippageBps },
        { ...intent, slippageBps: 1 },
      ],
      [
        'maxDeadlineSeconds',
        { ...open, maxDeadlineSeconds: closed.maxDeadlineSeconds },
        { ...intent, deadlineSeconds: 1 },
      ],
    ] as const
  ) {
    // Control for the probe itself: with nothing closed, this exact probe
    // still reserves, so the refusal below is the field and not the probe.
    assert.equal(
      reserveDecision({ ...reserveArgs, policy: policyFromOverrideRows(open, []), intent: probe })
        .kind,
      'reserve',
      `control: the probe for ${label} reserves against an open ceiling`,
    )
    assert.notEqual(
      reserveDecision({ ...reserveArgs, policy: policyFromOverrideRows(ceiling, []), intent: probe })
        .kind,
      'reserve',
      `closing ${label} alone must refuse`,
    )
  }
})

test('🔴 the shipped [vars] are identical to the built-in defaults', () => {
  // 🔴 Pinned so it cannot be forgotten again. `loadPolicy({})`
  // does NOT throw -- it returns the built-in defaults, by design, and
  // policy.test.ts pins that by name. So a worker that reads no POLICY_* var
  // at all behaves exactly like one that reads every one of them, because
  // wrangler.toml sets each to its own default.
  //
  // That is why "exercise the happy path once after deploy" is a null test
  // for "can the Durable Object see [vars]?": both answers look the same.
  // The real check needs a ceiling that DIFFERS from its default.
  //
  // This test does not demand they differ -- that is a deploy decision. It
  // records that they do not, so the next person reading the deploy notes is
  // not relying on a check that cannot fail.
  const toml = readFileSync(join(import.meta.dirname, '..', '..', 'wrangler.toml'), 'utf8')
  const shipped = Object.fromEntries(
    [...toml.matchAll(/^(POLICY_[A-Z_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]),
  )
  assert.deepEqual(
    Object.keys(shipped).sort(),
    [
      'POLICY_ALLOWED_ASSETS',
      'POLICY_ALLOWED_NETWORKS',
      'POLICY_ALLOW_ANY_PAYTO',
      'POLICY_MAX_DEADLINE_SECONDS',
      'POLICY_MAX_EURC_PER_DAY',
      'POLICY_MAX_EURC_PER_PAYMENT',
      'POLICY_MAX_SLIPPAGE_BPS',
    ],
    'exactly the shipped policy vars -- a new one is meant to be read here',
  )

  const defaults = loadPolicy({} as never)
  const fromShipped = loadPolicy(shipped as never)

  assert.equal(fromShipped.maxEurcPerPayment, defaults.maxEurcPerPayment)
  assert.equal(fromShipped.maxEurcPerDay, defaults.maxEurcPerDay)
  assert.equal(fromShipped.maxSlippageBps, defaults.maxSlippageBps)
  assert.equal(fromShipped.maxDeadlineSeconds, defaults.maxDeadlineSeconds)
  assert.deepEqual(fromShipped.allowedAssets, defaults.allowedAssets)
  assert.deepEqual(fromShipped.allowedNetworks.toJSON(), defaults.allowedNetworks.toJSON())
  assert.equal(fromShipped.allowAnyPayTo, defaults.allowAnyPayTo)

  // If a future deploy makes one differ, this reddens and the deploy check
  // becomes meaningful -- update the expectation and say so in the notes.
})

test('loadPolicy defaults on ABSENT and throws on PRESENT-BUT-UNUSABLE', () => {
  // The distinction B-2 turned on, driven so the docblocks above cannot drift
  // from it again.
  assert.doesNotThrow(() => loadPolicy({} as never), 'absent vars must not throw')
  for (const bad of ['NaN', 'Infinity', '1e999', '', '   ', '0', '-1']) {
    assert.throws(
      () => loadPolicy({ POLICY_MAX_EURC_PER_DAY: bad } as never),
      `POLICY_MAX_EURC_PER_DAY=${JSON.stringify(bad)} must throw`,
    )
  }
})

test('a daily refusal carries every violation, not only the daily one', () => {
  // The daily outcome kept its own shape because the caller's
  // guidance for it is specific, and in doing so it dropped the rest. A
  // payment over the daily ceiling AND on a disallowed network reported only
  // the first, so fixing what the message named left the payment refused for
  // a reason the caller was never told.
  const tight = policyFromOverrideRows({ ...CEILING, maxEurcPerDay: 1 }, [])
  const out = reserveDecision({
    existing: undefined,
    spentTodayEurc: 0,
    policy: tight,
    intent: {
      amountEurcEquivalent: '40',
      network: 'eip155:1',
      asset: 'DAI',
      payTo: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      deadlineSeconds: 999999,
    },
  })

  assert.equal(out.kind, 'over_daily_ceiling', 'the daily outcome still wins the shape')
  if (out.kind !== 'over_daily_ceiling') return

  // The numbers the caller prints are unchanged.
  assert.equal(out.limitEurc, 1)
  assert.equal(out.requestedEurc, 40)

  // And every other reason travels with it.
  const kinds = out.violations.map((v) => v.kind).sort()
  // Measured, not assumed: 40 is under the per-payment ceiling of 50, so
  // that one is absent. The list is what was found.
  assert.deepEqual(kinds, [
    'amount_over_daily',
    'asset_not_allowed',
    'deadline_over_limit',
    'network_not_allowed',
    'payto_not_allowed',
  ])

  // Control: a payment that only breaches the daily ceiling carries one.
  const onlyDaily = reserveDecision({
    existing: undefined,
    spentTodayEurc: 0,
    policy: tight,
    intent: { ...INTENT, amountEurcEquivalent: '40' },
  })
  assert.equal(onlyDaily.kind, 'over_daily_ceiling')
  // 40 is under the per-payment ceiling of 50, so the daily one is the only
  // breach -- which is the point: the list is what was found, not a fixed set.
  assert.deepEqual(
    onlyDaily.kind === 'over_daily_ceiling' ? onlyDaily.violations.map((v) => v.kind) : [],
    ['amount_over_daily'],
  )
})

test('a refusal names every cause it was handed, daily first', () => {
  // The prose is built here, where node can drive it, because the
  // pin at the call site was a grep and a grep cannot tell "computed the
  // list" from "computed the list and used it".
  const violations: PolicyViolation[] = [
    { kind: 'amount_over_daily', limit: 1, spentToday: 0, requested: 40 },
    { kind: 'network_not_allowed', allowed: ['eip155:8453'], requested: 'eip155:1' },
    { kind: 'asset_not_allowed', allowed: ['EURC'], requested: 'DAI' },
  ]

  const daily = refusalReasons({
    kind: 'over_daily_ceiling',
    spentTodayEurc: 0,
    limitEurc: 1,
    requestedEurc: 40,
    violations,
  })
  assert.equal(daily.length, 3, `every cause must appear: ${JSON.stringify(daily)}`)
  assert.match(daily[0] ?? '', /daily ceiling/, 'the daily line comes first')
  assert.ok(daily.some((line) => line.includes('eip155:1')), 'the network cause must survive')
  assert.ok(daily.some((line) => line.includes('DAI')), 'and the asset cause')
  // The daily violation is not printed twice -- once as the headline, once
  // from the list.
  assert.equal(daily.filter((line) => /daily/i.test(line)).length, 1)

  // The sibling outcome names all of them with no headline.
  const other = refusalReasons({ kind: 'policy_violation', violations })
  assert.equal(other.length, 3)
  assert.ok(other.some((line) => line.includes('eip155:1')))

  // Control: one cause in, one line out -- so the counts above are not
  // satisfied by a function that always returns three.
  assert.equal(
    refusalReasons({
      kind: 'policy_violation',
      violations: [violations[1] as PolicyViolation],
    }).length,
    1,
  )
})
