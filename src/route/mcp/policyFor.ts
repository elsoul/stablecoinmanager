/**
 * The effective policy, read from the ledger — one function, one answer.
 *
 * 🔴 It lives here and not in `lib/` because it must touch the Durable
 * Object, and anything importing `cloudflare:workers` cannot be loaded by
 * `node --test`. `lib/effectivePolicy.ts` keeps the pure composition so the
 * decision stays executable in tests; this file is the thin env-reading shell.
 *
 * Why it is shared at all: it began as a private helper inside swapBridge.ts,
 * and the two tools that actually move money never got it. `policy_set` wrote
 * overrides that x402_pay and erpc_topup did not read, so an operator
 * tightening a ceiling during an incident received a success response naming
 * the new value while payments continued at the old one -- the one emergency
 * action the feature exists for, reporting success and doing nothing
 * (gilgamesh B1 / steiner B-1, #14054).
 */
import { LEDGER_INSTANCE_NAME, type WalletLedger } from '@/do/walletLedger'
import { composePolicy, type EffectivePolicy } from '@/lib/effectivePolicy'
import { loadPolicy } from '@/lib/policy'
import type { Env } from '@/types/env'

export async function effectivePolicy(env: Env): Promise<EffectivePolicy> {
  const ledger = env.WALLET_LEDGER.get(
    env.WALLET_LEDGER.idFromName(LEDGER_INSTANCE_NAME),
  ) as unknown as WalletLedger
  return composePolicy(loadPolicy(env), await ledger.policyOverrides())
}
