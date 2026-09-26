/**
 * The seed-export throttle decision.
 *
 * It lives here, and not next to the Durable Object that uses it, for one
 * reason: `do/walletLedger.ts` imports `cloudflare:workers`, a specifier only
 * workerd resolves, so anything in that file can only be exercised by
 * re-implementing it in a test — and a copy in a test proves the copy works.
 * Here it can be driven directly.
 */

/**
 * Is a stored throttle row still holding the door shut?
 *
 * Fails CLOSED: anything this writer would not have produced counts as a live
 * claim. `Number('')` and `Number(null)` are both 0, so a bare
 * `Number.isFinite` check would read those as "no claim" and let the recovery
 * phrase out.
 */
export function throttleIsLive(stored: unknown, now: number): boolean {
  if (typeof stored !== 'number' || !Number.isFinite(stored) || stored <= 0) {
    return true
  }
  return stored > now
}
