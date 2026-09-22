/**
 * The reservation decision, as a pure function.
 *
 * It lives outside `do/walletLedger.ts` because that file imports
 * `cloudflare:workers`, which only workerd resolves — anything defined there
 * can be exercised only by re-implementing it in a test, and a copy in a test
 * proves the copy works. `claimExportThrottle`/`throttleIsLive` set this
 * precedent; this follows it.
 */

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
  | { kind: 'reserve' }
  /**
   * This idempotency key was used before. The caller must NOT sign again;
   * it returns the earlier receipt instead. This is what makes a retried
   * tool call safe.
   */
  | { kind: 'replay'; row: PaymentRow }
  | { kind: 'over_daily_ceiling'; spentTodayEurc: number; limitEurc: number; requestedEurc: number }
  | { kind: 'amount_not_finite'; requestedEurc: number }

export function reserveDecision(input: {
  existing: PaymentRow | undefined
  spentTodayEurc: number
  amountEurc: number
  dailyCeilingEurc: number
}): ReserveOutcome {
  // Replay wins over every other answer. A caller retrying after a timeout
  // must get its receipt back even if the ceiling has since been reached --
  // refusing here would make an already-paid call look unpaid.
  if (input.existing !== undefined) return { kind: 'replay', row: input.existing }

  if (!Number.isFinite(input.amountEurc) || input.amountEurc <= 0) {
    return { kind: 'amount_not_finite', requestedEurc: input.amountEurc }
  }

  // Non-finite stored totals fail CLOSED: an unreadable ledger total must not
  // read as "nothing spent today".
  const spent = Number.isFinite(input.spentTodayEurc) ? input.spentTodayEurc : Number.POSITIVE_INFINITY
  const limit = Number.isFinite(input.dailyCeilingEurc) ? input.dailyCeilingEurc : 0

  if (spent + input.amountEurc > limit) {
    return {
      kind: 'over_daily_ceiling',
      spentTodayEurc: spent,
      limitEurc: limit,
      requestedEurc: input.amountEurc,
    }
  }
  return { kind: 'reserve' }
}
