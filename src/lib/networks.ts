/**
 * One name per network, because this worker was carrying two.
 *
 * 🔴 The defect this closes: `bridge` compared the SDK's bridge-capability
 * chain ids against `policy.allowedNetworks`, and those are different
 * vocabularies. The SDK names Solana mainnet in CAIP-2
 * (`solana:5eykt4...`); this worker's own holdings and gateway code has
 * always called it `solana-mainnet` (see chain/gateway.ts READABLE_NETWORKS),
 * and that string is what ships as a POLICY_ALLOWED_NETWORKS default.
 *
 * A string comparison across two vocabularies does not fail loudly. It
 * returns false, and false is a refusal, so the tool kept answering -- it
 * just answered "not an allowed network" to every bridge capability the SDK
 * ships. Both of them. The refusal even told the caller to edit
 * POLICY_ALLOWED_NETWORKS, which could not have helped: writing the CAIP-2
 * form there would have un-named Solana for holdings instead
 * (steiner B-5, #14054).
 *
 * So the comparison is normalised rather than the config. Aliases are
 * declared here once.
 *
 * 🔴 The first version of this fix normalised the POLICY comparison layer --
 * plan, swap, bridge -- and its docblock claimed "every network check". That
 * was not true, and the gap it left was worse than the bug it fixed: by
 * declaring CAIP-2 canonical while `checkPayment` still compared raw
 * strings, an operator following the remediation text into writing CAIP-2
 * config would have had plan and swap answer "allowed" while every Solana
 * 402 was refused at the payment gate (steiner B-7, #14054). Fail-closed, so
 * nothing was at risk except the operator's afternoon.
 *
 * The sites that decide network IDENTITY all route through here now:
 * `checkPayment`, the asset catalogue filter, `swapRefusal`, x402 requirement
 * selection, `bridgeRoute`, the `holdings` RPC dispatch, the tool-level
 * allowlist checks, and the explorer-link branch in `x402Pay`.
 *
 * 🔴 That list is a map, not the gate. The gate is `NetworkAllowlist` below,
 * and what it does and does not close is written there rather than here.
 *
 * This paragraph used to claim the gate was a type called `NetworkId` and
 * that a raw string "cannot be compared against policy.allowedNetworks at
 * all". That type no longer exists, and the sentence was false while it did
 * -- it is the exact claim round 5 falsified with `some(n => n === id)`
 * (gilgamesh R6-N3, #14054). Leaving it here would have been worse than
 * never writing it: the honest account sits directly below, and a reader
 * reaches this one first.
 */

declare const NETWORK_ALLOWLIST: unique symbol

/**
 * The allowlist, as an object that answers rather than an array to search.
 *
 * 🔴 FOURTH attempt at one defect, and the first three each failed the same
 * way: the guard enumerated forms, and a form outside the list came back.
 *   1. a grep for `.includes` scoped to route/mcp/tools  -- lost to lib/policy.ts (B-7)
 *   2. the same grep widened to the tree                 -- lost to `new Set(x).has(id)` (B-8)
 *   3. a branded element type `NetworkId`                -- lost to `some(n => n === id)` (B-9)
 *
 * Step 3 is worth naming precisely, because it looked structural. A branded
 * `string & {...}` is a SUBTYPE of string, so TypeScript happily compares it
 * to a plain string with `===`; only argument positions (`includes(x)`,
 * `Set.has(x)`) are checked. The type moved the enumeration from the grep's
 * predicate list into "which positions the checker inspects". Still a list.
 *
 * So the array is gone. There is no `.some`, no `.find`, no `for...of`, no
 * `includes`, because there is nothing to iterate: `allows(id)` is the only
 * question the value can answer, and it normalises both sides itself.
 *
 * 🔴 What is still reachable, stated rather than implied. This list is the
 * whole of it, and it has been wrong once already by omission:
 *   - `toJSON().some(...)` / `.includes(...)` -- a real array, three steps.
 *     `JSON.stringify(allowlist).includes(id)` is the same entrance in one
 *     expression, and it matches substrings, so it errs OPEN like describe()
 *   - `describe().includes(id)` -- substring matching, and it errs OPEN
 * Both read as wrong at the call site, which is the most an in-process
 * boundary can do. Claiming more than that is the mistake this file has made
 * three times in docblocks: `EffectivePolicyValue`'s "regardless of how it
 * was spelled" (round 3), "every network check" (round 4), and "cannot be
 * compared at all" (round 5). The first version of THIS list named only
 * `toJSON()` and missed the field that became `describe()` (round 6).
 */
