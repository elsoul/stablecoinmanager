/**
 * Who is allowed to log in.
 *
 * This worker is single-owner by construction: one deploy = one wallet = one
 * human. The allowlist is the last gate before an MCP authorization code is
 * minted, so it fails closed -- an empty or missing list authorizes nobody
 * (an empty list must never read as "no restriction").
 */
import type { AuthApiClaims, AuthorizedIdentity } from '@/types/oauth'

export type AllowlistRejection =
  | 'provider_not_google'
  | 'email_missing'
  | 'email_unverified'
  | 'email_not_allowed'
  | 'allowlist_empty'
  | 'subject_missing'

export type AllowlistResult =
  | { ok: true; identity: AuthorizedIdentity }
  | { ok: false; reason: AllowlistRejection }

export function parseAllowedEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

export function evaluateLogin(
  claims: AuthApiClaims,
  allowedRaw: string | undefined,
): AllowlistResult {
  const allowed = parseAllowedEmails(allowedRaw)
  if (allowed.length === 0) return { ok: false, reason: 'allowlist_empty' }

  if (claims.provider !== 'google') {
    return { ok: false, reason: 'provider_not_google' }
  }

  const email = claims.email?.trim().toLowerCase() ?? ''
  if (!email) return { ok: false, reason: 'email_missing' }

  // An unverified address is an address anyone can claim.
  if (claims.isEmailVerified !== true) {
    return { ok: false, reason: 'email_unverified' }
  }

  if (!allowed.includes(email)) return { ok: false, reason: 'email_not_allowed' }

  const subject = claims.sub?.trim() ?? ''
  if (!subject) return { ok: false, reason: 'subject_missing' }

  return { ok: true, identity: { subject, email } }
}

/**
 * Decode (never verify) a JWT payload. The signature is not checkable here by
 * design -- see AuthApiClaims. Any malformed input yields null, which the
 * caller turns into a 403.
 */
export function decodeJwtPayload(token: string): AuthApiClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    let padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (padded.length % 4 !== 0) padded += '='
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as AuthApiClaims
  } catch {
    return null
  }
}
