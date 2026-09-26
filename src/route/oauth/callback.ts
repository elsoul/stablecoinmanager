import { Hono } from 'hono'
import type { AppContext } from '@/types/env'
import type { AuthApiClaims } from '@/types/oauth'
import { decodeState } from '@/utils/state'
import { createKVStore } from '@/utils/kv'
import { exchangeAuthApiCode } from '@/utils/authApi'
import { exchangeAppOidcCode, oidcTxnKey, resolveAppOidcConfig } from '@/utils/appOidc'
import { getAppOidcJwksClient } from '@/utils/appOidcJwks'
import { resolveAuthProvider } from '@/utils/authProvider'
import { evaluateLogin } from '@/utils/allowlist'
import { safeLog } from '@/utils/redact'
import { getRegisteredClient } from './client'

export const callbackRouter = new Hono<AppContext>()

export const AUTH_CODE_PREFIX = 'auth_code:'
const AUTH_CODE_TTL = 600

function generateAuthorizationCode(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

callbackRouter.get('/', async (c) => {
  try {
    const provider = resolveAuthProvider(c.env)
    const code = c.req.query('code')
    const state = c.req.query('state')
    const upstreamError = c.req.query('error')

    if (upstreamError) {
      return c.json(
        {
          error: upstreamError,
          error_description: c.req.query('error_description') || 'Login failed',
        },
        400,
      )
    }

    if (!code || !state) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing code or state parameter',
        },
        400,
      )
    }

    const stateData = await decodeState(state, c.env.OAUTH_STATE_SECRET)
    const kv = createKVStore(c.env.MCP_KV)

    if (!stateData.clientId || !stateData.redirectUri || (provider !== 'app-oidc' && !stateData.upstreamVerifier)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Signed state is missing its client binding',
        },
        400,
      )
    }

    // Re-check the client here too: registration can have been removed between
    // /authorize and the return trip, and this is the moment the code is minted.
    const client = await getRegisteredClient(kv, stateData.clientId)
    if (!client || !client.redirect_uris.includes(stateData.redirectUri)) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'OAuth client is no longer registered',
        },
        400,
      )
    }

    let loginClaims: AuthApiClaims
    if (provider === 'app-oidc') {
      const appOidcConfig = resolveAppOidcConfig(c.env)

      const issParam = c.req.query('iss')
      if (issParam !== appOidcConfig.issuer) {
        safeLog(c.env, 'login refused', { reason: 'app_oidc_iss_param_mismatch' })
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Identity provider could not be established',
          },
          403,
        )
      }

      const txnKey = await oidcTxnKey(state)
      const verifier = await kv.get(txnKey)
      await kv.del(txnKey)
      if (!verifier) {
        safeLog(c.env, 'login refused', { reason: 'app_oidc_txn_missing' })
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Identity provider could not be established',
          },
          403,
        )
      }

      const result = await exchangeAppOidcCode({
        issuer: appOidcConfig.issuer,
        clientId: appOidcConfig.clientId,
        redirectUri: `${c.env.MCP_SERVER_BASE_URL}/oauth/callback`,
        code,
        codeVerifier: verifier,
        expectedNonce: stateData.nonce,
        now: () => Date.now(),
        getJwks: (opts) => getAppOidcJwksClient(appOidcConfig.issuer).getJwks(opts),
      })

      if (!result.ok) {
        safeLog(c.env, 'login refused', { reason: `app_oidc_${result.reason}` })
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Identity provider could not be established',
          },
          403,
        )
      }

      loginClaims = result.claims
    } else {
      if (!stateData.upstreamVerifier) {
        throw new Error('unreachable: upstreamVerifier missing outside the app-oidc branch')
      }
      const { claims, providerFromResponse } = await exchangeAuthApiCode({
        baseUrl: c.env.AUTH_API_BASE_URL,
        clientId: c.env.AUTH_API_CLIENT_ID,
        redirectUri: `${c.env.MCP_SERVER_BASE_URL}/oauth/callback`,
        code,
        codeVerifier: stateData.upstreamVerifier,
      })

      // The token claim and the response envelope must agree. If they do not,
      // something is answering that is not the auth-api we think it is.
      if (providerFromResponse && providerFromResponse !== claims.provider) {
        safeLog(c.env, 'provider mismatch between token claim and response envelope')
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Identity provider could not be established',
          },
          403,
        )
      }
      loginClaims = claims
    }

    const decision = evaluateLogin(loginClaims, c.env.ALLOWED_GOOGLE_EMAILS)
    if (!decision.ok) {
      // The reason is logged, not returned: an unauthorized caller learns only
      // that they are unauthorized, never why or who would be.
      safeLog(c.env, 'login refused', { reason: decision.reason })
      return c.json(
        {
          error: 'access_denied',
          error_description:
            'This MCP server is single-owner. Your account is not authorized.',
        },
        403,
      )
    }

    const authCode = generateAuthorizationCode()
    await kv.set(
      AUTH_CODE_PREFIX + authCode,
      JSON.stringify({
        subject: decision.identity.subject,
        email: decision.identity.email,
        resource: stateData.resource,
        codeChallenge: stateData.codeChallenge,
        clientId: stateData.clientId,
        redirectUri: stateData.redirectUri,
        expiresAt: Date.now() + AUTH_CODE_TTL * 1000,
      }),
      'EX',
      AUTH_CODE_TTL,
    )

    safeLog(c.env, 'login authorized')

    const callbackUrl = new URL(stateData.redirectUri)
    callbackUrl.searchParams.set('code', authCode)
    if (stateData.clientState) {
      callbackUrl.searchParams.set('state', stateData.clientState)
    }
    return c.redirect(callbackUrl.toString())
  } catch (error) {
    safeLog(c.env, 'callback error', {
      message: error instanceof Error ? error.message : 'unknown',
    })
    return c.json(
      { error: 'server_error', error_description: 'Login failed' },
      500,
    )
  }
})
