import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  EURC_BASE_MAINNET_CONTRACT,
  USDC_BASE_MAINNET_CONTRACT,
} from '@constants/base'
import {
  allowedAssetPreferences,
  EURC_BASE,
  topupAssetPreferences,
  USDC_BASE,
} from './assets.ts'
import {
  atomicToDecimal,
  BASE_NETWORK,
  ERPC_TREASURY_BASE,
  extraKeyDrift,
  normalizeAccepts,
  selectRequirement,
} from './x402.ts'
import type { EffectivePolicyValue, Policy } from './policy.ts'
import { networkAllowlist } from './networks.ts'

/** Test-only mint; see the note in policy.test.ts. */
const asEffective = (p: Policy): EffectivePolicyValue => p as EffectivePolicyValue

const POLICY: Policy = {
  allowedPayTo: ERPC_TREASURY_BASE,
  maxEurcPerPayment: 50,
  maxEurcPerDay: 200,
  allowedNetworks: networkAllowlist([BASE_NETWORK, 'solana-mainnet']),
  allowedAssets: ['EURC', 'USDC'],
  allowAnyPayTo: false,
  maxSlippageBps: 50,
  maxDeadlineSeconds: 600,
}

const eurcOnBase = {
  scheme: 'exact',
  network: BASE_NETWORK,
  asset: EURC_BASE,
  amount: '1210000',
  payTo: ERPC_TREASURY_BASE,
  maxTimeoutSeconds: 60,
  extra: { name: 'EURC', version: '2' },
}

test('the treasury comes from the repo constant, not a second copy', () => {
  // A payee address written twice is a payee address updated once.
  assert.match(ERPC_TREASURY_BASE, /^0x[0-9a-f]{40}$/)
  assert.equal(POLICY.allowedPayTo, ERPC_TREASURY_BASE)
})

test('a well-formed EVM requirement normalizes and is payable', () => {
  const [req] = normalizeAccepts([eurcOnBase])
  assert.equal(req.payable, true)
  assert.equal(req.network, BASE_NETWORK)
  assert.equal(req.amountAtomic, '1210000')
  assert.deepEqual(req.extraKeys, ['name', 'version'])
})

test('a non-EVM requirement is NOT payable, and says why', () => {
  // Saying "unsupported" is the contract; silently skipping it would let a
  // caller believe a Solana requirement simply was not offered.
  const [req] = normalizeAccepts([{ ...eurcOnBase, network: 'solana-mainnet' }])
  assert.equal(req.payable, false)
  assert.match(req.unpayableReason ?? '', /EVM/)
})

test('a non-exact scheme is not payable', () => {
  const [req] = normalizeAccepts([{ ...eurcOnBase, scheme: 'upto' }])
  assert.equal(req.payable, false)
  assert.match(req.unpayableReason ?? '', /scheme/)
})

test('a missing accepts array is empty, not a crash', () => {
  assert.deepEqual(normalizeAccepts(undefined), [])
  assert.deepEqual(normalizeAccepts(null), [])
  assert.deepEqual(normalizeAccepts('nope'), [])
})

test('selection prefers EURC on Base, then USDC on Base', () => {
  const prefs = allowedAssetPreferences(asEffective(POLICY))
  assert.deepEqual(prefs.map((p) => p.label), ['EURC', 'USDC'])

  const both = normalizeAccepts([
    { ...eurcOnBase, asset: USDC_BASE, amount: '1000000' },
    eurcOnBase,
  ])
  const { chosen } = selectRequirement(both, prefs)
  assert.equal(chosen?.asset, EURC_BASE, 'EURC wins even when USDC is listed first')
})

