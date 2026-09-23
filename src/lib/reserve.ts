/**
 * The reservation decision, as a pure function.
 *
 * It lives outside `do/walletLedger.ts` because that file imports
 * `cloudflare:workers`, which only workerd resolves — anything defined there
 * can be exercised only by re-implementing it in a test, and a copy in a test
 * proves the copy works. `claimExportThrottle`/`throttleIsLive` set this
 * precedent; this follows it.
 */
import {
  checkPayment,
  describeViolation,
  type EffectivePolicyValue,
  type PaymentIntent,
  type Policy,
  type PolicyViolation,
} from './policy'
import { composePolicy } from './effectivePolicy'
import { networkAllowlist } from './networks'

export interface PaymentRow {
  idempotency_key?: unknown
  status?: unknown
  tx_hash?: unknown
  invoice_number?: unknown
  amount_atomic?: unknown
  [column: string]: unknown
}

export type ReserveOutcome =
  /** Caller may sign. A `pending` row now exists. */
  | { kind: 'reserve'; amountEurc: number }
  /**
   * This idempotency key was used before. The caller must NOT sign again;
   * it returns the earlier receipt instead. This is what makes a retried
   * tool call safe.
   */
  | { kind: 'replay'; row: PaymentRow }
  | {
    kind: 'over_daily_ceiling'
    spentTodayEurc: number
    limitEurc: number
    requestedEurc: number
    /**
     * Every violation found, not just the daily one. The caller prints the
     * daily numbers because its guidance for them is specific, but a payment
     * that is over the daily ceiling AND on a disallowed network used to
     * report only the first -- so fixing what the message named left the
     * payment still refused, for a reason the caller was never told
     * (steiner N-6, #14067).
     */
    violations: PolicyViolation[]
  }
  | { kind: 'amount_not_finite'; requestedEurc: number }
  /**
   * The effective policy, composed INSIDE the reservation's turn, refuses
   * this payment. Distinct from `over_daily_ceiling` because it carries the
   * whole violation list, including the ceilings that are not about "how
   * much" -- network, asset, payee, slippage, deadline.
   */
  | { kind: 'policy_violation'; violations: PolicyViolation[] }

/**
 * 🔴 The WHOLE reservation decision, policy included, as one pure function.
 *
 * It used to answer replay / amount / daily here and leave the policy check
 * inside the Durable Object. That put a decision somewhere node cannot load,
 * and a decision node cannot execute can only be pinned as text -- the defect
 * `lib/settle.ts` exists to undo, arriving again.
 *
 * It matters because of the specific way that one fails. Deleting the check
 * is caught by a source pin; NEUTERING it is not. Composing the fresh policy,
 * running `checkPayment`, and then ignoring the result left 237 tests green
 * with the window reopened on every ceiling (steiner B-2, #14067). There is
 * nothing to neuter now: the caller receives an outcome and the tests below
 * drive this function directly.
 */
/**
 * The exact SELECT the ledger runs to read its overrides.
 *
 * Shared with the test so the executable check below reads what production
 * reads, rather than a re-typed query that agrees with it today.
 */
export const OVERRIDE_ROWS_SQL = `SELECT name, value FROM policy_overrides`

/**
 * The ledger's effective policy: run the query, compose what comes back.
 *
 * 🔴 It takes the EXECUTOR rather than the rows, so the query and the use of
 * its result are one unit that a test can drive. Handing rows in left the
 * pairing in the Durable Object, where `policyFromOverrideRows(ceiling, [])`
 * kept every token a source pin looks for while discarding what it read --
 * measured at 238 pass, 0 red (gilgamesh R2-N1, #14067).
 *
 * What remains reachable, stated: a caller can still pass a selector that
 * returns nothing. That is one deliberate lambda rather than a dropped
 * argument, and the source pin on the ledger covers it. This is as far as an
 * in-process boundary goes when the module under guard cannot be loaded by
 * the test runner.
 */
export function policyFromLedger(
  ceiling: Policy,
  select: (query: string) => readonly { name: string; value: string }[],
): EffectivePolicyValue {
  return policyFromOverrideRows(ceiling, select(OVERRIDE_ROWS_SQL))
}

/** Rows from OVERRIDE_ROWS_SQL, composed onto the deploy-time ceiling. */
export function policyFromOverrideRows(
  ceiling: Policy,
  rows: readonly { name: string; value: string }[],
): EffectivePolicyValue {
  return composePolicy(ceiling, Object.fromEntries(rows.map((r) => [r.name, r.value]))).effective
}

