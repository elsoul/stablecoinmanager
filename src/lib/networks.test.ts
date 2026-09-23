import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  networkAllowlist,
  type NetworkAllowlist,
  canonicalNetwork,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_LOCAL,
} from './networks'
import { bridgeCapabilities, bridgeRoute } from '@/chain/bridge'
import { checkPayment, type EffectivePolicyValue, loadPolicy, type Policy } from './policy'
import { swapRefusal } from './routes'

/** Test-only mint; see the note in policy.test.ts. */
const asEffective = (p: Policy): EffectivePolicyValue => p as EffectivePolicyValue

test('the two spellings of Solana mainnet compare equal', () => {
  assert.equal(canonicalNetwork(SOLANA_MAINNET_LOCAL), SOLANA_MAINNET_CAIP2)
  assert.equal(canonicalNetwork(SOLANA_MAINNET_CAIP2), SOLANA_MAINNET_CAIP2)
  assert.ok(networkAllowlist([SOLANA_MAINNET_LOCAL]).allows(SOLANA_MAINNET_CAIP2))
  assert.ok(networkAllowlist([SOLANA_MAINNET_CAIP2]).allows(SOLANA_MAINNET_LOCAL))
})

test('an unrelated chain is not aliased into allowance', () => {
  // The fix must not become "everything matches". eip155:1 is Ethereum
  // mainnet and is genuinely NOT in the shipped default allowlist; the
  // honest answer for it is still a refusal.
  assert.equal(canonicalNetwork('eip155:1'), 'eip155:1')
  assert.equal(networkAllowlist(['eip155:8453', SOLANA_MAINNET_LOCAL]).allows('eip155:1'), false)
  assert.equal(networkAllowlist([]).allows(SOLANA_MAINNET_CAIP2), false)
})

test('REACH: the shipped default allowlist can name a real bridge endpoint', () => {
  // This is the test that would have caught B-5. The old check compared raw
  // strings, so EVERY endpoint the SDK ships failed against the shipped
  // default -- and a tool that refuses everything looks exactly like a tool
  // whose policy is simply strict.
  const shipped = loadPolicy({} as never).allowedNetworks
  const caps = bridgeCapabilities()
  assert.ok(caps.length > 0, 'the SDK ships no bridge capabilities to measure against')

  const endpoints = new Set(caps.flatMap((c) => [c.sourceChainId, c.destinationChainId]))
  const reachable = [...endpoints].filter((e) => shipped.allows(e))
  assert.ok(
    reachable.length > 0,
    `no bridge endpoint the SDK ships is nameable by the shipped allowlist ` +
      `(${shipped.describe()}); endpoints: ${[...endpoints].join(', ')}`,
  )

  // 🔴 Recorded, not asserted as a floor. Endpoint reachability is what the
  // vocabulary fix is responsible for; whether a whole CAPABILITY clears the
  // allowlist is a separate policy decision. Today it is zero, because the
  // two capabilities the SDK ships run Ethereum mainnet <-> Solana and
  // eip155:1 is deliberately not allowed -- "B-5 is closed" must not be read
  // as "bridge works in production" (gilgamesh, #14054). Anyone widening the
  // allowlist can read this number to see what changed.
  const wholeCapabilities = caps.filter(
    (c) => shipped.allows(c.sourceChainId) && shipped.allows(c.destinationChainId),
  )
  assert.equal(
    wholeCapabilities.length,
    0,
    `the shipped allowlist now clears ${wholeCapabilities.length} bridge ` +
      `capabilities end to end; if that is intended, update this expectation`,
  )
})

