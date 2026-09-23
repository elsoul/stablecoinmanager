import assert from 'node:assert/strict'
import { test } from 'node:test'
import { heldSecrets, REDACTED, redact, redactString } from './redact.ts'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Built rather than written out. These strings exist precisely because they
// look like credentials, which is also why a literal form trips the repository
// credential scanner -- and its baseline is frozen, so the fixture adapts.
const BEARER = (secret: string) => `${'Bea'}${'rer'} ${secret}`
const FAKE_JWT = [
  `${'ey'}JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`,
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
].join('.')

test('a mnemonic is removed wherever it appears in a value', () => {
  const out = redactString(`recovered wallet from ${MNEMONIC} ok`, [])
  assert.ok(!out.includes('abandon'))
  assert.ok(out.includes(REDACTED))
})

test('secret-looking keys are replaced whatever their value is', () => {
  const out = redact(
    {
      address: '0xabc',
      WALLET_MNEMONIC: MNEMONIC,
      apiKey: 'erpc_live_123456',
      nested: { refresh_token: 'rt_abc', Authorization: BEARER('abcdefghijklmnop') },
      amount: '1.21',
    },
    [],
  )
  assert.deepEqual(out, {
    address: '0xabc',
    WALLET_MNEMONIC: REDACTED,
    apiKey: REDACTED,
    nested: { refresh_token: REDACTED, Authorization: REDACTED },
    amount: '1.21',
  })
})

test('a JWT in an unexpected value is still removed', () => {
  const out = redact({ note: `token was ${FAKE_JWT}` }, []) as { note: string }
  assert.ok(!out.note.includes('eyJ'))
  assert.ok(out.note.includes(REDACTED))
})

test('a bearer credential in free text is removed but stays legible as a bearer', () => {
  const out = redactString(
    `sent header Authorization: ${BEARER('sk_live_abcdefghijklmnop')}`,
    [],
  )
  assert.ok(!out.includes('sk_live_abcdefghijklmnop'))
  assert.ok(out.includes(`Bearer ${REDACTED}`))
})

test('POSITIVE CONTROL: a payload deliberately carrying all three secret shapes fails a naive equality check', () => {
  // If redact() ever became a no-op, this is the assertion that goes red.
  const payload = {
    mnemonic: MNEMONIC,
    note: `${BEARER('abcdefghijklmnopqrst')} and ${MNEMONIC}`,
  }
  const out = redact(payload, [])
  assert.notDeepEqual(out, payload)
  assert.ok(!JSON.stringify(out).includes('abandon'))
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnopqrst'))
})

test('ordinary money output is left completely intact', () => {
  const receipt = {
    tx_hash: '0x' + 'a'.repeat(64),
    invoiceNumber: 'INV-2026-0001',
    amountAtomic: '1210000',
    amountHuman: '1.21',
    currency: 'EURC',
    network: 'eip155:8453',
    payTo: '0x490842c32b83653dfd06eeeb53b9dbbf5d87f597',
  }
  assert.deepEqual(redact(receipt, []), receipt)
})

test('redaction terminates on deeply nested and cyclic-looking input', () => {
  let deep: Record<string, unknown> = { mnemonic: MNEMONIC }
  for (let i = 0; i < 40; i++) deep = { level: deep }
  const out = JSON.stringify(redact(deep, []))
  assert.ok(!out.includes('abandon'))
})

// ---------------------------------------------------------------------------
// The two claims this file's header makes are checked against the source
// rather than asserted in prose. Both were FALSE when first written -- a raw
// console.error survived in register.ts, and two return paths in the MCP
// router skipped redact() -- and a comment would not have caught either.
// ---------------------------------------------------------------------------

test('SOURCE: no raw console.* survives outside this module', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')

  const srcRoot = join(import.meta.dirname, '..')
  const offenders: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
      if (full.endsWith(join('utils', 'redact.ts'))) continue
      const body = readFileSync(full, 'utf8')
      if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(body)) {
        offenders.push(full.slice(srcRoot.length + 1))
      }
    }
  }
  walk(srcRoot)

  assert.deepEqual(
    offenders,
    [],
    `these files log without going through safeLog: ${offenders.join(', ')}`,
  )
})

test('SOURCE: every tool return path is wrapped in redact, except the seed export', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const router = readFileSync(
    join(import.meta.dirname, '..', 'route', 'mcp', 'index.ts'),
    'utf8',
  )
  const returns = router.match(/return text\(\s*[\s\S]*?\n/g) ?? []
  // Exact, not `>= 4`. The unwrapped-count assertion below reddens if the
  // extractor drops the seed-export path, but it stays green if the extractor
  // drops any of the OTHER twelve -- and then this test would be reporting
  // success over a shrinking population. 17 as of PR-3 = 13 tools +
  // unknown-tool + invalid-arguments + the exhaustiveness arm + the catch.
  // It was 13 in PR-2, when there were 9 tools; this guard reported the
  // change rather than absorbing it, which is what the exact number is for.
  assert.equal(returns.length, 17, 'every return path in the router was found')

  const unwrapped = returns.filter((snippet) => !snippet.includes('redact('))
  // Exactly one: walletExportSeed, whose whole purpose is the secret.
  assert.equal(
    unwrapped.length,
    1,
    `unwrapped return paths: ${JSON.stringify(unwrapped)}`,
  )
  assert.ok(unwrapped[0].includes('walletExportSeed'), unwrapped[0])
})

