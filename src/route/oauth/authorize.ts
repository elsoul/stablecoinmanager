import { Hono } from 'hono'
import type { AppContext } from '@/types/env'
import { buildAuthApiAuthorizeUrl } from '@/utils/authApi'
import { buildAppOidcAuthorizeUrl, oidcTxnKey, resolveAppOidcConfig } from '@/utils/appOidc'
import { resolveAuthProvider } from '@/utils/authProvider'
import { generateCodeChallenge, generateCodeVerifier } from '@/utils/pkce'
import { encodeState, generateNonce } from '@/utils/state'
import { createKVStore } from '@/utils/kv'
import { safeLog } from '@/utils/redact'
import { getRegisteredClient } from './client'

export const authorizeRouter = new Hono<AppContext>()

authorizeRouter.get('/', async (c) => {
  try {
    const provider = resolveAuthProvider(c.env)
    const responseType = c.req.query('response_type')
    const clientId = c.req.query('client_id')
    const redirectUri = c.req.query('redirect_uri')
    const clientState = c.req.query('state')
    const codeChallenge = c.req.query('code_challenge')
    const codeChallengeMethod = c.req.query('code_challenge_method')
    const resource = c.req.query('resource') || c.env.MCP_SERVER_BASE_URL

    if (responseType !== 'code') {
      return c.json(
        {
          error: 'unsupported_response_type',
          error_description: 'Only "code" response type is supported',
        },
        400,
      )
    }

    if (!clientId) {
      return c.json(
        { error: 'invalid_request', error_description: 'client_id is required' },
        400,
      )
    }

    const kv = createKVStore(c.env.MCP_KV)
    const client = await getRegisteredClient(kv, clientId)
    if (!client) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Unknown or invalid client_id',
        },
        400,
      )
    }

    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'redirect_uri must exactly match a registered callback',
        },
        400,
      )
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PKCE (S256) code_challenge is required',
        },
        400,
      )
    }

    // A second, independent PKCE pair for the upstream leg. The verifier never
    // leaves this worker: it rides inside the HMAC-signed state and comes back
    // on our own callback.
    const upstreamVerifier = generateCodeVerifier()
    const upstreamChallenge = await generateCodeChallenge(upstreamVerifier)

    // app-oidc: an early return. The upstream PKCE verifier goes into
    // MCP_KV rather than into state -- see appOidc.ts.
    if (provider === 'app-oidc') {
      const appOidcConfig = resolveAppOidcConfig(c.env)
      const nonce = generateNonce()
      const appOidcState = await encodeState(
        {
          resource: resource.replace(/\/$/, ''),
          codeChallenge,
          timestamp: Date.now(),
          nonce,
          redirectUri,
          clientState: clientState || undefined,
          clientId,
        },
        c.env.OAUTH_STATE_SECRET,
      )

      if (appOidcState.length > 2048) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Encoded state exceeds the upstream size limit',
          },
          400,
        )
      }

      await kv.set(await oidcTxnKey(appOidcState), upstreamVerifier, 'EX', 600)

      safeLog(c.env, 'authorization request accepted', { clientId })

      return c.redirect(
        buildAppOidcAuthorizeUrl({
          issuer: appOidcConfig.issuer,
          clientId: appOidcConfig.clientId,
          redirectUri: `${c.env.MCP_SERVER_BASE_URL}/oauth/callback`,
          codeChallenge: upstreamChallenge,
          state: appOidcState,
          nonce,
        }),
      )
    }

    const state = await encodeState(
      {
        resource: resource.replace(/\/$/, ''),
        codeChallenge,
        timestamp: Date.now(),
        nonce: generateNonce(),
        redirectUri,
        clientState: clientState || undefined,
        clientId,
        upstreamVerifier,
      },
      c.env.OAUTH_STATE_SECRET,
    )

    safeLog(c.env, 'authorization request accepted', { clientId })

    return c.redirect(
      buildAuthApiAuthorizeUrl({
        baseUrl: c.env.AUTH_API_BASE_URL,
        clientId: c.env.AUTH_API_CLIENT_ID,
        redirectUri: `${c.env.MCP_SERVER_BASE_URL}/oauth/callback`,
        codeChallenge: upstreamChallenge,
        state,
      }),
    )
  } catch (error) {
    safeLog(c.env, 'authorization error', {
      message: error instanceof Error ? error.message : 'unknown',
    })
    return c.json(
      { error: 'server_error', error_description: 'Authorization failed' },
      500,
    )
  }
})
