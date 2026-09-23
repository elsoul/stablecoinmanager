import type { Env } from '@/types/env'
import { deriveAddresses, deriveEvmSigner } from '@/wallet/keys'
import { checkPayment, describeViolation } from '@/lib/policy'
import { effectivePolicy } from '../policyFor'
import {
  allowedAssetPreferences,
  ASSET_DECIMALS,
  EURC_BASE,
  USDC_BASE,
} from '@/lib/assets'
import { BASE_NETWORK, type AssetPreference } from '@/lib/x402'
import { BASE_EXPLORER_TX_BASE_URL } from '@constants/base'
import { atomicToDecimal, normalizeAccepts, selectRequirement } from '@/lib/x402'
import { probe, readSettle, signPayment } from '@/chain/x402Client'
import { LEDGER_INSTANCE_NAME, type WalletLedger } from '@/do/walletLedger'
import { settleOutcome } from '@/lib/settle'
import { fail, ok, type ToolResult } from '../result'
import { canonicalNetwork } from '@/lib/networks'

export interface PayArgs {
  url: string
  idempotencyKey: string
  method?: string
  body?: unknown
  headers?: Record<string, string>
  /**
   * Which (network, asset) pairs may be chosen, narrowest-first.
   *
   * Callers inside this worker pass it to enforce a constraint the POLICY does
   * not own -- erpc_topup passes EURC only, because top-ups are
   * EURC-denominated by a standing ruling. It is NOT part of the tool's input
   * schema: an MCP client cannot set it, so it can only ever narrow.
   */
  assetPreferences?: readonly AssetPreference[]
}

/**
 * Pay a 402.
 *
 * The order is the whole design:
 *
 *   probe -> normalize -> policy -> RESERVE (ledger row, `pending`) -> sign
 *   -> resend -> settle -> record
 *
 * Reserving before signing is deliberate. A signature that exists with no
 * ledger row is a payment the worker does not know it made; a row with no
 * signature is a reservation that can be reconciled or expire. Only the first
 * loses money. The reservation is also where the daily ceiling is enforced,
 * inside one Durable Object method, because checking and inserting separately
 * lets two payments interleave and both pass a ceiling only one fits under.
 *
 * `idempotencyKey` is required and is the replay key: calling again with the
 * same key returns the first receipt WITHOUT signing anything.
 */
