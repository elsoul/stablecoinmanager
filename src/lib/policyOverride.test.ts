import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { applyOverrides, decideSet, OVERRIDABLE, tightenedValue } from './policyOverride.ts'
import type { EffectivePolicyValue, Policy } from './policy.ts'
import { networkAllowlist } from './networks.ts'

/** Test-only mint; see the note in policy.test.ts. */
const asEffective = (p: Policy): EffectivePolicyValue => p as EffectivePolicyValue

const DEPLOY: Policy = {
  allowedPayTo: '0x490842c32b83653dfd06eeeb53b9dbbf5d87f597',
  maxEurcPerPayment: 50,
  maxEurcPerDay: 200,
  allowedNetworks: networkAllowlist(['eip155:8453']),
  allowedAssets: ['EURC'],
  allowAnyPayTo: false,
  maxSlippageBps: 50,
  maxDeadlineSeconds: 600,
}

// ---------------------------------------------------------------------------
// The rule under test: overrides may only TIGHTEN.
//
// The ceiling exists because this worker pays without asking a human. A
// caller that can raise its own ceiling has no ceiling -- anything that can be
// talked into a large payment can first be talked into permitting one, and the
// tool description is visible to the model. Tightening is safe from any
// caller: the worst outcome is refusing payments.
// ---------------------------------------------------------------------------

test('a narrowing override is accepted', () => {
  const out = decideSet('maxEurcPerPayment', 10, DEPLOY.maxEurcPerPayment, DEPLOY.maxEurcPerPayment)
  assert.equal(out.kind, 'set')
  assert.deepEqual(out, { kind: 'set', key: 'maxEurcPerPayment', from: 50, to: 10 })
})

test('🔴 a widening override is refused, naming the ceiling it would cross', () => {
  const out = decideSet('maxEurcPerDay', 10_000, DEPLOY.maxEurcPerDay, DEPLOY.maxEurcPerDay)
  assert.equal(out.kind, 'would_widen')
  assert.deepEqual(out, {
    kind: 'would_widen',
    key: 'maxEurcPerDay',
    ceiling: 200,
    requested: 10_000,
  })
})

test('relaxing back to the deploy-time value is allowed, past it is not', () => {
  // Tightening must not be a one-way door that only a redeploy reopens, so the
  // comparison is against the DEPLOY-TIME ceiling and not the current value.
  const current = 10
  assert.equal(decideSet('maxEurcPerPayment', 50, 50, current).kind, 'set')
  assert.equal(decideSet('maxEurcPerPayment', 50.01, 50, current).kind, 'would_widen')
})

test('only the numeric ceilings are overridable', () => {
  // Networks, assets and the payee are NOT in the list on purpose: they are
  // not "how much" but "to whom and in what", and widening them is the same
  // class of move as raising an amount.
  for (const key of ['allowedNetworks', 'allowedAssets', 'allowedPayTo', 'allowAnyPayTo']) {
    const out = decideSet(key, 'anything', 1, 1)
    assert.equal(out.kind, 'not_overridable', `${key} must not be settable`)
  }
  // Control: the four that ARE overridable all resolve.
  for (const key of OVERRIDABLE) {
    assert.equal(decideSet(key, 1, 10, 10).kind, 'set', `${key} should be settable`)
  }
})

test('a non-numeric or negative value is refused, not coerced', () => {
  for (const bad of ['abc', '', null, undefined, NaN, -1, Infinity]) {
    const out = decideSet('maxEurcPerDay', bad, 200, 200)
    assert.equal(out.kind, 'not_a_number', `${JSON.stringify(bad)} must be refused`)
  }
  // Control: 0 is a legitimate tightening -- refuse everything.
  assert.equal(decideSet('maxEurcPerDay', 0, 200, 200).kind, 'set')
})

test('applyOverrides narrows and never widens', () => {
  const narrowed = applyOverrides(DEPLOY, { maxEurcPerPayment: '5', maxEurcPerDay: '20' })
  assert.equal(narrowed.maxEurcPerPayment, 5)
  assert.equal(narrowed.maxEurcPerDay, 20)

  // 🔴 A row that WOULD widen is ignored at read time too, so a row written
  // before this rule existed -- or by a future tool -- cannot take effect.
  const attempted = applyOverrides(DEPLOY, { maxEurcPerDay: '999999' })
  assert.equal(attempted.maxEurcPerDay, 200, 'a widening row must not apply')
})