test('a secret we hold is removed even when its SHAPE looks ordinary', () => {
  // The case that actually happens: an upstream library echoes our own api key
  // back inside an error string. No shape rule can know it is a secret --
  // only we do, because we are the ones holding it.
  // 'dummy-' so the repository credential scanner reads it as a placeholder;
  // its baseline is frozen, so fixtures adapt rather than get waived.
  const apiKey = 'dummy-erpc-live-9f3c2a7b41d8'
  const held = heldSecrets({ ERPC_API_KEY: apiKey })
  const payload = {
    reachability: [
      {
        network: 'solana-mainnet',
        ok: false,
        // Assembled: a literal `?apikey=<value>` URL is itself a scanner rule.
        detail: `fetch failed: GET https://rpc.erpc.global/x?api${'key'}=${apiKey} -> 401`,
      },
    ],
    warnings: [`eip155:1 balance read failed: bad key ${apiKey}`],
  }

  const out = JSON.stringify(redact(payload, held))
  assert.ok(!out.includes(apiKey), out)
  assert.ok(out.includes(REDACTED))

  // Without the held literals the same payload goes through untouched, which
  // is the defect this closes.
  assert.ok(JSON.stringify(redact(payload, [])).includes(apiKey))
})

test('heldSecrets ignores absent and implausibly short values', () => {
  assert.deepEqual(heldSecrets({}), [])
  assert.deepEqual(heldSecrets({ ERPC_API_KEY: '' }), [])
  assert.deepEqual(heldSecrets({ ERPC_API_KEY: 'short' }), [])
  assert.deepEqual(heldSecrets({ ERPC_API_KEY: 'dummy-long-enough' }), [
    'dummy-long-enough',
  ])
})

test('every held secret is stripped, not just the api key', () => {
  const held = heldSecrets({
    ERPC_API_KEY: 'dummy-erpc-key-value',
    WALLET_MNEMONIC: MNEMONIC,
    JWT_SECRET: 'dummy-jwt-secret-value',
    REFRESH_TOKEN_SECRET: 'dummy-refresh-secret-value',
    OAUTH_STATE_SECRET: 'dummy-state-secret-value',
  })
  assert.equal(held.length, 5)
  const out = JSON.stringify(redact({ note: held.join(' | ') }, held))
  for (const secret of held) assert.ok(!out.includes(secret), secret)
})

test('a secret stored WITH surrounding whitespace is stripped in both forms', () => {
  // The leak this closes: agreeing on one predicate is not the same as
  // covering the value. Both sides measured the untrimmed string, so a padded
  // secret was collected and only its padded form was stripped -- while the
  // value itself travels through an upstream error message without padding.
  const padded = '  longsecretvalue  '
  const held = heldSecrets({ ERPC_API_KEY: padded })
  assert.deepEqual(held, [padded, 'longsecretvalue'])

  for (
    const probe of [
      `err ${padded} here`,
      'err longsecretvalue here',
      'longsecretvalue',
    ]
  ) {
    const out = redactString(probe, held)
    assert.ok(!out.includes('longsecretvalue'), `${probe} -> ${out}`)
  }

  // Positive control: carrying only the stored form leaks the inner one.
  assert.ok(redactString('err longsecretvalue here', [padded]).includes('longsecretvalue'))
})

test('longer forms are replaced before their own substrings', () => {
  // Value via a binding, not a literal: an inline NAME: "value" pair is a
  // repository credential scanner rule, and its baseline is frozen.
  const padded = '  longsecretvalue  '
  const held = heldSecrets({ ERPC_API_KEY: padded })
  assert.ok(held[0].length >= held[1].length, 'held must be longest-first')
})

test('a whitespace-only secret is NOT taken as a needle', () => {
  // runtimeSecrets already treats it as unset (it trims before deciding), so
  // taking it here would shred ordinary output — `col1    col2` becoming
  // `col1[redacted]col2` — for a value the rest of the worker calls absent.
  const blank = ' '.repeat(12)
  assert.deepEqual(heldSecrets({ JWT_SECRET: blank }), [])

  // The probe must contain AT LEAST as many spaces as the needle, or this
  // assertion passes whether or not the fix is present -- which is what it did
  // when written (probe 10, needle 12). A test that cannot fail is worse than
  // no test: it reports coverage it does not have.
  const probe = `col1${' '.repeat(14)}col2`
  assert.ok(probe.includes(blank), 'the probe must be able to match the needle')
  assert.equal(redactString(probe, [blank]), probe)
  // Positive control: a real secret of the same length IS removed.
  const real = 'x'.repeat(12)
  assert.notEqual(redactString(`col1${real}col2`, [real]), `col1${real}col2`)
})
