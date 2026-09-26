/**
 * The policy a money tool must actually enforce.
 *
 * 🔴 `loadPolicy(env)` is the DEPLOY-TIME ceiling and is deliberately unable
 * to reach the ledger -- it takes only `env`, so no amount of editing it can
 * make it read an override. That is a property worth keeping: it means the
 * hard ceiling cannot be lowered or raised by anything the worker stores at
 * runtime, only by a redeploy.
 *
 * The effective policy is that ceiling with stored overrides applied, and
 * overrides may only tighten (see policyOverride.ts). Composition lives here
 * rather than inside `loadPolicy` so the two values stay separately nameable:
 * `policy_set` compares a request against the DEPLOY-TIME ceiling, while every
 * payment check runs against the EFFECTIVE one.
 *
 * 🔴 This module stays free of `cloudflare:workers`. The env-reading helper
 * lives in route/mcp/policyFor.ts, because a module node cannot load is a
 * module whose decisions can only be pinned as text -- the defect lib/settle.ts
 * exists to undo. Adding the ledger read here broke `node --test` immediately.
 *
 * Getting that pairing backwards is how a tightened limit becomes a one-way
 * door -- comparing against the effective value would mean a ceiling narrowed
 * to 5 could never be relaxed back to the 50 an operator approved.
 */
import type { EffectivePolicyValue, Policy } from './policy'
import { applyOverrides, type OverrideRows } from './policyOverride'

export interface EffectivePolicy {
  /** What every payment check must use. Branded — only applyOverrides mints it. */
  readonly effective: EffectivePolicyValue
  /** The deploy-time ceiling, which overrides may approach but not cross. */
  readonly ceiling: Policy
  readonly overrides: OverrideRows
}

export function composePolicy(ceiling: Policy, overrides: OverrideRows): EffectivePolicy {
  return { effective: applyOverrides(ceiling, overrides), ceiling, overrides }
}
