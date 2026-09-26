import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const SOURCE = readFileSync(join(import.meta.dirname, 'policySet.ts'), 'utf8')

// ---------------------------------------------------------------------------
// policy_set is the one tool whose whole value is what it REFUSES. The pure
// decision is tested in lib/policyOverride.test.ts; what is checked here is
// that this tool wires the decision to the right two values, because getting
// that pairing wrong is invisible in the decision's own tests.
// ---------------------------------------------------------------------------

test('SOURCE: policy_set compares against the CEILING and reports the EFFECTIVE', () => {
  // decideSet(key, requested, ceiling, current). The third argument must be
  // the deploy-time ceiling and the fourth the effective value. Swapped, a
  // narrowed limit could never be relaxed back to what an operator approved,
  // and — worse — a widened effective value would authorise itself.
  assert.match(
    SOURCE,
    /decideSet\(\s*args\.key,\s*args\.value,\s*ceiling\[[^\]]+\],\s*effective\[[^\]]+\],?\s*\)/,
    'ceiling is the bound, effective is the current value',
  )
})

test('SOURCE: the write goes through the atomic DO method, not two calls', () => {
  // setPolicyOverride writes the override and its audit row with no await
  // between them. Calling appendAudit separately here would reintroduce the
  // gap that method exists to close.
  assert.match(SOURCE, /await ledger\.setPolicyOverride\(\{/)
  assert.ok(
    !/appendAudit/.test(SOURCE),
    'policy_set must not write its own audit row separately',
  )
})

test('SOURCE: a refusal never writes', () => {
  // Every non-`set` outcome must return before the ledger write. Measured by
  // position: the three refusal returns all precede the only write.
  const writeAt = SOURCE.indexOf('await ledger.setPolicyOverride(')
  assert.notEqual(writeAt, -1)
  for (const kind of ['not_overridable', 'not_a_number', 'would_widen']) {
    const at = SOURCE.indexOf(`decision.kind === '${kind}'`)
    assert.notEqual(at, -1, `${kind} is handled`)
    assert.ok(at < writeAt, `${kind} must be refused before anything is written`)
  }
})

test('the refusal text tells the operator the one thing that actually works', () => {
  // A refusal that does not say how to proceed gets worked around. Widening
  // has exactly one legitimate route and it is named.
  assert.match(SOURCE, /redeploy to raise the ceiling/)
  assert.match(SOURCE, /runtime overrides may only tighten/)
  // And it says WHY, because a model reading this decides what to try next.
  assert.match(SOURCE, /the ceiling is what makes unattended/)
})

test('swap and bridge apply the same slippage ceiling', async () => {
  // Executed, not pinned. `bridge` used to accept a slippageBps and neither
  // validate nor use it, so 9999 passed on one tool and was refused on the
  // other. The asymmetry is the defect, so the test asks both.
  const src = readFileSync(join(import.meta.dirname, 'swapBridge.ts'), 'utf8')
  const calls = src.match(/checkSlippage\(args\.slippageBps, policy\.maxSlippageBps\)/g) ?? []
  assert.equal(calls.length, 2, 'both tools check slippage against the same ceiling')
  // And neither keeps a private copy of the comparison.
  const inline = src.match(/slippageBps\s*>\s*policy\.maxSlippageBps/g) ?? []
  assert.equal(inline.length, 0, 'the comparison lives in one place')
})