test('REACH: the money path accepts either spelling of an allowed network', () => {
  // 🔴 The control steiner specified. Normalisation reaching plan/swap/bridge
  // but stopping before checkPayment meant that declaring CAIP-2 canonical
  // created a NEW trap: an operator writing the CAIP-2 form into the config
  // would see plan and swap answer "allowed" while every Solana 402 was
  // refused at the payment gate. Fail-closed, so no funds at risk -- but an
  // operator who followed the remediation text would silently stop paying.
  //
  // Mutating canonicalNetwork does NOT discriminate this: both crossings have
  // to be driven with the two vocabularies on opposite sides.
  const base: Policy = {
    ...loadPolicy({} as never),
    allowAnyPayTo: true,
    allowedAssets: ['EURC'],
  }
  const intent = {
    amountEurcEquivalent: '1',
    asset: 'EURC',
    payTo: '0x490842c32b83653dfd06eeeb53b9dbbf5d87f597',
  }

  for (
    const [configSpelling, intentSpelling] of [
      [SOLANA_MAINNET_LOCAL, SOLANA_MAINNET_CAIP2],
      [SOLANA_MAINNET_CAIP2, SOLANA_MAINNET_LOCAL],
      [SOLANA_MAINNET_LOCAL, SOLANA_MAINNET_LOCAL],
      [SOLANA_MAINNET_CAIP2, SOLANA_MAINNET_CAIP2],
    ] as const
  ) {
    const violations = checkPayment(
      asEffective({ ...base, allowedNetworks: networkAllowlist([configSpelling]) }),
      { ...intent, network: intentSpelling },
      0,
    )
    assert.deepEqual(
      violations.filter((v) => v.kind === 'network_not_allowed'),
      [],
      `config ${configSpelling} refused a 402 on ${intentSpelling}`,
    )
  }

  // And the fix must not become "everything is allowed".
  const wrong = checkPayment(
    asEffective({ ...base, allowedNetworks: networkAllowlist([SOLANA_MAINNET_LOCAL]) }),
    { ...intent, network: 'eip155:1' },
    0,
  )
  assert.ok(
    wrong.some((v) => v.kind === 'network_not_allowed'),
    'a genuinely disallowed network must still be refused',
  )
})

test('a real capability is not described as a wishlist gap in the other spelling', () => {
  // bridgeRoute('eip155:1', 'solana-mainnet') answered "the SDK ships no
  // Mayan capability ... this is not a wishlist gap" about a capability that
  // exists. `solana-mainnet` is a spelling this worker hands to the model
  // itself, via holdings and plan.blockedByPolicy (steiner B-7, #14054).
  const route = bridgeRoute('eip155:1', SOLANA_MAINNET_LOCAL)
  assert.equal(route.supported, true, `expected a real capability, got: ${JSON.stringify(route)}`)
  assert.equal(bridgeRoute('eip155:1', SOLANA_MAINNET_CAIP2).supported, true)
})

test('a swap refusal names the same wishlist item in either spelling', () => {
  assert.equal(swapRefusal(SOLANA_MAINNET_LOCAL, 'A/B').needs, 'W4')
  assert.equal(swapRefusal(SOLANA_MAINNET_CAIP2, 'A/B').needs, 'W4')
})

test('the SDK still spells Solana the way the alias expects', () => {
  // If a new SDK renames the chain, this reddens here rather than turning
  // every bridge answer into a silent refusal.
  const caps = bridgeCapabilities()
  const solanaEndpoints = caps
    .flatMap((c) => [c.sourceChainId, c.destinationChainId])
    .filter((e) => e.startsWith('solana:'))
  assert.ok(solanaEndpoints.length > 0, 'expected at least one Solana bridge endpoint')
  for (const e of solanaEndpoints) {
    assert.equal(
      canonicalNetwork(e),
      SOLANA_MAINNET_CAIP2,
      `the SDK now spells Solana as ${e}; add it to ALIASES in lib/networks.ts`,
    )
  }
})