test('an unreadable row keeps the deploy-time ceiling', () => {
  // Not 0 (which would refuse everything) and not "absent" in a way that could
  // widen: the value an operator approved at deploy is what survives.
  for (const junk of ['', 'abc', 'NaN', '-5', 'Infinity']) {
    const out = applyOverrides(DEPLOY, { maxEurcPerPayment: junk })
    assert.equal(out.maxEurcPerPayment, 50, `${JSON.stringify(junk)} must be ignored`)
  }
})

test('overrides do not touch the non-numeric fields', () => {
  const out = applyOverrides(DEPLOY, {
    maxEurcPerDay: '10',
    allowedPayTo: '0xattacker',
    allowAnyPayTo: 'true',
    allowedAssets: 'USDC',
  } as Record<string, string>)
  assert.equal(out.allowedPayTo, DEPLOY.allowedPayTo)
  assert.equal(out.allowAnyPayTo, false)
  assert.deepEqual(out.allowedAssets, ['EURC'])
  assert.equal(out.maxEurcPerDay, 10, 'control: the numeric one did apply')
})

// ---------------------------------------------------------------------------
// The pairing: policy_set compares against the DEPLOY-TIME ceiling, every
// payment check runs against the EFFECTIVE policy. Getting it backwards makes
// tightening a one-way door only a redeploy can reopen.
// ---------------------------------------------------------------------------

test('composePolicy keeps the ceiling and the effective policy separately nameable', async () => {
  const { composePolicy } = await import('./effectivePolicy.ts')
  const composed = composePolicy(DEPLOY, { maxEurcPerDay: '20' })

  assert.equal(composed.effective.maxEurcPerDay, 20, 'payments are checked against 20')
  assert.equal(composed.ceiling.maxEurcPerDay, 200, 'policy_set still compares against 200')

  // The round trip the pairing exists for: narrowed to 20, then relaxed back
  // to the value an operator approved at deploy -- allowed, because the
  // comparison is against the ceiling and not against the current effective.
  const back = decideSet('maxEurcPerDay', 200, composed.ceiling.maxEurcPerDay, composed.effective.maxEurcPerDay)
  assert.equal(back.kind, 'set')
  // And one unit past it is still refused.
  assert.equal(
    decideSet('maxEurcPerDay', 201, composed.ceiling.maxEurcPerDay, composed.effective.maxEurcPerDay).kind,
    'would_widen',
  )
})

