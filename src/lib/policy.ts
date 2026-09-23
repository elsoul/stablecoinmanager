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
 * Values come from wrangler vars, and this function is the DEPLOY-TIME
 * CEILING. It deliberately takes only `env` and cannot reach the ledger, so
 * nothing the worker stores at runtime can raise it.
 *
 * Runtime overrides exist as of PR-3 and may only TIGHTEN. They are composed
 * on top of this by `lib/effectivePolicy.ts`, read via
 * `route/mcp/policyFor.ts`, and every tool enforces the EFFECTIVE result --
 * `policy_set` is the one caller that compares against this ceiling.
 *
 * 🔴 That wiring is the whole point, and it was missing when PR-3 was first
 * opened: `policy_set` wrote overrides while x402_pay and erpc_topup still
 * called `loadPolicy` directly, so a tightened ceiling was silently inert and
 * the tool reported success. A reader who believes an override is in effect
 * believes a ceiling is NARROWER than it is, and that is the expensive
 * direction (gilgamesh B1 / steiner B-1, #14054; first reported as
 * gilgamesh N2 / steiner N-3 on #14018).
 */
import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import type { Env } from '@/types/env'
import { networkAllowlist, type NetworkAllowlist } from './networks'
import { ERPC_TREASURY_BASE } from './x402'

export interface Policy {
  /** The only payee, unless allowAnyPayTo. */
  allowedPayTo: string
  maxEurcPerPayment: number
  maxEurcPerDay: number
  allowedNetworks: NetworkAllowlist
  allowedAssets: readonly string[]
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
  | { kind: 'network_not_allowed'; allowed: readonly string[]; requested: string }
  | { kind: 'asset_not_allowed'; allowed: readonly string[]; requested: string }
  | { kind: 'payto_not_allowed'; allowed: readonly string[]; requested: string }
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
    allowedNetworks: networkAllowlist(
      listVar('POLICY_ALLOWED_NETWORKS', env.POLICY_ALLOWED_NETWORKS, [
        BASE_MAINNET_CAIP2_NETWORK,
        'solana-mainnet',
      ]),
    ),
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

declare const EFFECTIVE: unique symbol

/**
 * A policy that has had stored overrides applied to it.
 *
 * 🔴 This brand is load-bearing, and it is the THIRD attempt at the same
 * defect. `policy_set` writing an override that no payment consults was
 * blocked first by fixing the wiring, then by a test that greps the tool
 * sources for `loadPolicy(`. Both gates then showed the grep loses:
 * `(await effectivePolicy(env)).ceiling` reintroduced the exact defect with
 * 211 tests green (steiner B-6), and so did
 * `import { loadPolicy as readPolicy }` (gilgamesh R2-N1).
 *
 * Text pins lose because they enumerate spellings, and a spelling is free to
 * invent. A type does not enumerate: `checkPayment` takes a policy that only
 * `applyOverrides` can produce, so a ceiling that reaches the money path by
 * being NAMED -- `loadPolicy`, an alias for it, or `.ceiling` off the
 * composed value -- is a compile error however it is spelled or imported.
 * Both spellings actually found in the wild are in that set. The grep stays
 * as a backstop, demoted to what it is.
 *
 * 🔴 It is NOT total, and the limit belongs here rather than in a reviewer's
 * head. `applyOverrides(loadPolicy(env), {})` mints a legitimate brand from a
 * ceiling using no cast and no banned identifier, and only the backstop grep
 * stops it (gilgamesh, #14054). An unqualified completeness claim would be
 * the same defect as the curation docblock that declared a rule the
 * implementation did not have. `Readonly` additionally closes mutating a
 * well-obtained effective policy in place -- including
 * `allowedNetworks.push(...)` and `allowedAssets.push(...)`, which `Readonly`
 * alone left open because it does not reach into array fields, and which are
 * exactly the two ceilings `policy_set` refuses to override on the grounds
 * that they are "to whom and in what" rather than "how much"
 * (steiner N-16, #14054). Spreading an effective policy into a wider copy
 * stays reachable, and that is a deliberate act rather than a misspelling.
 *
 * This is the same move `lib/settle.ts` made for the settle decision, for the
 * same stated reason: pinning text is a losing game.
 */
export type EffectivePolicyValue = Readonly<Policy> & { readonly [EFFECTIVE]: true }

/**
 * A ceiling, or 0 if it is not a number.
 *
 * 🔴 ALL FOUR comparisons, not just the two about money. The first version of
 * this guard covered `maxEurcPerPayment` and `maxEurcPerDay` and left
 * `maxSlippageBps` and `maxDeadlineSeconds` comparing against a possible NaN
 * -- where `x > NaN` is false and the brake becomes a pass (steiner N-1,
 * #14067).
 *
 * Scope, measured: neither production path can currently produce a non-finite
 * ceiling. `numberVar` throws on 'NaN', 'Infinity' and '1e999', and
 * `strictNumber` rejects them on the override side. So this is
 * defense-in-depth, and the reason to make it symmetric is not a live leak --
 * it is that two of four comparisons being guarded reads as a decision about
 * the other two. That asymmetry is the shape this package has been closing
 * all through #14054 and #14067.
 *
 * Direction: ceilings fall to 0 (refuse everything) and spend totals rise to
 * Infinity (refuse everything). Both ends move toward refusal; reversing
 * either one is a fail-open.
 */
function ceilingOf(limit: number): number {
  return Number.isFinite(limit) ? limit : 0
}

export function checkPayment(
  policy: EffectivePolicyValue,
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
    // 🔴 A non-finite CEILING fails closed too, not just a non-finite amount.
    // See `ceilingOf` below; all four comparisons go through it.
    // `x > NaN` is false, so an unreadable limit used to mean "no limit" --
    // the comparison silently inverting from a brake into a pass. The daily
    // side was guarded inside reserveDecision; the per-payment side was never
    // guarded anywhere. The guard belongs here, where the comparison is: a
    // money gate must not trust the policy it was handed to be a number.
    const perPayment = ceilingOf(policy.maxEurcPerPayment)
    const perDay = ceilingOf(policy.maxEurcPerDay)
    const spent = Number.isFinite(spentTodayEurc) ? spentTodayEurc : Number.POSITIVE_INFINITY

    if (amount > perPayment) {
      violations.push({
        kind: 'amount_over_per_payment',
        limit: perPayment,
        requested: amount,
      })
    }
    if (spent + amount > perDay) {
      violations.push({
        kind: 'amount_over_daily',
        limit: perDay,
        spentToday: spent,
        requested: amount,
      })
    }
  }

  // 🔴 Through the allowlist's own `allows`. This is the site that made the previous fix
  // incomplete: normalisation reached plan/swap/bridge but stopped short of
  // the payment gate, so declaring CAIP-2 canonical opened a NEW trap -- an
  // operator following the remediation text would see plan and swap say
  // "allowed" while every Solana 402 was refused here (steiner B-7, #14054).
  if (!policy.allowedNetworks.allows(intent.network)) {
    violations.push({
      kind: 'network_not_allowed',
      allowed: policy.allowedNetworks.toJSON(),
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
    } else if (intent.slippageBps > ceilingOf(policy.maxSlippageBps)) {
      violations.push({
        kind: 'slippage_over_limit',
        limit: ceilingOf(policy.maxSlippageBps),
        requested: intent.slippageBps,
      })
    }
  }

  if (intent.deadlineSeconds !== undefined) {
    if (!Number.isFinite(intent.deadlineSeconds) || intent.deadlineSeconds < 0) {
      violations.push({ kind: 'deadline_not_finite', requested: intent.deadlineSeconds })
    } else if (intent.deadlineSeconds > ceilingOf(policy.maxDeadlineSeconds)) {
      violations.push({
        kind: 'deadline_over_limit',
        limit: ceilingOf(policy.maxDeadlineSeconds),
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
