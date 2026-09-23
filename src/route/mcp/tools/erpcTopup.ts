import type { Env } from '@/types/env'
import { probe } from '@/chain/x402Client'
import { BASE_EXPLORER_TX_BASE_URL } from '@constants/base'
import { topupAssetPreferences } from '@/lib/assets'
import { effectivePolicy } from '../policyFor'
import { LEDGER_INSTANCE_NAME, type WalletLedger } from '@/do/walletLedger'
import { fail, ok, type ToolResult } from '../result'
import { x402Pay } from './x402Pay'

export interface TopupArgs {
  amountCredits: number
  idempotencyKey: string
}

const POLL_ATTEMPTS = 8
const POLL_INTERVAL_MS = 5_000

/**
 * Buy ERPC credit with the wallet.
 *
 * Mirrors the proven flow in `api/erpc/x402-rpc-api/.e2e-local/run-e2e-topup.mjs`:
 *
 *   1. POST /v1/account/mint with the ERPC api-key  -> a short-lived billing JWT
 *   2. POST /v1/credits/topup {amountCredits}       -> 402
 *   3. x402_pay signs and re-sends it
 *   4. GET /v1/credits/topup/{tx} until granted     -> invoice number
 *
 * The api-key identifies WHICH ERPC account receives the credit, and it is
 * server-side only: it is never taken from the caller, so an MCP client cannot
 * redirect the purchase to a different account.
 */
export async function erpcTopup(env: Env, args: TopupArgs): Promise<ToolResult> {
  if (!env.ERPC_API_KEY) {
    return fail({}, ['Set ERPC_API_KEY with `wrangler secret put`.'], [
      'ERPC_API_KEY is not configured, so there is no account to credit.',
    ])
  }
  if (!Number.isInteger(args.amountCredits) || args.amountCredits < 1) {
    return fail({ amountCredits: args.amountCredits }, [], [
      'amountCredits must be a positive integer',
    ])
  }

  const host = (env.X402_HOST ?? 'https://x402.erpc.global').replace(/\/+$/, '')

  const mint = await probe(`${host}/v1/account/mint`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ERPC_API_KEY}` },
  })
  if (mint.status !== 200) {
    return fail({ status: mint.status }, [], [
      `the billing session could not be minted (${mint.status})`,
    ])
  }
  const session = (mint.body ?? {}) as { access_token?: string }
  if (!session.access_token) {
    return fail({}, [], ['the mint response carried no access_token'])
  }
  const bearer = `Bearer ${session.access_token}`

  // EURC only, regardless of what the policy allows for generic payments.
  // See lib/assets.ts:topupAssetPreferences -- the ruling lives in
  // constants/base.ts, not here.
  const preferences = topupAssetPreferences((await effectivePolicy(env)).effective)
  if (preferences.length === 0) {
    return fail({}, [
      'Allow EURC and eip155:8453 in POLICY_ALLOWED_ASSETS / POLICY_ALLOWED_NETWORKS.',
    ], [
      'the policy leaves no asset a credit top-up may be paid in (top-ups are EURC on Base only)',
    ])
  }

  const paid = await x402Pay(env, {
    url: `${host}/v1/credits/topup`,
    idempotencyKey: args.idempotencyKey,
    headers: { Authorization: bearer },
    body: { amountCredits: args.amountCredits },
    assetPreferences: preferences,
  })
  if (!paid.ok) return paid

  const data = paid.data as {
    transaction?: string
    status?: string
    replay?: boolean
    invoiceNumber?: string
  }
  const txHash = data.transaction ??
    (data as { receipt?: { tx_hash?: string } }).receipt?.tx_hash
  if (!txHash) {
    return ok(paid.data, paid.next, [
      ...paid.warnings,
      'no transaction hash to poll; call receipt to see what was recorded',
    ])
  }

  // Bounded poll. The credit grant is asynchronous on the ERPC side, and an
  // unbounded wait inside a Worker request is not available to us anyway.
  let status = data.status
  // Seeded from the payment response, not left undefined for the poll to
  // fill. When the grant completes inline the rail answers the re-sent
  // payment with status:'granted' + invoiceNumber, and the loop below never
  // runs because its condition is `status !== 'granted'` -- so on the fastest
  // and most ordinary outcome this tool returned no invoice number at all,
  // while promising one. x402_pay already records it in the ledger; this is
  // the other half, the tool's own answer (steiner N-10, #14018).
  let invoiceNumber: string | undefined = data.invoiceNumber
  let attempts = 0
  while (attempts < POLL_ATTEMPTS && status !== 'granted' && status !== 'stuck') {
    attempts += 1
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const check = await probe(`${host}/v1/credits/topup/${txHash}`, {
      method: 'GET',
      headers: { Authorization: bearer },
    })
    const checkBody = (check.body ?? {}) as { status?: string; invoiceNumber?: string }
    status = checkBody.status
    invoiceNumber = checkBody.invoiceNumber ?? invoiceNumber
  }

  const ledger = env.WALLET_LEDGER.get(
    env.WALLET_LEDGER.idFromName(LEDGER_INSTANCE_NAME),
  ) as unknown as WalletLedger
  await ledger.settlePayment({
    idempotencyKey: args.idempotencyKey,
    status: status === 'granted' ? 'settled' : status === 'stuck' ? 'stuck' : 'pending',
    txHash,
    invoiceNumber,
  })

  const granted = status === 'granted'
  return (granted ? ok : fail)(
    {
      transaction: txHash,
      status: status ?? 'unknown',
      invoiceNumber,
      amountCredits: args.amountCredits,
      polls: attempts,
      explorer: `${BASE_EXPLORER_TX_BASE_URL}${txHash}`,
    },
    granted
      ? ['The credit is granted; the dashboard balance should reflect it.']
      : [
        `Still ${status ?? 'unknown'} after ${attempts} polls. The payment is on chain — call erpc_topup again with the SAME idempotencyKey to re-poll without paying twice.`,
      ],
    granted ? [] : ['the credit was not granted within the polling window'],
  )
}
