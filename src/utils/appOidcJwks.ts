/**
 * JWKS fetch and cache for the app-oidc login path. See
 * docs/superpowers/plans/2026-09-25-stablecoin-manager-app-oidc-branch-madeen.md
 * §2-B.
 */

export interface AppOidcJwk {
  kty: string
  crv?: string
  x?: string
  y?: string
  kid: string
  use?: string
  alg?: string
  [key: string]: unknown
}

export interface AppOidcJwks {
  keys: AppOidcJwk[]
}

export interface AppOidcJwksClient {
  getJwks(opts?: { force?: boolean }): Promise<AppOidcJwks>
}

export interface AppOidcJwksClientDeps {
  fetch?: typeof fetch
  now?: () => number
}

const MAX_KEYS = 20
const MAX_TTL_SECONDS = 300
const FETCH_TIMEOUT_MS = 5_000

// The Workers runtime honors `cache: 'no-store'` on outbound fetch(), but
// @cloudflare/workers-types omits the `cache` field from RequestInit. Same
// precedent as api/erpc/user-api/src/types/cloudflareWorkersModule.ts
// `WorkerRequestInit` (not imported: separate deployable, no shared lib).
type WorkerFetchInit = RequestInit & { cache?: 'no-store' }

export function createAppOidcJwksClient(
  issuer: string,
  deps: AppOidcJwksClientDeps = {},
): AppOidcJwksClient {
  const now = deps.now ?? (() => Date.now())
  const url = `${issuer}/.well-known/jwks.json`
  let cache: { jwks: AppOidcJwks; expiresAt: number } | null = null

  async function fetchJwks(): Promise<AppOidcJwks> {
    const doFetch = (deps.fetch ?? fetch) as (
      input: string,
      init?: WorkerFetchInit,
    ) => Promise<Response>
    const response = await doFetch(url, {
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })

    if (response.status !== 200) {
      throw new Error('jwks_unavailable')
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('jwks_unavailable')
    }

    const keys = (body as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys) || keys.length > MAX_KEYS) {
      throw new Error('jwks_unavailable')
    }

    const seenKids = new Set<string>()
    for (const key of keys) {
      const kid = (key as { kid?: unknown } | null)?.kid
      if (typeof kid !== 'string' || kid.length === 0 || seenKids.has(kid)) {
        throw new Error('jwks_unavailable')
      }
      seenKids.add(kid)
    }

    const jwks: AppOidcJwks = { keys: keys as AppOidcJwk[] }
    const ttlSeconds = computeTtlSeconds(response.headers)
    // A TTL of 0 (no Cache-Control, or no-store/no-cache) means "never treat
    // this as cached" -- not "valid for zero elapsed time", which the >=
    // comparison below would otherwise satisfy at t=0.
    cache = ttlSeconds > 0 ? { jwks, expiresAt: now() + ttlSeconds * 1000 } : null
    return jwks
  }

  return {
    async getJwks(opts) {
      if (!opts?.force && cache && cache.expiresAt >= now()) {
        return cache.jwks
      }
      return fetchJwks()
    },
  }
}

function computeTtlSeconds(headers: Headers): number {
  const cacheControl = headers.get('cache-control')
  if (!cacheControl) return 0
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/i.test(cacheControl)) return 0

  const match = cacheControl.match(/max-age\s*=\s*(\d+)/i)
  if (!match) return 0
  const maxAge = Number(match[1])

  const ageHeader = headers.get('age')
  const age = ageHeader !== null && Number.isFinite(Number(ageHeader)) ? Number(ageHeader) : 0

  return clamp(maxAge - age, 0, MAX_TTL_SECONDS)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

const sharedClients = new Map<string, AppOidcJwksClient>()

/**
 * Per-issuer singleton, so the isolate-lifetime cache above is actually
 * shared across requests rather than rebuilt on every callback.
 */
export function getAppOidcJwksClient(issuer: string): AppOidcJwksClient {
  let client = sharedClients.get(issuer)
  if (!client) {
    client = createAppOidcJwksClient(issuer)
    sharedClients.set(issuer, client)
  }
  return client
}