/**
 * The refusal used when deploy-time config is PRESENT AND UNUSABLE.
 *
 * Zeroed amounts and empty allowlists, so a broken ceiling refuses every
 * payment instead of falling back to something permissive.
 *
 * 🔴 Scope, corrected. Three places in this PR said this fires when the
 * worker "cannot read POLICY_*". Measured: it does not. `loadPolicy({})`
 * returns the BUILT-IN DEFAULTS and does not throw -- `numberVar` and
 * `listVar` both `return fallback` on `undefined`, deliberately, and
 * `policy.test.ts` pins that behaviour by name. `loadPolicy` throws only when
 * a var is present and unusable ('NaN', 'Infinity', '1e999', ''), and only
 * then does the ledger land here (cyan B-2, #14067).
 *
 * The difference is not academic. The shipped `[vars]` are byte-identical to
 * the built-in defaults, so a worker that reads no vars at all behaves
 * exactly like one that reads them -- which is why "exercise the happy path
 * once after deploy" was recorded as the check and cannot detect what it was
 * written to detect. The test alongside this one pins that equality, so the
 * trap is visible rather than remembered.
 */
export function refuseEverything(): EffectivePolicyValue {
  return policyFromOverrideRows(
    {
      allowedPayTo: '',
      allowAnyPayTo: false,
      allowedNetworks: networkAllowlist([]),
      allowedAssets: [],
      maxEurcPerPayment: 0,
      maxEurcPerDay: 0,
      maxSlippageBps: 0,
      maxDeadlineSeconds: 0,
    },
    [],
  )
}

/**
 * Every reason a refusal carries, as prose, for both refusing outcomes.
 *
 * 🔴 It is a FUNCTION rather than two expressions at the call sites because
 * the pin on "both branches name every cause" was a grep for
 * `describeViolation`, and a grep is satisfied by a branch that computes the
 * list and drops it. Measured: deleting the `...others` spread while leaving
 * the computation left 247 pass / 0 fail (cyan N-1, #14074) -- the same
 * "text pins lose" shape this package demoted its other greps for.
 *
 * Now the list is built where node can drive it, so a branch that stops
 * naming a cause has to change tested code.
 *
 * Order: the daily line first when there is one, because its guidance is
 * specific ("wait for the UTC day to roll over"), then the rest. A caller
 * that fixes only what the first line names and retries learns nothing the
 * second time if the rest were dropped.
 */
export function refusalReasons(
  outcome: Extract<ReserveOutcome, { kind: 'over_daily_ceiling' } | { kind: 'policy_violation' }>,
): string[] {
  if (outcome.kind === 'policy_violation') return outcome.violations.map(describeViolation)
  const daily =
    `today's total would reach ${outcome.spentTodayEurc + outcome.requestedEurc} EURC, ` +
    `over the ${outcome.limitEurc} EURC daily ceiling; nothing was signed`
  return [
    daily,
    ...outcome.violations.filter((v) => v.kind !== 'amount_over_daily').map(describeViolation),
  ]
}

export function reserveDecision(input: {
  existing: PaymentRow | undefined
  spentTodayEurc: number
  policy: EffectivePolicyValue
  /**
   * 🔴 The single source of the amount. It used to arrive twice -- once as
   * `amountEurc` and once inside the intent -- and two descriptions of one
   * payment is how the ceiling check and the ledger row come to disagree.
   * The approved number is returned with the approval so the row records
   * exactly what was checked.
   */
  intent: PaymentIntent
}): ReserveOutcome {
  // Replay wins over every other answer. A caller retrying after a timeout
  // must get its receipt back even if the ceiling has since been reached --
  // refusing here would make an already-paid call look unpaid.
  if (input.existing !== undefined) return { kind: 'replay', row: input.existing }

  const amountEurc = Number(input.intent.amountEurcEquivalent)
  if (!Number.isFinite(amountEurc) || amountEurc <= 0) {
    return { kind: 'amount_not_finite', requestedEurc: amountEurc }
  }

  // Non-finite stored totals fail CLOSED: an unreadable ledger total must not
  // read as "nothing spent today".
  const spent = Number.isFinite(input.spentTodayEurc)
    ? input.spentTodayEurc
    : Number.POSITIVE_INFINITY

  // One check, against the policy the caller composed in this same turn.
  const violations = checkPayment(input.policy, input.intent, spent)

  // The daily ceiling keeps its own outcome: the caller's guidance for it
  // ("wait for the UTC day to roll over") is specific, and the numbers it
  // prints come from here. Everything else travels as a violation list.
  const daily = violations.find((v) => v.kind === 'amount_over_daily')
  if (daily !== undefined) {
    return {
      kind: 'over_daily_ceiling',
      spentTodayEurc: daily.spentToday,
      limitEurc: daily.limit,
      requestedEurc: daily.requested,
      violations,
    }
  }
  if (violations.length > 0) return { kind: 'policy_violation', violations }

  return { kind: 'reserve', amountEurc }
}
