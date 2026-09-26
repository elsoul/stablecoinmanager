import type { Env } from '@/types/env'
import { deriveAddresses } from '@/wallet/keys'
import { effectivePolicy } from '../policyFor'
import {
  atomicToDecimal,
  extraKeyDrift,
  normalizeAccepts,
  selectRequirement,
} from '@/lib/x402'
import { probe } from '@/chain/x402Client'
import { allowedAssetPreferences,
  ASSET_DECIMALS,
} from '@/lib/assets'
import { fail, ok, type ToolResult } from '../result'

export interface InspectArgs {
  url: string
  method?: string
  body?: unknown
  headers?: Record<string, string>
  /** Probe twice and compare, to catch a requirement that changes between reads. */
  probeTwice?: boolean
}

/**
 * Read a 402 without paying it.
 *
 * Reports what the resource wants, which requirement this worker would pay,
 * and what stands in the way — including the shortfall, so the caller's next
 * move is a deposit instruction rather than another guess.
 */
export async function x402Inspect(env: Env, args: InspectArgs): Promise<ToolResult> {
  const addresses = deriveAddresses(env.WALLET_MNEMONIC ?? '')
  // EFFECTIVE: this tool tells the caller whether a 402 is payable, and
  // answering from the ceiling would say yes to an amount the payment check
  // then refuses.
  const { effective: policy } = await effectivePolicy(env)

  const first = await probe(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body,
  })

  if (first.status !== 402) {
    return fail(
      { status: first.status, body: first.body },
      [
        first.status < 400
          ? 'This resource answered without asking for payment.'
          : 'Fix the request before treating this as a payment problem.',
      ],
      [`Expected 402, got ${first.status}.`],
    )
  }

  const body = (first.body ?? {}) as { accepts?: unknown }
  const requirements = normalizeAccepts(body.accepts)
  const preferences = allowedAssetPreferences(policy)
  const { chosen, reason } = selectRequirement(requirements, preferences)

  const warnings: string[] = []

  // A volatile field inside `extra` turns a correct signature into
  // `price_mismatch`. Comparing the KEY SET across two reads catches that
  // before money moves; comparing the values would flag every quote refresh.
  let drift: string[] = []
  if (args.probeTwice) {
    const second = await probe(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
    })
    const secondReqs = normalizeAccepts(
      ((second.body ?? {}) as { accepts?: unknown }).accepts,
    )
    if (secondReqs.length !== requirements.length) {
      warnings.push(
        `the two probes returned a different number of requirements (${requirements.length} then ${secondReqs.length})`,
      )
    } else {
      for (const [index, req] of requirements.entries()) {
        const other = secondReqs[index]
        const keys = extraKeyDrift(req.extraKeys, other?.extraKeys ?? [])
        if (keys.length > 0) drift.push(...keys)
      }
      drift = [...new Set(drift)].sort()
      if (drift.length > 0) {
        warnings.push(
          `requirement \`extra\` changed shape between probes: ${drift.join(', ')} — signing against one read and submitting against another is how a correct signature becomes price_mismatch`,
        )
      }
    }
  }

  const next: string[] = []
  if (!chosen) {
    next.push(reason ?? 'Nothing here is payable by this worker.')
  } else {
    next.push(
      `Call x402_pay with this url and an idempotencyKey to pay ${
        atomicToDecimal(chosen.amountAtomic, ASSET_DECIMALS)
      } (atomic ${chosen.amountAtomic}) on ${chosen.network} to ${chosen.payTo}.`,
    )
    if (chosen.payTo.toLowerCase() !== policy.allowedPayTo.toLowerCase() && !policy.allowAnyPayTo) {
      warnings.push(
        `payTo ${chosen.payTo} is not the configured payee; x402_pay will refuse unless POLICY_ALLOW_ANY_PAYTO is set`,
      )
    }
  }

  return ok(
    {
      status: 402,
      wallet: addresses,
      requirements,
      chosenIndex: chosen?.index ?? null,
      chosenReason: chosen ? undefined : reason,
      extraKeyDrift: args.probeTwice ? drift : undefined,
      policy,
    },
    next,
    warnings,
  )
}
