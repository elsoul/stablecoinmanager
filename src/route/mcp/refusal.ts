/**
 * The complete refusal a reservation produces, as one value.
 *
 * 🔴 FOURTH attempt at one shape, so the history is worth keeping short and
 * exact:
 *
 *   1. PR-4 B-2 -- the reservation could COMPUTE a refusal and ignore it.
 *      Closed by moving the decision into `reserveDecision`.
 *   2. #14074 N-1 -- the branch could COMPUTE the prose and not spread it.
 *      Closed by moving the prose into `refusalReasons`.
 *   3. #14077 (cyan) -- the branch could CALL `refusalReasons` and truncate
 *      it: `refusalReasons(reservation).slice(0, 1)` satisfies both backstop
 *      assertions and leaves 248 pass / 0 fail. Measured.
 *
 * Each fix moved the decision one step further out and left the last step at
 * the call site, where node cannot reach it -- `x402Pay` imports
 * `cloudflare:workers` through `policyFor`, so the only guard there is a text
 * pin, and a text pin loses to the next spelling. Three spellings so far, all
 * of them found by a reviewer rather than by the guard.
 *
 * So the whole ToolResult is built here. The branch has one expression to
 * return and nothing left to slice, filter or replace.
 *
 * 🔴 What is still reachable, MEASURED rather than guessed. An earlier
 * version of this paragraph named spread-override
 * (`{ ...refusalFor(...), warnings: [] }`) as the surviving gap. It is not:
 * the backstop anchors the branch to `return refusalFor(reservation, chosen)`
 * at end of statement, and the mutation reddens (cyan, #14077 -- and the
 * claim contradicted a control in its own commit, which is the same defect
 * this branch corrected one commit earlier).
 *
 * What was open and is now CLOSED (both were measured at 251 pass / 0 fail
 * before the Reach guard in refusal.test.ts, and redden after it):
 *
 *   - Pointing the import at a same-shaped sibling module. The branch guard
 *     reads inside the branch, not the import line. Worse than a missed
 *     mutation: `refusal.test.ts` then goes on verifying a module nobody
 *     uses -- an orphaned test, green forever.
 *   - A local shim with this name in x402Pay itself, for the same reason.
 *
 * What remains open: the Reach guard closes those two AS SPELLED, and a third
 * spelling can be invented -- keeping the import under an alias and shadowing
 * the name is measured to pass. That is where this stops: x402Pay imports
 * `cloudflare:workers` through `policyFor`, so a call-site guard is a text
 * pin by construction, and four spellings in a row have taught what chasing
 * the next one is worth. The decision itself is out of reach of all of them.
 */
import { fail, type ToolResult } from './result'
import { refusalReasons, type ReserveOutcome } from '@/lib/reserve'

type RefusingOutcome = Extract<
  ReserveOutcome,
  { kind: 'over_daily_ceiling' } | { kind: 'policy_violation' }
>

/**
 * `next` differs between the two, because the actions differ: a daily ceiling
 * clears by waiting, a tightened policy by reading what is now in force.
 */
const NEXT: Record<RefusingOutcome['kind'], string[]> = {
  over_daily_ceiling: ['Wait for the UTC day to roll over, or raise POLICY_MAX_EURC_PER_DAY.'],
  policy_violation: [
    'policy_get will show the ceilings now in force; they may have been tightened mid-request.',
  ],
}

export function refusalFor(outcome: RefusingOutcome, requirement: unknown): ToolResult {
  const data = outcome.kind === 'policy_violation'
    ? { requirement, violations: outcome.violations }
    : { reservation: outcome }
  return fail(data, NEXT[outcome.kind], refusalReasons(outcome))
}