test('selection refuses rather than falling back to whatever is first', () => {
  const prefs = allowedAssetPreferences(asEffective(POLICY))
  const unknownAsset = normalizeAccepts([
    { ...eurcOnBase, asset: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
  ])
  const { chosen, reason } = selectRequirement(unknownAsset, prefs)
  assert.equal(chosen, undefined)
  assert.match(reason ?? '', /allowed assets/)
})

test('an unsignable requirement is never chosen', () => {
  const prefs = allowedAssetPreferences(asEffective(POLICY))
  const solanaOnly = normalizeAccepts([{ ...eurcOnBase, network: 'solana-mainnet' }])
  const { chosen, reason } = selectRequirement(solanaOnly, prefs)
  assert.equal(chosen, undefined)
  assert.match(reason ?? '', /can be signed by this worker/)
})

test('an empty 402 says so', () => {
  const { chosen, reason } = selectRequirement([], allowedAssetPreferences(asEffective(POLICY)))
  assert.equal(chosen, undefined)
  assert.match(reason ?? '', /no requirements/)
})

test('policy narrowing removes assets from the preference list', () => {
  const eurcOnly = allowedAssetPreferences(asEffective({ ...POLICY, allowedAssets: ['EURC'] }))
  assert.deepEqual(eurcOnly.map((p) => p.label), ['EURC'])
  const none = allowedAssetPreferences(asEffective({ ...POLICY, allowedNetworks: networkAllowlist(['solana-mainnet']) }))
  assert.deepEqual(none, [])
})

test('atomic amounts convert without floating point', () => {
  assert.equal(atomicToDecimal('1210000', 6), '1.21')
  assert.equal(atomicToDecimal('1000000', 6), '1')
  assert.equal(atomicToDecimal('1', 6), '0.000001')
  assert.equal(atomicToDecimal('0', 6), '0')
  // A very large amount must not lose precision the way Number would.
  assert.equal(atomicToDecimal('123456789012345678', 6), '123456789012.345678')
  assert.equal(atomicToDecimal('not-a-number', 6), '0')
})

test('extra-key drift catches the volatile field that breaks a signature', () => {
  // A field appearing inside `extra` between the read that was signed
  // and the read the server compares against turns a correct signature into
  // price_mismatch.
  assert.deepEqual(extraKeyDrift(['name', 'version'], ['name', 'version']), [])
  assert.deepEqual(
    extraKeyDrift(['name', 'version'], ['name', 'version', 'quoteExpiresAt']),
    ['quoteExpiresAt'],
  )
  assert.deepEqual(extraKeyDrift(['a'], ['b']), ['a', 'b'])
})

test('drift compares SHAPE, not values', () => {
  // Comparing values would flag every legitimate quote refresh, which would
  // train the caller to ignore the warning.
  const a = normalizeAccepts([{ ...eurcOnBase, extra: { name: 'EURC', version: '2' } }])
  const b = normalizeAccepts([{ ...eurcOnBase, extra: { name: 'EURC', version: '3' } }])
  assert.deepEqual(extraKeyDrift(a[0].extraKeys, b[0].extraKeys), [])
})

// ---------------------------------------------------------------------------
// Top-ups are EURC-denominated by a standing ruling, recorded in
// constants/base.ts on USDC_BASE_MAINNET_CONTRACT: "USDC on Base is NOT
// accepted for credit top-ups (design decision, 2026-09-10)".
//
// The policy's allowed-assets list is a ceiling for generic payments and has
// no business widening this. The failure it prevents is quiet: a 402 that
// offers USDC would be paid in USDC -- a correct payment and a wrong top-up.
// ---------------------------------------------------------------------------

test('a credit top-up may be paid in EURC only, whatever the policy allows', () => {
  const permissive = {
    allowedAssets: ['EURC', 'USDC'],
    allowedNetworks: networkAllowlist([BASE_NETWORK]),
  } as unknown as Parameters<typeof topupAssetPreferences>[0]

  const generic = allowedAssetPreferences(permissive)
  const topup = topupAssetPreferences(permissive)

  // Control: the policy really does allow both, so the filter below is doing
  // the narrowing -- not an already-empty list.
  assert.equal(generic.length, 2)
  assert.deepEqual(generic.map((p) => p.label), ['EURC', 'USDC'])

  assert.equal(topup.length, 1)
  assert.equal(topup[0].label, 'EURC')
  assert.equal(topup[0].assetAddress.toLowerCase(), EURC_BASE.toLowerCase())
})

test('the top-up asset is the contract constants/base.ts records, not a retyped one', () => {
  // A second copy of a token address is how a payment quietly goes to the
  // wrong asset. These must be the same string as the repo's constant.
  assert.equal(EURC_BASE, EURC_BASE_MAINNET_CONTRACT)
  assert.equal(USDC_BASE, USDC_BASE_MAINNET_CONTRACT)
})

test('the policy can still narrow a top-up to nothing, it just cannot widen it', () => {
  // Removing EURC leaves no payable asset. That is a refusal, not a fallback
  // to USDC -- which is the whole point of the filter.
  const noEurc = {
    allowedAssets: ['USDC'],
    allowedNetworks: networkAllowlist([BASE_NETWORK]),
  } as unknown as Parameters<typeof topupAssetPreferences>[0]
  assert.equal(allowedAssetPreferences(noEurc).length, 1)
  assert.equal(topupAssetPreferences(noEurc).length, 0)
})

test('SOURCE: erpc_topup actually hands the EURC-only list to x402_pay', () => {
  // The three tests above check that topupAssetPreferences narrows correctly.
  // None of them notices if erpc_topup stops PASSING it -- measured: deleting
  // the `assetPreferences:` line left all of them green, which means the
  // restriction was only as real as one unchecked wire.
  const source = readFileSync(
    join(import.meta.dirname, '..', 'route', 'mcp', 'tools', 'erpcTopup.ts'),
    'utf8',
  )
  assert.match(
    source,
    /topupAssetPreferences\(/,
    'erpc_topup computes the restricted list',
  )
  // Positional rather than one regex. `[^}]*` across the argument object stops
  // at the `}` of `headers: { Authorization: bearer }` -- the same nested-brace
  // trap that made an earlier source extractor in this package read a
  // parameter type instead of a method body. So: find the call, find the end
  // of the statement, and require the key between them.
  const callStart = source.indexOf('x402Pay(env, {')
  assert.notEqual(callStart, -1, 'erpc_topup calls x402Pay')
  const callEnd = source.indexOf('if (!paid.ok)', callStart)
  assert.notEqual(callEnd, -1, 'the call is followed by its result check')
  assert.match(
    source.slice(callStart, callEnd),
    /assetPreferences:\s*preferences/,
    'and passes the restricted list into that call',
  )

  // And x402_pay must honour it rather than ignoring the argument.
  const pay = readFileSync(
    join(import.meta.dirname, '..', 'route', 'mcp', 'tools', 'x402Pay.ts'),
    'utf8',
  )
  assert.match(
    pay,
    /args\.assetPreferences\s*\?\?\s*allowedAssetPreferences\(policy\)/,
    'x402_pay prefers the caller list and falls back to the policy',
  )

  // It must NOT be reachable from the MCP input schema: a client that could
  // set assetPreferences could widen what a top-up pays in, which is the
  // constraint this whole file exists to hold.
  const schema = readFileSync(
    join(import.meta.dirname, '..', 'route', 'mcp', 'toolsList.ts'),
    'utf8',
  )
  // Comments stripped first. A docblock saying why the field is
  // absent was added at one point, and a predicate that cannot tell prose from a declaration reports
  // the explanation as the violation -- measured. The same fix the mnemonic
  // guard needed.
  const schemaCode = schema
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(
    !schemaCode.includes('assetPreferences'),
    'assetPreferences must not be a client-settable argument',
  )
})

// ---------------------------------------------------------------------------
// Money-critical values come from constants/base.ts, never retyped.
//
// This is not tidiness. Hand-typing the EURC address is how this package
// ALMOST shipped a top-up payable in USDC: the repo's constant carries the
// ruling in its doc comment ("USDC on Base is NOT accepted for credit
// top-ups"), and a copied literal carries the value without the ruling. The
// address was correct; what the copy dropped was everything around it.
//
// Three copies of the token addresses existed at one point in this package.
// ---------------------------------------------------------------------------

test('SOURCE: no money-critical literal is retyped anywhere in src', () => {
  const root = join(import.meta.dirname, '..')
  const BANNED: Array<[RegExp, string]> = [
    [/0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42/i, 'EURC_BASE_MAINNET_CONTRACT'],
    [/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913/i, 'USDC_BASE_MAINNET_CONTRACT'],
    [/['"`]eip155:8453['"`]/, 'BASE_MAINNET_CAIP2_NETWORK'],
    [/https:\/\/basescan\.org\/tx\//, 'BASE_EXPLORER_TX_BASE_URL'],
  ]

  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(full)
      }
    }
  }
  walk(root)

  // Vacuity guard: an empty walk would pass every assertion below.
  assert.ok(files.length >= 20, `expected the package sources, found ${files.length}`)

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const [pattern, constant] of BANNED) {
      // Prose may name the value; code may not. Comments are stripped first so
      // a doc comment explaining WHY the constant is imported does not trip
      // the rule it is explaining.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      assert.ok(
        !pattern.test(code),
        `${file.slice(root.length + 1)} writes a literal instead of importing ${constant}`,
      )
    }
  }
})

