import { Hono } from 'hono'
import type { AppContext } from '@/types/env'
import { createKVStore } from '@/utils/kv'
import { verifyPKCE } from '@/utils/pkce'
import {
  consumeRefreshToken,
  generateMCPToken,
  generateRefreshToken,
} from '@/utils/jwt'
import { safeLog } from '@/utils/redact'
import { getRegisteredClient } from './client'
import { AUTH_CODE_PREFIX } from './callback'

export const tokenRouter = new Hono<AppContext>()

interface StoredAuthCode {
  subject: string
  email: string
  resource: string
  codeChallenge: string
  clientId: string
  redirectUri: string
  expiresAt: number
}

tokenRouter.post('/', async (c) => {
  try {
    const form = await c.req.parseBody()
    const grantType = String(form.grant_type ?? '')
    const clientId = String(form.client_id ?? '')

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
        { error: 'invalid_client', error_description: 'Unknown client_id' },
        401,
      )
    }

    if (client.token_endpoint_auth_method === 'client_secret_post') {
      const presented = String(form.client_secret ?? '')
      // Length check first so the comparison below cannot be a length oracle.
      if (
        !presented ||
        !client.client_secret ||
        presented.length !== client.client_secret.length ||
        !timingSafeEqual(presented, client.client_secret)
      ) {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'client authentication failed',
          },
          401,
        )
      }
    }

    const expiresIn = Number(c.env.JWT_EXPIRES_IN) || 3600

    if (grantType === 'authorization_code') {
      const code = String(form.code ?? '')
      const codeVerifier = String(form.code_verifier ?? '')
      const redirectUri = String(form.redirect_uri ?? '')

      if (!code || !codeVerifier) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'code and code_verifier are required',
          },
          400,
        )
      }

      const key = AUTH_CODE_PREFIX + code
      const raw = await kv.get(key)
      // Single use: the code is destroyed before anything else can fail, so a
      // failed exchange can never be retried into a second token.
      await kv.del(key)

      if (!raw) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Authorization code is invalid or expired',
          },
          400,
        )
      }

      const stored = JSON.parse(raw) as StoredAuthCode

      if (stored.expiresAt < Date.now()) {
        return c.json(
          { error: 'invalid_grant', error_description: 'Authorization code expired' },
          400,
        )
      }
      if (stored.clientId !== clientId) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Authorization code was issued to another client',
          },
          400,
        )
      }
      // RFC 6749 §4.1.3: the exchange MUST present the same redirect_uri.
      // `/oauth/authorize` always requires one, so it is always bound -- and a
      // check written as `redirectUri && ...` would let a caller delete the
      // binding simply by omitting the parameter.
      if (!redirectUri || redirectUri !== stored.redirectUri) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'redirect_uri does not match the authorization request',
          },
          400,
        )
      }
      if (!(await verifyPKCE(codeVerifier, stored.codeChallenge))) {
        return c.json(
          { error: 'invalid_grant', error_description: 'PKCE verification failed' },
          400,
        )
      }

      const identity = { subject: stored.subject, email: stored.email }
      safeLog(c.env, 'access token issued', { clientId })

      return c.json({
        access_token: await generateMCPToken(
          identity,
          stored.resource,
          c.env.JWT_SECRET,
          expiresIn,
        ),
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: await generateRefreshToken(
          kv,
          identity,
          stored.resource,
          clientId,
          c.env.REFRESH_TOKEN_SECRET,
        ),
        scope: 'wallet',
      })
    }

    if (grantType === 'refresh_token') {
      const refreshToken = String(form.refresh_token ?? '')
      if (!refreshToken) {
        return c.json(
          { error: 'invalid_request', error_description: 'refresh_token is required' },
          400,
        )
      }

      let data
      try {
        // Single use: the stored entry is destroyed inside this call, so the
        // presented token cannot be replayed.
        data = await consumeRefreshToken(
          kv,
          refreshToken,
          c.env.REFRESH_TOKEN_SECRET,
        )
      } catch {
        return c.json(
          { error: 'invalid_grant', error_description: 'Refresh token is invalid' },
          400,
        )
      }

      // RFC 6749 §6. Every client here registers with
      // `token_endpoint_auth_method: 'none'`, so without this a different
      // client could redeem someone else's refresh token.
      if (data.clientId !== clientId) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Refresh token was issued to another client',
          },
          400,
        )
      }

      const identity = { subject: data.subject, email: data.email }
      safeLog(c.env, 'access token refreshed', { clientId })

      return c.json({
        access_token: await generateMCPToken(
          identity,
          data.resource,
          c.env.JWT_SECRET,
          expiresIn,
        ),
        token_type: 'Bearer',
        expires_in: expiresIn,
        // Rotation: the caller always leaves with a different refresh token
        // than it arrived with, so a captured one stops working the moment the
        // legitimate client refreshes.
        refresh_token: await generateRefreshToken(
          kv,
          identity,
          data.resource,
          clientId,
          c.env.REFRESH_TOKEN_SECRET,
        ),
        scope: 'wallet',
      })
    }

    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description:
          'Only authorization_code and refresh_token grants are supported',
      },
      400,
    )
  } catch (error) {
    safeLog(c.env, 'token endpoint error', {
      message: error instanceof Error ? error.message : 'unknown',
    })
    return c.json(
      { error: 'server_error', error_description: 'Token exchange failed' },
      500,
    )
  }
})

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
