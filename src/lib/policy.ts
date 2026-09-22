/**
 * The safety valve.
 *
 * This worker is meant to pay for things without asking a human first -- that
 * is the whole point of an agent with a wallet -- so the brake is not an
 * approval prompt, it is a ceiling. Everything here is a refusal, never a
 * silent clamp: a request over the limit is rejected with the number it
 * exceeded, because quietly paying a smaller amount than asked is its own
 * kind of wrong answer.
 *
 * Values come from wrangler vars. 🔴 They are NOT overridden at runtime: the
 * ledger has a `policy_overrides` table and `policy_get` reports its rows, but
 * `loadPolicy` does not read them and no tool writes them yet. Both halves are
 * PR-3.
 *
 * Saying otherwise is not a harmless anticipation. A reader who believes an
 * override is in effect believes a ceiling is NARROWER than it is, and the
 * direction that gets wrong is the expensive one -- an override written to
 * tighten a limit would be silently inert while the wider deploy-time value
 * kept applying (gilgamesh N2 / steiner N-3, #14018).
 */
import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import type { Env } from '@/types/env'
import { ERPC_TREASURY_BASE } from './x402'

export interface Policy {
  /** The only payee, unless allowAnyPayTo. */
  allowedPayTo: string
  maxEurcPerPayment: number
  maxEurcPerDay: number
  allowedNetworks: string[]
  allowedAssets: string[]
  allowAnyPayTo: boolean
  maxSlippageBps: number
  maxDeadlineSeconds: number
}

/**
 * ERPC treasury on Base — the default and, unless opened, the only payee.
 *
 * Imported rather than re-declared: a second copy of a payee address is a
 * second thing to update when it changes, and the one that does not get
 * updated is the one that sends money somewhere else. The repo's own
 * precedent for pinning this kind of value is api/mayan-api.
 */
export { ERPC_TREASURY_BASE } from './x402'

export type PolicyViolation =
  | { kind: 'amount_over_per_payment'; limit: number; requested: number }
  | { kind: 'amount_over_daily'; limit: number; spentToday: number; requested: number }
  | { kind: 'network_not_allowed'; allowed: string[]; requested: string }
  | { kind: 'asset_not_allowed'; allowed: string[]; requested: string }
  | { kind: 'payto_not_allowed'; allowed: string[]; requested: string }
  | { kind: 'slippage_over_limit'; limit: number; requested: number }
  | { kind: 'deadline_over_limit'; limit: number; requested: number }
  | { kind: 'amount_not_finite'; requested: string }
  | { kind: 'slippage_not_finite'; requested: number }
  | { kind: 'deadline_not_finite'; requested: number }

export class PolicyConfigError extends Error {
  constructor(name: string, raw: string) {
    super(`${name} is set to ${JSON.stringify(raw)}, which is not usable`)
    this.name = 'PolicyConfigError'
  }
}

export function loadPolicy(env: Env): Policy {
  return {
    allowedPayTo: ERPC_TREASURY_BASE,
    maxEurcPerPayment: numberVar(
      'POLICY_MAX_EURC_PER_PAYMENT',
      env.POLICY_MAX_EURC_PER_PAYMENT,
      50,
    ),
    maxEurcPerDay: numberVar('POLICY_MAX_EURC_PER_DAY', env.POLICY_MAX_EURC_PER_DAY, 200),
    allowedNetworks: listVar('POLICY_ALLOWED_NETWORKS', env.POLICY_ALLOWED_NETWORKS, [
      BASE_MAINNET_CAIP2_NETWORK,
      'solana-mainnet',
    ]),
    allowedAssets: listVar('POLICY_ALLOWED_ASSETS', env.POLICY_ALLOWED_ASSETS, [
      'EURC',
      'USDC',
    ]),
    allowAnyPayTo: env.POLICY_ALLOW_ANY_PAYTO === 'true',
    maxSlippageBps: numberVar('POLICY_MAX_SLIPPAGE_BPS', env.POLICY_MAX_SLIPPAGE_BPS, 50),
    maxDeadlineSeconds: numberVar(
      'POLICY_MAX_DEADLINE_SECONDS',
      env.POLICY_MAX_DEADLINE_SECONDS,
      600,
    ),
  }
}

export interface PaymentIntent {
  /** Human units, e.g. "1.21". Atomic strings are converted by the caller. */
  amountEurcEquivalent: string
  network: string
  asset: string
  payTo: string
  slippageBps?: number
  deadlineSeconds?: number
}