test('🔴 loadPolicy cannot reach an override even in principle', async () => {
  // Structural, not behavioural: loadPolicy takes only `env`, so the hard
  // ceiling is not something the worker can change by writing to its own
  // storage. If this signature ever grows a ledger argument, the separation
  // this module depends on is gone.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const source = readFileSync(join(import.meta.dirname, 'policy.ts'), 'utf8')
  assert.match(source, /export function loadPolicy\(env: Env\): Policy \{/)
  const body = source.slice(source.indexOf('export function loadPolicy'))
  assert.ok(!/policy_overrides|policyOverrides|applyOverrides/.test(body.slice(0, 1200)))
})

// ---------------------------------------------------------------------------
// 🔴 THE MONEY PATH, with a stored override.
//
// Every test above drives applyOverrides/decideSet directly, and all of them
// stayed green while the two tools that actually move money called
// loadPolicy(env) and never read an override at all. Measured: replacing
// applyOverrides with the identity function reddened three tests,
// every one of them its own unit test, and not a single payment assertion.
//
// A control that only covers the function it is named after has no Reach.
// This one drives the REAL checkPayment against a policy composed the way the
// money path composes it, so an override that stops binding fails here.
// ---------------------------------------------------------------------------

test('🔴 a stored narrowing override binds the payment check', async () => {
  const { checkPayment } = await import('./policy.ts')
  const { composePolicy } = await import('./effectivePolicy.ts')

  // Operator tightens 50/200 down to 5/10 during an incident.
  const composed = composePolicy(DEPLOY, { maxEurcPerPayment: '5', maxEurcPerDay: '10' })

  const payment = {
    amountEurcEquivalent: '40',
    network: 'eip155:8453',
    asset: 'EURC',
    payTo: DEPLOY.allowedPayTo,
    deadlineSeconds: 60,
  }

  // Against the CEILING this passes -- which is exactly what the money path
  // was doing, and why the override was invisible.
  //
  // 🔴 `asEffective` here is the control DEFEATING the barrier on purpose:
  // after the brand landed, handing a ceiling to checkPayment stopped being
  // expressible in production at all, so the control has to say explicitly
  // that it is doing the forbidden thing. That the cast is needed here is
  // itself the evidence the barrier holds.
  assert.deepEqual(
    checkPayment(asEffective(composed.ceiling), payment, 0),
    [],
    'control: the deploy-time ceiling really does allow 40',
  )

  // Against the EFFECTIVE policy it must be refused.
  const violations = checkPayment(composed.effective, payment, 0)
  assert.ok(violations.length > 0, 'the tightened ceiling must refuse 40 EURC')
  assert.ok(
    violations.some((v) => v.kind === 'amount_over_per_payment'),
    `expected a per-payment violation, got ${JSON.stringify(violations)}`,
  )
})

test('BACKSTOP: no tool reaches for the deploy-time ceiling by name', () => {
  // 🔴 DEMOTED, on purpose. This used to be the only thing standing between
  // `policy_set` and the defect it exists to prevent, and both gates showed
  // it loses: `(await effectivePolicy(env)).ceiling` walked around it with
  // 211 green and so did `import { loadPolicy as readPolicy }`
  //. The barrier is now `checkPayment`'s parameter type --
  // see EffectivePolicyValue in policy.ts -- and a ceiling reaching the money
  // path is a COMPILE error however it is spelled.
  //
  // This stays because a grep still catches the honest mistake early, with a
  // better message than a type error gives. It is a backstop, not the gate.
  const dir = join(import.meta.dirname, '..', 'route', 'mcp', 'tools')
  const offenders: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const source = readFileSync(join(dir, name), 'utf8')
    // policySet legitimately needs the ceiling: it compares against it.
    if (name === 'policySet.ts') continue
    if (/\bloadPolicy\b/.test(source) || /\.ceiling\b/.test(source)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `these read the deploy-time ceiling directly: ${offenders}`)
})

test('BARRIER: the effective-policy brand has exactly one mint in production', () => {
  // What makes the type a barrier rather than a naming convention: if any
  // other non-test file can write the cast, the compile error is one line of
  // ceremony away from being silenced. This walks the whole src tree.
  const root = join(import.meta.dirname, '..')
  const minting: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      if (/as\s+EffectivePolicyValue\b/.test(readFileSync(full, 'utf8'))) {
        minting.push(full.slice(root.length + 1))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    minting,
    ['lib/policyOverride.ts'],
    `the brand must be minted in applyOverrides only; found: ${minting.join(', ')}`,
  )
})

test('BARRIER: the network allowlist has exactly one mint in production', () => {
  // 🔴 Symmetry with the EffectivePolicyValue barrier above, which was
  // requested in review and which this type went without for a while.
  // A forged allowlist -- `{ allows: () => true } as unknown as
  // NetworkAllowlist` -- compiles, so `networkAllowlist()` being the only
  // producer is a property that has to be checked rather than assumed.
  //
  // The asymmetry is the finding: one barrier existing and its twin not is
  // how a reader concludes the second type is guarded when it is not.
  const root = join(import.meta.dirname, '..')
  const forging: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      const source = readFileSync(full, 'utf8')
      if (/as\s+(unknown\s+as\s+)?NetworkAllowlist\b/.test(source)) {
        forging.push(full.slice(root.length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    forging,
    ['lib/networks.ts'],
    `only networkAllowlist() may produce one; found: ${forging.join(', ')}`,
  )
})

test('BARRIER: every test file in src is actually run', () => {
  // 🔴 The test script enumerates files by hand. A new `*.test.ts` that is
  // not on that line does not run, and nothing says so -- the suite stays
  // green and the total goes up by zero. `lib/networks.test.ts` was written,
  // committed and silently skipped exactly this way.
  //
  // Same defect class as the hardcoded bridge route list and the curation
  // docblock: a written-down inventory drifting from what the code does,
  // where the drift is invisible because the written form still reads right.
  const root = join(import.meta.dirname, '..')
  const pkg = JSON.parse(
    readFileSync(join(root, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }
  const enumerated = new Set(
    pkg.scripts.test.split(/\s+/).filter((t) => t.endsWith('.test.ts')),
  )

  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.test.ts')) {
        found.push('src/' + full.slice(root.length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root)

  const missing = found.filter((f) => !enumerated.has(f)).sort()
  assert.deepEqual(missing, [], `these test files exist but never run: ${missing.join(', ')}`)
})

test('BACKSTOP: nothing in src compares a network with a raw string match', () => {
  // The vocabulary defect: the SDK names Solana in CAIP-2 and this worker's
  // config names it `solana-mainnet`, so `allowedNetworks.includes(id)`
  // refused every bridge capability the SDK ships while looking like an
  // ordinary policy refusal. `NetworkAllowlist.allows`
  // normalises both sides; nothing else may do the comparison.
  // 🔴 Widened from `route/mcp/tools` to the whole tree. Scoping it to the
  // tools directory is why B-7 survived the B-5 fix: the raw comparison that
  // mattered most was in `lib/policy.ts`, inside checkPayment.
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
      if (full.endsWith(join('lib', 'networks.ts'))) continue // the normaliser itself
      const source = readFileSync(full, 'utf8')
      if (
        /allowedNetworks\s*\.(includes|indexOf|some|find|filter|map|forEach|entries|keys|values|at)\s*[(\[]/
          .test(source) ||
        /new Set\(\s*[\w.]*allowedNetworks\s*\)/.test(source) ||
        /of\s+[\w.]*allowedNetworks\b/.test(source) ||
        /\.\.\.[\w.]*allowedNetworks\b/.test(source)
      ) {
        offenders.push(full.slice(root.length + 1))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    `these compare networks without normalising: ${offenders}`,
  )
})

test('tightenedValue narrows, never widens, and fails to the ceiling', () => {
  // The single-key rule the Durable Object runs inside its own turn. It is
  // exported so the DO can reach it, which means it is now load-bearing in
  // two places -- the point of exporting rather than copying.
  assert.equal(tightenedValue(50, '5'), 5, 'a narrower stored value applies')
  assert.equal(tightenedValue(50, '50'), 50, 'equal is not widening')
  assert.equal(tightenedValue(50, '500'), 50, 'a widening row is ignored')
  assert.equal(tightenedValue(50, undefined), 50, 'no row -> the ceiling stands')
  assert.equal(tightenedValue(50, 0), 0, '0 is a legitimate refuse-everything')
  assert.equal(tightenedValue(50, '0'), 0)

  // Unreadable must fall back to the CEILING, not to 0 and not to the raw
  // value. Number('') and Number(null) are both 0, which is why this uses a
  // strict parse rather than a cast.
  for (const junk of ['', '   ', 'abc', '5e3', '-1', null, {}, [], true, NaN]) {
    assert.equal(
      tightenedValue(50, junk),
      50,
      `unreadable override ${JSON.stringify(junk)} must leave the ceiling in place`,
    )
  }
})

test('applyOverrides and the Durable Object answer with the same code', () => {
  // Not "the same behaviour" -- the same function. Two predicates for one
  // question is a defect this repo has paid for (utils/redact.ts), and this
  // one decides how much money leaves the wallet.
  const source = readFileSync(join(import.meta.dirname, 'policyOverride.ts'), 'utf8')
  const body = source.slice(source.indexOf('export function applyOverrides'))
  assert.ok(
    body.includes('tightenedValue('),
    'applyOverrides must use the exported rule, not an inline copy',
  )
})
