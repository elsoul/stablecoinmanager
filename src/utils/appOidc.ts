/**
 * app-oidc login path: talking to the app-oidc-api broker as the identity
 * provider. Paired with `utils/authApi.ts` (the erpc-auth-api path). See
 * docs/superpowers/plans/2026-09-25-stablecoin-manager-app-oidc-branch-madeen.md
 * §1, §2-A, §2-A'.
 */
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from 'jose'
import type { AuthApiClaims } from '@/types/oauth'
import type { AppOidcJwks } from './appOidcJwks'

export interface AppOidcConfig {
  issuer: string
  clientId: string
}

export function resolveAppOidcConfig(env: {
  APP_OIDC_ISSUER?: string
  APP_OIDC_CLIENT_ID?: string
}): AppOidcConfig {
  const issuer = env.APP_OIDC_ISSUER ?? ''
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new Error('APP_OIDC_ISSUER is not a valid URL')
  }
  if (url.protocol !== 'https:' || url.origin !== issuer) {
    throw new Error('APP_OIDC_ISSUER must be a canonical https origin')
  }

  const clientId = env.APP_OIDC_CLIENT_ID ?? ''
  if (!clientId) {
    throw new Error('APP_OIDC_CLIENT_ID is required')
  }

  return { issuer, clientId }
}

export function buildAppOidcAuthorizeUrl(params: {
  issuer: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  nonce: string
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: 'openid email',
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${params.issuer}/oauth/authorize?${query.toString()}`
}

export async function oidcTxnKey(state: string): Promise<string> {
  return `oidc_txn:${await sha256Hex(state)}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type AppOidcFailureReason =
  | 'token_endpoint_error'
  | 'token_response_malformed'
  | 'malformed'
  | 'alg_not_allowed'
  | 'kid_missing'
  | 'key_not_found'
  | 'jwks_unavailable'
  | 'expired'
  | 'too_old'
  | 'iss_mismatch'
  | 'aud_mismatch'
  | 'not_yet_valid'
  | 'claim_missing'
  | 'signature_invalid'
  | 'nonce_mismatch'

export type AppOidcVerifyResult =
  | { ok: true; claims: AuthApiClaims }
  | { ok: false; reason: AppOidcFailureReason }

const REQUIRED_ALG = 'ES256'
const MAX_ID_TOKEN_LENGTH = 8192

export interface AppOidcVerifyConfig {
  issuer: string
  clientId: string
  expectedNonce: string
  now: () => number
  getJwks: (opts?: { force?: boolean }) => Promise<AppOidcJwks>
}

export async function verifyAppOidcIdToken(
  idToken: string,
  config: AppOidcVerifyConfig,
): Promise<AppOidcVerifyResult> {
  if (idToken.length > MAX_ID_TOKEN_LENGTH || idToken.split('.').length !== 3) {
    return { ok: false, reason: 'malformed' }
  }

  let header: { alg?: string; kid?: string }
  try {
    header = decodeProtectedHeader(idToken)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  // Checked here, ahead of and in addition to jose's own `algorithms` filter
  // below -- two independent walls against an algorithm-confusion token
  // (design §4 mutation table "alg pin").
  if (header.alg !== REQUIRED_ALG) {
    return { ok: false, reason: 'alg_not_allowed' }
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, reason: 'kid_missing' }
  }

  let jwks: AppOidcJwks
  try {
    const resolved = await resolveJwksForKid(header.kid, config.getJwks)
    if (!resolved) return { ok: false, reason: 'key_not_found' }
    jwks = resolved
  } catch {
    return { ok: false, reason: 'jwks_unavailable' }
  }

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      algorithms: [REQUIRED_ALG],
      issuer: config.issuer,
      audience: config.clientId,
      requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'iat', 'exp'],
      maxTokenAge: 300,
      clockTolerance: 30,
      currentDate: new Date(config.now()),
    })
    payload = result.payload as Record<string, unknown>
  } catch (error) {
    return { ok: false, reason: mapJoseError(error) }
  }

  // jose's own `audience` option (above) already confirmed aud references
  // config.clientId (string equality, or membership if aud is an array). This
  // is the one thing jose does not check: an array aud is rejected unless it
  // has exactly one element (design §2-A step 5, "aud 単一性").
  if (!isSingleValuedAudience(payload.aud)) {
    return { ok: false, reason: 'aud_mismatch' }
  }

  const azp = payload.azp
  if (azp !== undefined && azp !== config.clientId) {
    return { ok: false, reason: 'aud_mismatch' }
  }

  const nonce = payload.nonce
  if (
    !config.expectedNonce ||
    typeof nonce !== 'string' ||
    nonce.length === 0 ||
    nonce !== config.expectedNonce
  ) {
    return { ok: false, reason: 'nonce_mismatch' }
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  const email = typeof payload.email === 'string' ? payload.email : ''
  if (!sub || !email) {
    return { ok: false, reason: 'claim_missing' }
  }

  return {
    ok: true,
    claims: {
      sub,
      provider: 'google',
      email,
      isEmailVerified: payload.email_verified === true,
      iss: typeof payload.iss === 'string' ? payload.iss : config.issuer,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
    },
  }
}

function isSingleValuedAudience(aud: unknown): boolean {
  if (typeof aud === 'string') return true
  if (Array.isArray(aud)) return aud.length === 1
  return false
}

async function resolveJwksForKid(
  kid: string,
  getJwks: (opts?: { force?: boolean }) => Promise<AppOidcJwks>,
): Promise<AppOidcJwks | null> {
  const cached = await getJwks()
  if (cached.keys.some((key) => key.kid === kid)) return cached

  const refreshed = await getJwks({ force: true })
  if (refreshed.keys.some((key) => key.kid === kid)) return refreshed

  return null
}

function mapJoseError(error: unknown): AppOidcFailureReason {
  if (error instanceof errors.JWTExpired) {
    return error.claim === 'iat' ? 'too_old' : 'expired'
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.reason === 'missing') return 'claim_missing'
    if (error.claim === 'iss') return 'iss_mismatch'
    if (error.claim === 'aud') return 'aud_mismatch'
    if (error.claim === 'nbf' || error.claim === 'iat') return 'not_yet_valid'
    return 'claim_missing'
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'signature_invalid'
  if (error instanceof errors.JOSEAlgNotAllowed) return 'alg_not_allowed'
  if (error instanceof errors.JWKSNoMatchingKey) return 'key_not_found'
  return 'malformed'
}

export interface ExchangeAppOidcCodeParams {
  issuer: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
  expectedNonce: string
  now: () => number
  getJwks: (opts?: { force?: boolean }) => Promise<AppOidcJwks>
}

export async function exchangeAppOidcCode(
  params: ExchangeAppOidcCodeParams,
): Promise<AppOidcVerifyResult> {
  let response: Response
  try {
    response = await fetch(`${params.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        code_verifier: params.codeVerifier,
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, reason: 'token_endpoint_error' }
  }

  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: 'token_endpoint_error' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'token_response_malformed' }
  }

  const idToken = (body as { id_token?: unknown } | null)?.id_token
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return { ok: false, reason: 'token_response_malformed' }
  }

  return verifyAppOidcIdToken(idToken, {
    issuer: params.issuer,
    clientId: params.clientId,
    expectedNonce: params.expectedNonce,
    now: params.now,
    getJwks: params.getJwks,
  })
}
