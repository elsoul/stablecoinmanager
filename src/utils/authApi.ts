/**
 * auth-api used purely as the Google IdP.
 *
 * This worker runs its own Authorization Server for MCP clients (see
 * src/route/oauth/). auth-api answers exactly one question for it: *which
 * human is at the browser*. We therefore speak plain OAuth 2.1 + PKCE to it as
 * a public client -- `mcp-stablecoin-manager`, whose redirect_uri is pinned in
 * auth-api's seeded client table -- and read the claims out of the access token
 * it hands back on the TLS back-channel.
 *
 * We deliberately do NOT hold auth-api's customer JWT secret, so we cannot and
 * do not verify that token's signature. The trust argument is the same one
 * api/mcp/master-api makes about Discord's token response: the value is not a
 * bearer credential we accepted from a caller, it is a response body we
 * received over TLS from the issuer we just POSTed to. It is read once, used
 * for the allowlist decision, and never stored or forwarded.
 */
import type { AuthApiClaims } from '@/types/oauth'
import { decodeJwtPayload } from './allowlist'

export interface AuthApiTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
  provider?: string
}

export function buildAuthApiAuthorizeUrl(params: {
  baseUrl: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    provider: 'google',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
  })
  return `${trimTrailingSlash(params.baseUrl)}/oauth/authorize?${query.toString()}`
}

export class AuthApiExchangeError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    // The detail is auth-api's own error body; it carries no secret of ours.
    super(`auth-api token exchange failed (${status}): ${detail}`)
    this.name = 'AuthApiExchangeError'
    this.status = status
  }
}

export async function exchangeAuthApiCode(params: {
  baseUrl: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}): Promise<{ claims: AuthApiClaims; providerFromResponse?: string }> {
  const response = await fetch(
    `${trimTrailingSlash(params.baseUrl)}/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        code_verifier: params.codeVerifier,
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
      }),
    },
  )

  if (!response.ok) {
    throw new AuthApiExchangeError(
      response.status,
      (await response.text()).slice(0, 500),
    )
  }

  const body = (await response.json()) as AuthApiTokenResponse
  const claims = decodeJwtPayload(body.access_token ?? '')
  if (!claims) {
    throw new AuthApiExchangeError(response.status, 'access_token is unreadable')
  }

  // auth-api reports the provider both in the token and alongside it. Prefer
  // the claim, but keep the envelope value so the caller can notice a mismatch
  // rather than silently trusting whichever is more permissive.
  return { claims, providerFromResponse: body.provider }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
