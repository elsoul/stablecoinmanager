import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACCEPTED_STATUSES, settleOutcome } from './settle.ts'

// ---------------------------------------------------------------------------
// Executed over the input space, not pinned as text.
//
// The same fail-open -- a transaction hash deciding acceptance -- was
// re-introduced three times, each in a shape the previous pin did not cover
// (see lib/settle.ts), because the decision was inline in a module node
// cannot load. Here it is arithmetic on three inputs and the whole grid is
// checked.
// ---------------------------------------------------------------------------

const STATUSES = [200, 201, 202, 204, 400, 402, 404, 409, 422, 500, 502]
const BODY = [undefined, 'granted', 'pending', 'stuck', 'unknown']
const HASHES = [undefined, '', '0xabc']

test('🔴 a hash NEVER decides acceptance, at any status or body', () => {
  // The invariant all three re-introductions broke. For every combination,
  // the answer with a hash equals the answer without one.
  for (const httpStatus of STATUSES) {
    for (const bodyStatus of BODY) {
      const withHash = settleOutcome({ httpStatus, bodyStatus, txHash: '0xabc' })
      const without = settleOutcome({ httpStatus, bodyStatus })
      assert.deepEqual(
        withHash,
        without,
        `hash changed the outcome at ${httpStatus}/${bodyStatus}`,
      )
    }
  }
})

test('acceptance is exactly the three rail statuses', () => {
  // 🔴 The expectation is written out, NOT derived from ACCEPTED_STATUSES.
  // Deriving it made both sides move together: removing 409 from the constant
  // left this green while the behaviour changed from accepted to refused. A
  // test whose expectation is computed from the thing under test cannot
  // disagree with it.
  const ACCEPTED = new Set([200, 202, 409])
  for (const httpStatus of STATUSES) {
    for (const txHash of HASHES) {
      assert.equal(
        settleOutcome({ httpStatus, txHash }).accepted,
        ACCEPTED.has(httpStatus),
        `${httpStatus} acceptance`,
      )
    }
  }

  // And the exported constant must agree with that written-out set, so the
  // two cannot drift apart silently in either direction.
  assert.deepEqual([...ACCEPTED_STATUSES].sort(), [...ACCEPTED].sort())
})

test("🔴 'failed' is reachable ONLY from a repeated 402", () => {
  // After a signed resend, claiming nothing happened requires evidence.
  for (const httpStatus of STATUSES) {
    for (const bodyStatus of BODY) {
      for (const txHash of HASHES) {
        const out = settleOutcome({ httpStatus, bodyStatus, txHash })
        if (out.status === 'failed') {
          assert.equal(httpStatus, 402, `failed at ${httpStatus}/${bodyStatus}`)
        }
      }
    }
  }
  assert.equal(settleOutcome({ httpStatus: 402 }).status, 'failed')
})

test('the ordinary success shape of a generic resource settles, not fails', () => {
  // 200 with content and no settle header: the case that was recorded as
  // `failed` and went uncounted against the daily ceiling.
  const out = settleOutcome({ httpStatus: 200 })
  assert.equal(out.accepted, true)
  assert.equal(out.status, 'pending')
  assert.notEqual(out.status, 'failed')
})

test('the rail status map', () => {
  assert.equal(settleOutcome({ httpStatus: 200, bodyStatus: 'granted' }).status, 'settled')
  assert.equal(settleOutcome({ httpStatus: 202, bodyStatus: 'pending' }).status, 'pending')
  assert.equal(settleOutcome({ httpStatus: 409 }).status, 'stuck')
  assert.equal(settleOutcome({ httpStatus: 200, bodyStatus: 'stuck' }).status, 'stuck')
})

test('every non-accepted answer that is not a 402 is stuck', () => {
  for (const httpStatus of STATUSES.filter((s) => s !== 402 && !ACCEPTED_STATUSES.includes(s as never))) {
    assert.equal(settleOutcome({ httpStatus }).status, 'stuck', `${httpStatus}`)
  }
})

test('control: the grid is not vacuously satisfied', () => {
  // Every status value the function can return must actually occur, or the
  // sweeps above could be passing over a collapsed range.
  const seen = new Set<string>()
  for (const httpStatus of STATUSES) {
    for (const bodyStatus of BODY) {
      seen.add(settleOutcome({ httpStatus, bodyStatus }).status)
    }
  }
  assert.deepEqual([...seen].sort(), ['failed', 'pending', 'settled', 'stuck'])
})
