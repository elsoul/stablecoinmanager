import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { refusalFor } from './refusal.ts'
import type { PolicyViolation } from '@/lib/policy'

/**
 * Source with comments removed.
 *
 * 🔴 Module scope, because BOTH guards below need it and only one of them had
 * it. A guard that cannot tell code from prose reports the warning as the
 * violation, and the natural repair is to stop writing the warning.
 *
 * That is not hypothetical here. The BACKSTOP had this and the REACH test did
 * not, ten lines apart in one file -- and adding two explanatory comments to
 * `result.ts`, changing no code, made the REACH test report `result.ts` as an
 * importer (251 pass / 1 fail, measured). The obvious repairs were to delete
 * the comment or to add a non-caller to the expected list, and the second one
 * disables the guard permanently: once a non-caller is expected, a real
 * import redirection hides behind it.
 *
 * Limits, since this file is about naming them: a bare `//` or `/*` inside a
 * string or template literal still hides the line after it. Measured in
 * wallet/derive.test.ts, which pins the cases.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const VIOLATIONS: PolicyViolation[] = [
  { kind: 'amount_over_daily', limit: 1, spentToday: 0, requested: 40 },
  { kind: 'network_not_allowed', allowed: ['eip155:8453'], requested: 'eip155:1' },
  { kind: 'asset_not_allowed', allowed: ['EURC'], requested: 'DAI' },
  { kind: 'payto_not_allowed', allowed: ['0xtreasury'], requested: '0xevil' },
]

const REQUIREMENT = { scheme: 'exact', network: 'eip155:1', asset: 'DAI' }

test('a daily refusal carries the whole result, not a prefix of it', () => {
  // 🔴 Three fixes in a row moved the decision one step out and
  // left the last step at the call site: the branch could compute and discard,
  // then compute the prose and not spread it, then
  // call the builder and slice its answer --
  // `refusalReasons(reservation).slice(0, 1)` left the suite green, because
  // the backstop's two assertions were both still satisfied.
  //
  // The whole ToolResult is built in one place now, so this test sees what a
  // caller sees.
  const result = refusalFor(
    {
      kind: 'over_daily_ceiling',
      spentTodayEurc: 0,
      limitEurc: 1,
      requestedEurc: 40,
      violations: VIOLATIONS,
    },
    REQUIREMENT,
  )

  assert.equal(result.ok, false)
  assert.equal(result.warnings.length, 4, `every cause: ${JSON.stringify(result.warnings)}`)
  assert.match(result.warnings[0] ?? '', /daily ceiling/, 'the daily line leads')
  assert.equal(
    result.warnings.filter((w) => /daily/i.test(w)).length,
    1,
    'and it is not printed twice',
  )
  for (const needle of ['eip155:1', 'DAI', '0xevil']) {
    assert.ok(
      result.warnings.some((w) => w.includes(needle)),
      `${needle} must survive into the prose`,
    )
  }
  assert.deepEqual(result.next, [
    'Wait for the UTC day to roll over, or raise POLICY_MAX_EURC_PER_DAY.',
  ])
  assert.deepEqual(result.data, {
    reservation: {
      kind: 'over_daily_ceiling',
      spentTodayEurc: 0,
      limitEurc: 1,
      requestedEurc: 40,
      violations: VIOLATIONS,
    },
  })
})

test('a policy refusal carries the whole result too, with its own next step', () => {
  const result = refusalFor({ kind: 'policy_violation', violations: VIOLATIONS }, REQUIREMENT)

  assert.equal(result.ok, false)
  assert.equal(result.warnings.length, 4)
  assert.doesNotMatch(result.warnings[0] ?? '', /daily ceiling; nothing was signed/)
  assert.deepEqual(result.next, [
    'policy_get will show the ceilings now in force; they may have been tightened mid-request.',
  ])
  assert.deepEqual(result.data, { requirement: REQUIREMENT, violations: VIOLATIONS })
})

test('control: one violation in, one warning out', () => {
  // Without this, the counts above are also satisfied by a builder that
  // always emits four.
  const one = refusalFor(
    { kind: 'policy_violation', violations: [VIOLATIONS[1] as PolicyViolation] },
    REQUIREMENT,
  )
  assert.equal(one.warnings.length, 1)
  assert.ok(one.warnings[0]?.includes('eip155:1'))
})

test('BACKSTOP: the refusing branches return the builder, whole', () => {
  // 🔴 A backstop, and it says so. The gate is that there is nothing left to
  // truncate: `refusalFor` returns the finished ToolResult and the tests
  // above drive it. This only reads the call sites, because node cannot load
  // x402Pay -- it reaches `cloudflare:workers` through policyFor -- and a
  // friendlier error here beats a silent divergence.
  //
  // What it CAN see, measured: spread-override
  // (`{ ...refusalFor(...), warnings: [] }`) reddens here, because the match
  // is anchored to end of statement. An earlier version of this comment said
  // the opposite while a control in the same commit proved otherwise.
  //
  // What it cannot see is below, in the Reach test.
  const source = readFileSync(join(import.meta.dirname, 'tools', 'x402Pay.ts'), 'utf8')
  const branch = (kind: string): string => {
    const start = source.indexOf(`reservation.kind === '${kind}'`)
    assert.notEqual(start, -1, `${kind} branch not found`)
    return code(source.slice(start, source.indexOf('\n  }', start)))
  }

  for (const kind of ['over_daily_ceiling', 'policy_violation']) {
    assert.match(
      branch(kind),
      /return refusalFor\(reservation, chosen\)\s*$/,
      `the ${kind} branch must return the builder's result unmodified`,
    )
    assert.doesNotMatch(branch(kind), /refusalReasons|describeViolation|fail\(/)
  }
})

test('REACH: the module these tests verify is the one production uses', () => {
  // 🔴 A different class from the assertions above, and the one that was
  // actually open. Those check that the branch does not modify what it gets;
  // none of them notice if the branch gets it from somewhere ELSE.
  //
  // Measured: pointing x402Pay's import at a same-shaped sibling that
  // truncates the reasons leaves 251 pass / 0 fail, and a local shim with
  // this name does the same. That is worse than a missed
  // mutation -- this file would keep verifying a module nobody calls, green
  // forever, which is the orphaned-test shape `chain/swap.ts` carries a pin
  // for as well.
  //
  // 🔴 Honest about what this is: a text pin on an import line, closing two
  // measured spellings. A third can be invented. It is here because the
  // Reach question -- "is the tested module the used one?" -- has no other
  // answer while x402Pay cannot be loaded, and because an orphaned test is
  // the failure that looks most like success.
  const root = join(import.meta.dirname, '..', '..')
  const importers: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      // Any spelling that resolves to this module: a relative path ending in
      // `/refusal`, or the alias. Measured: an earlier version listed three
      // exact strings and a genuine caller one directory deeper
      // (`'../../refusal'`) passed unseen.
      if (/from\s+'(?:[./]*\/)?refusal'|from\s+'@\/route\/mcp\/refusal'/.test(code(readFileSync(full, 'utf8')))) {
        importers.push(full.slice(root.length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root)
  assert.deepEqual(
    importers,
    ['route/mcp/tools/x402Pay.ts'],
    'the production callers these tests stand in for, by the spellings above. ' +
      'If this fires: a caller disappeared (the tests are now orphaned -- find ' +
      'where the refusal is built instead), or a caller appeared (extend the ' +
      'BACKSTOP above to it, then add it here). Adding a NON-caller here ' +
      'disables the guard.',
  )
})