test('SOURCE: every atomicToDecimal call uses the shared decimals constant', () => {
  // The banned-literal guard above cannot help here: a bare `6` is too common
  // to blocklist. But a wrong decimals argument is a displayed or computed
  // amount off by a factor of a million, and x402_inspect had one -- it read
  // `atomicToDecimal(chosen.amountAtomic, 6)` while every other call site used
  // ASSET_DECIMALS. It was right, and it was right by coincidence of EURC and
  // USDC both being 6.
  const root = join(import.meta.dirname, '..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(full)
      }
    }
  }
  walk(root)

  const calls: string[] = []
  for (const file of files) {
    // The definition itself takes `decimals: number`; only CALLS are checked.
    if (file.endsWith(join('lib', 'x402.ts'))) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/atomicToDecimal\(([^)]*)\)/g)) {
      calls.push(`${file.slice(root.length + 1)}: ${match[0]}`)
    }
  }

  // Vacuity guard: three call sites. It was four until the amount was
  // unified onto the intent and the duplicate `const amountEurc` in x402Pay
  // went with it. A change in this number is meant to be read.
  assert.equal(calls.length, 3, `call sites found:\n${calls.join('\n')}`)
  for (const call of calls) {
    assert.ok(
      call.includes('ASSET_DECIMALS'),
      `${call} passes a literal instead of ASSET_DECIMALS`,
    )
  }
})

test('BARRIER: the asset preference readers require an effective policy', () => {
  // 🔴 Measured, not assumed: reverting these signatures to a bare `Policy`
  // reddened NOTHING -- 0 type errors, 0 failures -- because
  // EffectivePolicyValue is a subtype of Policy, so widening a parameter
  // accepts everything that used to be passed. The barrier had no barrier,
  // which is the same gap found on NetworkAllowlist earlier.
  //
  // The directive below inverts the signal: it becomes TS2578 the moment the
  // expression stops failing, so widening the parameter breaks `pnpm check`.
  // Kept off the hot path in a function nobody calls, because a suppression
  // silences the checker without stopping the code from running.
  const compileOnly = (ceiling: Policy): void => {
    // @ts-expect-error a deploy-time ceiling must not reach the asset filter
    allowedAssetPreferences(ceiling)
    // @ts-expect-error nor the top-up subset of it
    topupAssetPreferences(ceiling)
  }
  assert.equal(typeof compileOnly, 'function')

  // And the effective policy still works, so the pin is not just rejecting
  // everything.
  assert.ok(allowedAssetPreferences(asEffective(POLICY)).length > 0)
})
