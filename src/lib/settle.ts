/**
 * What happened to a signed payment, as a pure function.
 *
 * 🔴 This exists because of how the same defect kept coming back. The
 * post-resend decision lived inline in x402Pay, where `cloudflare:workers` in
 * its import graph makes the module unloadable under `node --test`, so the
 * only available guard was a source-shape assertion. Three separate
 * re-introductions of one fail-open were found that way, each needing its own
 * textual pin:
 *
 *   - requiring a hash for acceptance
 *   - appending `&& Boolean(txHash)`
 *   - narrowing `if (!accepted)` instead
 *
 * Pinning text is a losing game: every pin covers the shapes someone thought
 * of. The decision is arithmetic on three inputs, so it belongs somewhere it
 * can be executed against all of them.
 *
 * The rule: after a signed payment has been transmitted,
 * the ledger may claim nothing happened ONLY with evidence, and the only
 * evidence is the resource asking for payment again.
 */

/** Statuses the resource uses to say it took the payment. */
export const ACCEPTED_STATUSES = [200, 202, 409] as const

export type LedgerStatus = 'settled' | 'pending' | 'failed' | 'stuck'

export interface SettleOutcome {
  readonly accepted: boolean
  readonly status: LedgerStatus
  /** True only when the resource re-issued a 402. */
  readonly stillAsking: boolean
}

export function settleOutcome(input: {
  httpStatus: number
  bodyStatus?: string
  txHash?: string
}): SettleOutcome {
  const accepted = (ACCEPTED_STATUSES as readonly number[]).includes(input.httpStatus)

  if (!accepted) {
    // 402 again means ours was not consumed. Anything else: we signed, we
    // sent, and we cannot show the money stayed put -- `stuck`, which the
    // daily ceiling counts.
    const stillAsking = input.httpStatus === 402
    return { accepted: false, stillAsking, status: stillAsking ? 'failed' : 'stuck' }
  }

  // 🔴 A transaction hash is a better receipt, NOT a precondition. Requiring
  // one here is the fail-open that kept coming back: a generic x402 resource
  // answers success with content and no settle header, and treating that as a
  // refusal records a completed payment as `failed`, uncounted against the
  // ceiling.
  if (input.bodyStatus === 'granted') {
    return { accepted: true, stillAsking: false, status: 'settled' }
  }
  if (input.bodyStatus === 'stuck' || input.httpStatus === 409) {
    return { accepted: true, stillAsking: false, status: 'stuck' }
  }
  return { accepted: true, stillAsking: false, status: 'pending' }
}
