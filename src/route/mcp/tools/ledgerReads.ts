import type { Env } from '@/types/env'
import { loadPolicy } from '@/lib/policy'
import { LEDGER_INSTANCE_NAME, type WalletLedger } from '@/do/walletLedger'
import { ok, type ToolResult } from '../result'

function ledgerOf(env: Env): WalletLedger {
  return env.WALLET_LEDGER.get(
    env.WALLET_LEDGER.idFromName(LEDGER_INSTANCE_NAME),
  ) as unknown as WalletLedger
}

export async function history(env: Env, args: { limit?: number }): Promise<ToolResult> {
  const rows = await ledgerOf(env).history(args.limit ?? 50)
  return ok({ payments: rows, count: rows.length }, [
    'Call receipt with an idempotencyKey for one payment in full.',
  ])
}

export async function receipt(
  env: Env,
  args: { idempotencyKey: string },
): Promise<ToolResult> {
  const row = await ledgerOf(env).receipt(args.idempotencyKey)
  if (!row) {
    return ok({ found: false, idempotencyKey: args.idempotencyKey }, [
      'No payment was recorded under that key. Nothing was signed for it.',
    ])
  }
  return ok({ found: true, receipt: row })
}

export async function policyGet(env: Env): Promise<ToolResult> {
  const ledger = ledgerOf(env)
  const [overrides, spentToday] = await Promise.all([
    ledger.policyOverrides(),
    ledger.spentTodayEurc(),
  ])
  const policy = loadPolicy(env)
  return ok(
    {
      policy,
      overrides,
      spentTodayEurc: spentToday,
      remainingTodayEurc: Math.max(0, policy.maxEurcPerDay - spentToday),
    },
    [],
    // The seed-export throttle deliberately does NOT appear here: it lives in
    // its own table so a policy tool can neither read nor extend it.
    [],
  )
}