export interface NetworkAllowlist {
  /** The only question. Both sides are canonicalised. */
  readonly allows: (id: string) => boolean
  /**
   * For messages. A METHOD, not a field, because a field invites
   * `allowedNetworks.rendered.includes(id)` -- which compiles, reads exactly
   * like the array `.includes` this file spent four rounds removing, and is
   * WRONG IN THE OPEN DIRECTION: substring matching answers true for
   * "eip155:8" and "solana" against "eip155:8453, solana-mainnet"
   * (gilgamesh R6-N1, #14054). Two explicit steps is the most a boundary can
   * ask for; one field access was not enough.
   */
  describe(): string
  /** Wire shape. Kept so tool payloads still serialise as an array. */
  toJSON(): string[]
  readonly [NETWORK_ALLOWLIST]: true
}

/** The mint. `loadPolicy` calls it on config; tests call it on literals. */
export function networkAllowlist(ids: readonly string[]): NetworkAllowlist {
  const canonical = ids.map(canonicalNetwork)
  const listed = [...ids]
  return {
    allows: (id) => {
      const target = canonicalNetwork(id)
      return canonical.some((c) => c === target)
    },
    describe: () => listed.join(', '),
    // A copy. Returning `listed` handed callers the live array, so a push
    // gave three disagreeing views: toJSON() showed the extra entry, the
    // description did not, and allows() refused it (gilgamesh R6-N2, #14054).
    toJSON: () => [...listed],
  } as NetworkAllowlist
}

/** Solana mainnet in CAIP-2, as the SDK's bridge capabilities carry it. */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

/** This worker's own id for the same chain, used by holdings and gateway. */
export const SOLANA_MAINNET_LOCAL = 'solana-mainnet'

/**
 * Alias -> canonical. Only entries where two strings provably name the SAME
 * chain belong here; anything else is a policy decision, not a spelling.
 */
const ALIASES: Readonly<Record<string, string>> = {
  [SOLANA_MAINNET_LOCAL]: SOLANA_MAINNET_CAIP2,
}

/**
 * The one spelling a comparison may use. Unknown ids pass through unchanged.
 *
 * 🔴 `Object.hasOwn`, not `ALIASES[id] ?? id`. The plain form reads the
 * prototype chain, so `canonicalNetwork('constructor')` returned a FUNCTION
 * from a signature that promises a string, and `swapRefusal('constructor')`
 * then threw on `.startsWith`. Network ids arrive from model-controlled
 * arguments (`plan` takes a free-string chainId and refuses without a prior
 * allowlist check), so "nobody would pass that" is not available here
 * (gilgamesh R4-N1, #14054).
 *
 * The declared return type made it invisible: every caller trusted `string`,
 * and TypeScript had no reason to doubt it.
 */
export function canonicalNetwork(id: string): string {
  return Object.hasOwn(ALIASES, id) ? ALIASES[id] : id
}

/**
 * Is `id` one of `allowed`, whichever vocabulary either side happens to use?
 *
 * Both sides are normalised: the allowlist is operator-written config and the
 * id usually comes from the SDK, so neither can be assumed canonical.
 */
// `networkAllowed(allowed: readonly string[], id)` used to live here. It was
// removed once `NetworkAllowlist` landed: it had no production caller left,
// and an exported function whose entire job is to answer the question against
// an ARRAY is a standing invitation to go back to arrays
// (gilgamesh R6-N4, #14054). Ask a NetworkAllowlist instead.