test('BARRIER: the allowlist cannot be searched, only asked', () => {
  // 🔴 gilgamesh R5-N2: nothing reddened when the barrier type was deleted.
  // `@ts-expect-error` inverts that -- the directive itself becomes an error
  // (TS2578) once the expression stops failing, so weakening
  // NetworkAllowlist back into an array reddens `tsc -p tsconfig.test.json`,
  // which `pnpm check` already runs.
  //
  // Each line below is a shape that actually defeated an earlier guard:
  // includes (B-5), Set.has (B-8), some/=== (B-9).
  const allowed = networkAllowlist(['eip155:8453'])
  const raw: string = 'eip155:8453'

  // 🔴 Never called. These exist for `tsc`, not for the runtime: the
  // suppression directive below silences the checker, but the expression
  // still executes, and `allowed.includes(raw)` throws at runtime precisely
  // because the barrier works. Compile-time assertions belong off the hot
  // path. (Writing the directive's own name at the start of a comment line
  // makes that line a directive, which is how this comment first became a
  // TS2578 error about itself.)
  const searchShapes = (list: NetworkAllowlist, id: string): void => {
    // @ts-expect-error searching the allowlist must not be expressible (B-5)
    list.includes(id)
    // @ts-expect-error nor via a Set built from it (B-8)
    new Set(list).has(id)
    // @ts-expect-error nor by iterating it (B-9)
    list.some((a: string) => a === id)
    // @ts-expect-error nor by index
    list[0]
  }
  assert.equal(typeof searchShapes, 'function')

  // The one question it does answer still works.
  assert.equal(allowed.allows(raw), true)
  assert.equal(allowed.allows('eip155:1'), false)

  // And the escape that remains is named in the docblock rather than implied.
  assert.deepEqual(allowed.toJSON(), ['eip155:8453'])
})

test('prototype keys are ordinary unknown ids, not inherited properties', () => {
  // 🔴 A regression this module introduced. `ALIASES[id] ?? id` reads the
  // prototype chain, so canonicalNetwork returned Object, Object.prototype
  // and assorted functions from a signature declaring `string` -- and
  // swapRefusal threw on `.startsWith`. `plan` takes a free-string chainId
  // and reaches swapRefusal with no allowlist check in front of it, so the
  // input is model-controlled.
  // 🔴 Derived, not enumerated (gilgamesh R5-N3: the hand-written list was
  // missing __defineSetter__, __lookupGetter__ and __lookupSetter__). The
  // safety does not depend on this list -- Object.hasOwn closes inherited
  // properties as a class -- but a regression detector that enumerates is the
  // exact habit this PR has now paid for four times.
  const hostile = [
    ...Object.getOwnPropertyNames(Object.prototype),
    '__proto__',
  ]
  assert.ok(hostile.length >= 12, `expected the full prototype surface, got ${hostile.length}`)

  for (const key of hostile) {
    const canonical = canonicalNetwork(key)
    assert.equal(
      typeof canonical,
      'string',
      `canonicalNetwork(${key}) returned ${typeof canonical}, not a string`,
    )
    assert.equal(canonical, key, `${key} must pass through unchanged`)

    // Not allowed, and not a crash either.
    assert.equal(networkAllowlist(['eip155:8453']).allows(key), false)

    // The site that actually threw.
    assert.doesNotThrow(() => swapRefusal(key, 'A/B'), `swapRefusal(${key}) threw`)
    assert.equal(swapRefusal(key, 'A/B').needs, null)

    assert.doesNotThrow(() => bridgeRoute(key, key), `bridgeRoute(${key}) threw`)
    assert.equal(bridgeRoute(key, key).supported, false)
  }
})

test('describe() and toJSON() are the named escapes, and they behave as documented', () => {
  // 🔴 These two exist in the docblock's "still reachable" list. A test that
  // pins their actual behaviour is how that list stays true: if either grows
  // a new way to be misused, this is where it shows up.
  const allowed = networkAllowlist(['eip155:8453', SOLANA_MAINNET_LOCAL])

  // toJSON hands back a COPY. Returning the live array gave three
  // disagreeing views of one policy (gilgamesh R6-N2).
  const first = allowed.toJSON()
  assert.notEqual(first, allowed.toJSON(), 'toJSON must not hand out its own array')
  first.push('evil-chain')
  assert.deepEqual(allowed.toJSON(), ['eip155:8453', SOLANA_MAINNET_LOCAL])
  assert.equal(allowed.allows('evil-chain'), false)
  assert.equal(allowed.describe(), `eip155:8453, ${SOLANA_MAINNET_LOCAL}`)

  // describe() is prose. Searching it is substring matching, which errs OPEN
  // -- the reason it is a method rather than a field (gilgamesh R6-N1).
  for (const prefix of ['eip155:8', 'eip155:845', 'solana', 'olana-mainne']) {
    assert.ok(
      allowed.describe().includes(prefix),
      `precondition: ${prefix} is a substring of the description`,
    )
    assert.equal(
      allowed.allows(prefix),
      false,
      `${prefix} must not be allowed; substring matching would have said yes`,
    )
  }
})
