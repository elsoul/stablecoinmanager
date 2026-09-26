import type { Env } from '@/types/env'
import { loadPolicy } from '@/lib/policy'
import { composePolicy } from '@/lib/effectivePolicy'
import {
  decideSet,
  OVERRIDABLE,
  type OverridableKey,
} from '@/lib/policyOverride'
import { LEDGER_INSTANCE_NAME, type WalletLedger } from '@/do/walletLedger'
import { fail, ok, type ToolResult } from '../result'

export interface PolicySetArgs {
  key: string
  value: number
}

/**
 * Tighten a ceiling at runtime.
 *
 * 🔴 TIGHTEN, not set. The ceilings exist because this worker pays without
 * asking a human; a caller that can raise its own ceiling does not have one.
 * "Raise the daily limit, then pay this invoice" is the first thing an
 * attacker tries, and this tool's description is visible to the model reading
 * it. Widening requires editing wrangler vars and redeploying — different
 * credentials, and it leaves a diff.
 *
 * The comparison is against the DEPLOY-TIME ceiling, so a narrowed limit can
 * be relaxed back to — never past — the value an operator approved. Checking
 * against the currently effective value instead would make every tightening a
 * one-way door.
 */
export async function policySet(
  env: Env,
  args: PolicySetArgs,
  actor: string,
): Promise<ToolResult> {
  const ledger = env.WALLET_LEDGER.get(
    env.WALLET_LEDGER.idFromName(LEDGER_INSTANCE_NAME),
  ) as unknown as WalletLedger

  const ceiling = loadPolicy(env)
  const { effective } = composePolicy(ceiling, await ledger.policyOverrides())

  const decision = decideSet(
    args.key,
    args.value,
    ceiling[args.key as OverridableKey],
    effective[args.key as OverridableKey],
  )

  if (decision.kind === 'not_overridable') {
    return fail({ decision }, [
      `Overridable ceilings: ${OVERRIDABLE.join(', ')}.`,
    ], [
      `${args.key} is not a runtime-overridable ceiling. Networks, assets and the ` +
        'payee are deploy-time only: they are not "how much" but "to whom and in ' +
        'what", and widening them is the same move as raising an amount.',
    ])
  }

  if (decision.kind === 'not_a_number') {
    return fail({ decision }, [], [
      `${args.key} must be a non-negative number; got ${JSON.stringify(args.value)}. ` +
        '0 is accepted and means refuse everything.',
    ])
  }

  if (decision.kind === 'would_widen') {
    return fail({ decision }, [
      `Edit POLICY_* in wrangler.toml and redeploy to raise the ceiling above ${decision.ceiling}.`,
    ], [
      `${args.key} cannot be raised to ${decision.requested}: the deploy-time ceiling ` +
        `is ${decision.ceiling}, and runtime overrides may only tighten. This tool ` +
        'cannot widen a limit, by design — the ceiling is what makes unattended ' +
        'payment safe.',
    ])
  }

  await ledger.setPolicyOverride({
    name: decision.key,
    value: String(decision.to),
    from: decision.from,
    actor,
  })

  const after = composePolicy(ceiling, await ledger.policyOverrides())
  return ok(
    {
      key: decision.key,
      from: decision.from,
      to: decision.to,
      ceiling: ceiling[decision.key],
      policy: after.effective,
    },
    [`Call policy_get to read the effective policy back.`],
    [],
  )
}