export function checkPayment(
  policy: Policy,
  intent: PaymentIntent,
  spentTodayEurc: number,
): PolicyViolation[] {
  const violations: PolicyViolation[] = []

  const amount = Number(intent.amountEurcEquivalent)
  if (!Number.isFinite(amount) || amount <= 0) {
    // A NaN amount must never compare its way past a ceiling.
    violations.push({
      kind: 'amount_not_finite',
      requested: intent.amountEurcEquivalent,
    })
  } else {
    if (amount > policy.maxEurcPerPayment) {
      violations.push({
        kind: 'amount_over_per_payment',
        limit: policy.maxEurcPerPayment,
        requested: amount,
      })
    }
    if (spentTodayEurc + amount > policy.maxEurcPerDay) {
      violations.push({
        kind: 'amount_over_daily',
        limit: policy.maxEurcPerDay,
        spentToday: spentTodayEurc,
        requested: amount,
      })
    }
  }

  if (!policy.allowedNetworks.includes(intent.network)) {
    violations.push({
      kind: 'network_not_allowed',
      allowed: policy.allowedNetworks,
      requested: intent.network,
    })
  }

  if (!policy.allowedAssets.includes(intent.asset.toUpperCase())) {
    violations.push({
      kind: 'asset_not_allowed',
      allowed: policy.allowedAssets,
      requested: intent.asset,
    })
  }

  if (!policy.allowAnyPayTo) {
    const allowed = [policy.allowedPayTo]
    if (!allowed.includes(intent.payTo.toLowerCase())) {
      violations.push({
        kind: 'payto_not_allowed',
        allowed,
        requested: intent.payTo,
      })
    }
  }

  // The same NaN reasoning as the amount above: `NaN > limit` is false, so a
  // guard that only compares lets any non-number through. These arrive from
  // tool arguments, so "not a number" is a shape a caller can actually send.
  if (intent.slippageBps !== undefined) {
    if (!Number.isFinite(intent.slippageBps) || intent.slippageBps < 0) {
      violations.push({ kind: 'slippage_not_finite', requested: intent.slippageBps })
    } else if (intent.slippageBps > policy.maxSlippageBps) {
      violations.push({
        kind: 'slippage_over_limit',
        limit: policy.maxSlippageBps,
        requested: intent.slippageBps,
      })
    }
  }

  if (intent.deadlineSeconds !== undefined) {
    if (!Number.isFinite(intent.deadlineSeconds) || intent.deadlineSeconds < 0) {
      violations.push({ kind: 'deadline_not_finite', requested: intent.deadlineSeconds })
    } else if (intent.deadlineSeconds > policy.maxDeadlineSeconds) {
      violations.push({
        kind: 'deadline_over_limit',
        limit: policy.maxDeadlineSeconds,
        requested: intent.deadlineSeconds,
      })
    }
  }

  return violations
}

export function describeViolation(violation: PolicyViolation): string {
  switch (violation.kind) {
    case 'amount_over_per_payment':
      return `amount ${violation.requested} EURC exceeds the per-payment ceiling of ${violation.limit} EURC`
    case 'amount_over_daily':
      return `amount ${violation.requested} EURC would take today's total to ${
        violation.spentToday + violation.requested
      } EURC, over the daily ceiling of ${violation.limit} EURC`
    case 'network_not_allowed':
      return `network ${violation.requested} is not in ${violation.allowed.join(', ')}`
    case 'asset_not_allowed':
      return `asset ${violation.requested} is not in ${violation.allowed.join(', ')}`
    case 'payto_not_allowed':
      return `payTo ${violation.requested} is not the ERPC treasury; set POLICY_ALLOW_ANY_PAYTO=true to widen this`
    case 'slippage_over_limit':
      return `slippage ${violation.requested} bps exceeds the ${violation.limit} bps ceiling`
    case 'deadline_over_limit':
      return `deadline ${violation.requested}s exceeds the ${violation.limit}s ceiling`
    case 'amount_not_finite':
      return `amount ${JSON.stringify(violation.requested)} is not a positive finite number`
    case 'slippage_not_finite':
      return `slippage ${String(violation.requested)} is not a non-negative finite number`
    case 'deadline_not_finite':
      return `deadline ${String(violation.requested)} is not a non-negative finite number`
  }
}

/**
 * "Not configured" and "configured with something unusable" are different
 * answers, and collapsing them is dangerous in exactly one direction: the
 * fallback is always the WIDER value, so a typo in POLICY_MAX_EURC_PER_DAY
 * ("5O" for "50") would silently restore the default ceiling instead of
 * refusing to start. The same reasoning as lib/runtimeSecrets.ts.
 *
 * Absent -> the documented default. Present but unusable -> throw.
 */
function numberVar(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (trimmed === '') throw new PolicyConfigError(name, raw)
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) throw new PolicyConfigError(name, raw)
  return value
}

function listVar(name: string, raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (parsed.length === 0) throw new PolicyConfigError(name, raw)
  return parsed
}
