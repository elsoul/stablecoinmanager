export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope?: string
  refresh_token?: string
}

/**
 * The shape this worker consumes from an auth-api access token. auth-api signs
 * it with its own customer JWT secret, which this worker deliberately does NOT
 * hold: the token is read as a value handed to us over TLS by its issuer on a
 * back-channel POST, exactly as api/mcp/master-api reads Discord's token
 * response. We therefore decode, never verify, and we never forward it.
 */
export interface AuthApiClaims {
  sub: string
  provider?: string
  username?: string
  email?: string
  isEmailVerified?: boolean
  iss?: string
  iat?: number
  exp?: number
}

/** What a completed login is allowed to carry into an MCP authorization code. */
export interface AuthorizedIdentity {
  subject: string
  email: string
}