export async function x402Pay(env: Env, args: PayArgs): Promise<ToolResult> {
  const addresses = deriveAddresses(env.WALLET_MNEMONIC ?? '')
  // 🔴 EFFECTIVE, not the deploy-time ceiling. A stored override that
  // tightens a limit has to bind here or `policy_set` is decorative in the
  // only place it matters (gilgamesh B1, #14054).
  const { effective: policy } = await effectivePolicy(env)
  const ledger = env.WALLET_LEDGER.get(
    env.WALLET_LEDGER.idFromName(LEDGER_INSTANCE_NAME),
  ) as unknown as WalletLedger

  // Replay check first: a retry must never re-probe and re-sign.
  //
  // The OUTCOME of the earlier attempt decides whether this is a success.
  // Returning ok for a row that says `failed` tells the caller "already paid"
  // about a payment that did not happen, and the key is spent either way, so
  // the caller cannot retry it. Reporting a failure as a success is worse
  // than the failure (steiner, #14018 B-3).
  const prior = await ledger.receipt(args.idempotencyKey)
  if (prior) {
    const priorStatus = String((prior as { status?: unknown }).status ?? 'unknown')
    const body = { replay: true, priorStatus, receipt: prior }
    if (priorStatus === 'failed') {
      return fail(body, [
        'Use a NEW idempotencyKey to attempt this payment again -- this one is spent.',
      ], [
        'this idempotencyKey was already used and its payment FAILED; nothing was signed now, and nothing was paid then',
      ])
    }
    if (priorStatus === 'stuck') {
      return fail(body, [
        `Check the payee on the explorer: the earlier attempt may have moved money.`,
        'Use a NEW idempotencyKey only after confirming the earlier one did not settle.',
      ], [
        'this idempotencyKey was already used and its outcome is UNKNOWN (stuck); nothing was signed now',
      ])
    }
    return ok(body, ['This idempotencyKey was already used; nothing was signed.'], [])
  }

  const challenge = await probe(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body,
  })
  if (challenge.status !== 402) {
    return fail(
      { status: challenge.status, body: challenge.body },
      ['Call x402_inspect to see what this resource actually returns.'],
      [`Expected 402, got ${challenge.status}; nothing was signed.`],
    )
  }

  const requirements = normalizeAccepts(
    ((challenge.body ?? {}) as { accepts?: unknown }).accepts,
  )
  const { chosen, reason } = selectRequirement(
    requirements,
    args.assetPreferences ?? allowedAssetPreferences(policy),
  )
  if (!chosen) {
    return fail({ requirements }, [], [reason ?? 'no payable requirement'])
  }

  // One intent object, checked twice: here to refuse before signing, and
  // again inside the reservation where it is authoritative. Two descriptions
  // of one payment is how the two checks would drift.
  const intent = {
    amountEurcEquivalent: atomicToDecimal(chosen.amountAtomic, ASSET_DECIMALS),
    network: chosen.network,
    asset: assetSymbol(chosen.asset),
    payTo: chosen.payTo,
    deadlineSeconds: chosen.maxTimeoutSeconds,
  }
  const violations = checkPayment(
    policy,
    intent,
    // The daily total is re-derived inside the reservation; this call only
    // needs the per-payment ceilings, so it passes 0 and lets the Durable
    // Object be the authority on what has been spent today.
    0,
  )
  if (violations.length > 0) {
    return fail(
      { requirement: chosen, violations },
      ['Pay a smaller amount. policy_set can only TIGHTEN a ceiling; raising one needs a redeploy.'],
      violations.map(describeViolation),
    )
  }

  const reservation = await ledger.reservePayment({
    idempotencyKey: args.idempotencyKey,
    network: chosen.network,
    asset: chosen.asset,
    amountAtomic: chosen.amountAtomic,
    payTo: chosen.payTo,
    resource: args.url,
    // No policy is passed: the ledger composes it in the same synchronous
    // turn as the reservation, so an override that lands while this request
    // is probing the resource binds to THIS payment (steiner N-11 #14054,
    // B-1 #14067).
    intent,
  })

  if (reservation.kind === 'replay') {
    return ok({ replay: true, receipt: reservation.row }, [
      'This idempotencyKey was already used; nothing was signed.',
    ])
  }
  if (reservation.kind === 'over_daily_ceiling') {
    return fail(
      { reservation },
      ['Wait for the UTC day to roll over, or raise POLICY_MAX_EURC_PER_DAY.'],
      [
        `today's total would reach ${
          reservation.spentTodayEurc + reservation.requestedEurc
        } EURC, over the ${reservation.limitEurc} EURC daily ceiling; nothing was signed`,
      ],
    )
  }
  if (reservation.kind === 'policy_violation') {
    // The ledger refused on a policy that changed while this request was in
    // flight. Nothing was signed: the refusal happens before the row is
    // inserted.
    return fail(
      { requirement: chosen, violations: reservation.violations },
      ['policy_get will show the ceilings now in force; they may have been tightened mid-request.'],
      reservation.violations.map(describeViolation),
    )
  }
  if (reservation.kind === 'amount_not_finite') {
    return fail({ reservation }, [], ['the quoted amount is not a usable number'])
  }

  // 🔴 Every refusal must be handled before this line, and the type says so.
  //
  // Deleting the policy_violation branch above compiled and left 237 tests
  // green, falling through to `signPayment` -- signing a payment the ledger
  // refused and did not record, which this file's own docblock names as the
  // one state that loses money. This PR added that variant; the branch that
  // handles it was one forgotten `if` away from never existing
  // (steiner B-2, #14067).
  //
  // Both directions are closed: a new variant is a compile error here, and
  // if one reaches this line at runtime anyway, nothing is signed.
  if (reservation.kind !== 'reserve') {
    const unhandled: never = reservation
    return fail({ reservation: unhandled }, [], [
      'the ledger refused this payment in a way this tool does not recognise; nothing was signed',
    ])
  }

  // From here a row exists in `pending`, and every exit below resolves it --
  // including the one that throws, which is why the resend is wrapped.
  let signed
  try {
    // The account is handed to a callback and never returned, so no value
    // here holds viem's HDAccount -- whose `getHdKey` is an own enumerable
    // key and a public accessor for the private key (gilgamesh P1, #14067).
    signed = await deriveEvmSigner(env.WALLET_MNEMONIC ?? '').withAccount((account) =>
      signPayment(
        account,
        { headers: challenge.headers, body: challenge.body },
        // 🔴 The requirement THIS WORKER chose, handed to the signer
        // explicitly. Without it the SDK signs `accepts[0]` while every check
        // above ran on `chosen` -- see chain/x402Client.ts.
        {
          scheme: chosen.scheme,
          network: chosen.network,
          asset: chosen.asset,
          amountAtomic: chosen.amountAtomic,
          payTo: chosen.payTo,
        },
      ),
    )
  } catch (error) {
    await ledger.settlePayment({ idempotencyKey: args.idempotencyKey, status: 'failed' })
    return fail({ requirement: chosen }, [], [
      `signing failed: ${error instanceof Error ? error.message : 'unknown'}`,
    ])
  }

  // The resend is the one call that can move money and then throw. A network
  // error here does NOT mean nothing happened: the facilitator may have
  // submitted the transaction and the response may have been lost. So the row
  // is marked `stuck` rather than `failed` -- `failed` claims knowledge we do
  // not have, and `stuck` counts toward the daily ceiling, so the uncertainty
  // is paid for out of today's budget rather than ignored.
  //
  // Without this the row stays `pending` forever on a throw, which is the exit
  // the comment above ("Every exit must resolve it") did not actually cover.
  let paid
  try {
    paid = await probe(args.url, {
      method: args.method,
      headers: { ...(args.headers ?? {}), 'X-Payment': signed.header },
      body: args.body,
    })
  } catch (error) {
    await ledger.settlePayment({ idempotencyKey: args.idempotencyKey, status: 'stuck' })
    return fail(
      { requirement: chosen, signedFrom: signed.from },
      [
        `Check ${chosen.payTo} on the explorer before retrying: a payment may have been submitted.`,
        'Retrying with the SAME idempotencyKey is safe -- it replays instead of signing again.',
      ],
      [
        `the payment was signed and sent, but the response was lost (${
          error instanceof Error ? error.message : 'unknown'
        }); the reservation was marked stuck, not failed, because it is not known whether the money moved`,
      ],
    )
  }
  const settle = readSettle(paid.headers)
  const paidBody = (paid.body ?? {}) as {
    transaction?: string
    status?: string
    invoiceNumber?: string
  }
  const txHash = paidBody.transaction ?? settle?.transaction

  // ---------------------------------------------------------------------
  // A signed payment has now been transmitted. Everything below is about
  // WHAT HAPPENED TO IT, and the only status that may claim nothing happened
  // is the one backed by evidence.
  //
  // `failed` after this point means the resource is STILL ASKING for payment
  // (another 402), which is positive evidence that ours was not consumed.
  // Every other non-acceptance is `stuck`: we signed, we sent, and we cannot
  // show the money stayed put. `stuck` counts toward the daily ceiling, so
  // the uncertainty is paid for out of today's budget.
  //
  // An earlier revision keyed this on the transaction hash alone. That fixed
  // "error status WITH a hash" and left its converse open: an ACCEPTED answer
  // with no hash — which is the ordinary success shape of a generic x402
  // resource, a 200 carrying content and no settle header — fell into the
  // refusal branch and was recorded `failed`, uncounted. A successful payment
  // that tells the ceiling it never happened is the same fail-open as
  // excluding `stuck`, reached from the other side (steiner, #14018 B-2).
  // ---------------------------------------------------------------------
  // 🔴 ONE decision, computed once, in a module that can be executed under
  // `node --test`. Three separate re-introductions of the same fail-open were
  // caught here by source-shape pins (B-2, C-1, O-3); lib/settle.ts replaces
  // those pins with a swept input grid. Nothing below re-derives acceptance.
  const outcome = settleOutcome({
    httpStatus: paid.status,
    bodyStatus: paidBody.status,
    txHash,
  })

  if (!outcome.accepted) {
    const stillAsking = outcome.stillAsking
    const settledStatus = outcome.status
    await ledger.settlePayment({
      idempotencyKey: args.idempotencyKey,
      status: settledStatus,
      txHash,
    })
    return fail(
      { status: paid.status, body: paid.body, signedFrom: signed.from, txHash },
      stillAsking
        ? [
          'The resource re-issued a 402, so it did not accept the payment.',
          'Call x402_inspect to see what it is asking for now.',
        ]
        : [
          txHash
            ? `A transaction hash came back (${txHash}) -- check it on the explorer before retrying.`
            : 'Check the payee on the explorer before retrying: a payment may have been submitted.',
          'Retrying with the SAME idempotencyKey replays instead of signing again.',
        ],
      [
        stillAsking
          ? `the resource answered 402 again, so the payment was not consumed; the reservation was marked failed`
          : `the resource returned ${paid.status}; the reservation was marked stuck, not failed, because a signed payment was sent and it is not known whether the money moved`,
      ],
    )
  }

  // Accepted. The status comes from the same decision as the refusal above.
  const settledStatus = outcome.status
  // The invoice number is read HERE, on the synchronous path, and not only by
  // the top-up poller. The rail answers a re-sent payment with 200 +
  // status:'granted' + invoiceNumber when the grant completes inline; that
  // path never enters erpc_topup's poll loop (its condition is
  // `status !== 'granted'`), so the poller had no second chance to record it.
  // With `settled` now terminal, there was no third chance either, and the
  // tool's promise to report an invoice number quietly did not hold for the
  // fastest, most ordinary outcome (steiner N-7, #14018).
  await ledger.settlePayment({
    idempotencyKey: args.idempotencyKey,
    status: settledStatus,
    txHash,
    invoiceNumber: paidBody.invoiceNumber,
  })

  return ok(
    {
      transaction: txHash,
      invoiceNumber: paidBody.invoiceNumber,
      // The status REPORTED is the status WRITTEN. They used to be computed
      // separately, and a 409 wrote `stuck` to the ledger while returning
      // 'pending' -- which erpc_topup then fed back into settlePayment,
      // demoting the stuck row to pending and losing the fact that the
      // outcome was unknown. No money moves either way (the daily total
      // counts both), but the record an operator reads was wrong, and a
      // wrong record is what someone acts on (cyan O-1, #14018).
      status: settledStatus,
      amount: {
        atomic: chosen.amountAtomic,
        human: atomicToDecimal(chosen.amountAtomic, ASSET_DECIMALS),
        currency: assetSymbol(chosen.asset),
      },
      network: chosen.network,
      payTo: chosen.payTo,
      payer: signed.from ?? addresses.evm,
      explorer: canonicalNetwork(chosen.network) === canonicalNetwork(BASE_NETWORK)
        ? `${BASE_EXPLORER_TX_BASE_URL}${txHash}`
        : undefined,
      body: paid.body,
    },
    [
      `Call receipt with idempotencyKey ${args.idempotencyKey} to read this back.`,
    ],
    [],
  )
}

/** Map a contract address back to the symbol the policy talks about. */
function assetSymbol(address: string): string {
  const lower = address.toLowerCase()
  if (lower === EURC_BASE.toLowerCase()) return 'EURC'
  if (lower === USDC_BASE.toLowerCase()) return 'USDC'
  // Unknown addresses keep their address, so the policy asset check refuses
  // them rather than guessing a symbol that happens to be allowed. An earlier
  // version took the allowed list and branched on it, returning `address`
  // either way -- it read as a decision and was not one, so the parameter is
  // gone rather than left in place looking consulted.
  return address
}
