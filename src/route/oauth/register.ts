// Copied from `api/mcp/master-api/src/route/oauth/register.ts`; the only changes
// are the default scope and routing logging through the redactor.
import { Hono } from 'hono'
import type { AppContext } from '@/types/env'
import { createKVStore } from '@/utils/kv'
import { isAllowedRedirectUri, OAUTH_CLIENT_PREFIX } from './client'
import { safeLog } from '@/utils/redact'

export const registerRouter = new Hono<AppContext>()

function generateUUID(): string {
  return crypto.randomUUID()
}

registerRouter.post('/', async (c) => {
  safeLog(c.env, 'dynamic client registration requested')

  try {
    const body = await c.req.json()
    const kv = createKVStore(c.env.MCP_KV)

    const redirectUris =
      Array.isArray(body.redirect_uris) &&
      body.redirect_uris.every((uri: unknown) => typeof uri === 'string')
        ? (body.redirect_uris as string[])
        : []

    if (
      redirectUris.length === 0 ||
      redirectUris.some((redirectUri) => !isAllowedRedirectUri(redirectUri))
    ) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description:
            'redirect_uris must contain only approved Claude, ChatGPT, or loopback callback URLs',
        },
        400,
      )
    }

    const clientId = `client_${generateUUID()}`
    const tokenEndpointAuthMethod = body.token_endpoint_auth_method || 'none'

    if (
      tokenEndpointAuthMethod !== 'none' &&
      tokenEndpointAuthMethod !== 'client_secret_post'
    ) {
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description:
            'token_endpoint_auth_method must be none or client_secret_post',
        },
        400,
      )
    }

    const clientSecret =
      tokenEndpointAuthMethod === 'client_secret_post'
        ? `secret_${generateUUID()}`
        : undefined

    const clientInfo = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name || 'MCP Client',
      client_uri: body.client_uri,
      redirect_uris: [...new Set(redirectUris)],
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      scope: body.scope || 'wallet',
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      application_type: body.application_type,
      contacts: body.contacts,
      logo_uri: body.logo_uri,
      tos_uri: body.tos_uri,
      policy_uri: body.policy_uri,
      software_id: body.software_id,
      software_version: body.software_version,
    }

    // Store in KV without TTL. Clients (claude.ai, ChatGPT, Codex, ...) cache
    // the client_id from dynamic registration indefinitely and never re-register
    // on their own; an expiring record makes /oauth/authorize reject them with
    // invalid_client once it lapses. We also advertise
    // client_secret_expires_at = 0 (never), so the record must not expire either.
    await kv.set(OAUTH_CLIENT_PREFIX + clientId, JSON.stringify(clientInfo))

    safeLog(c.env, 'client registered', { clientId })

    // Build response (RFC 7591)
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: clientInfo.client_id_issued_at,
    }

    if (clientInfo.client_name) response.client_name = clientInfo.client_name
    if (clientInfo.redirect_uris.length > 0)
      response.redirect_uris = clientInfo.redirect_uris
    if (clientInfo.grant_types.length > 0)
      response.grant_types = clientInfo.grant_types
    if (clientInfo.response_types.length > 0)
      response.response_types = clientInfo.response_types
    if (clientInfo.scope) response.scope = clientInfo.scope
    if (clientInfo.token_endpoint_auth_method)
      response.token_endpoint_auth_method =
        clientInfo.token_endpoint_auth_method

    if (clientSecret) {
      response.client_secret = clientSecret
      response.client_secret_expires_at = 0
    }

    // Optional fields
    for (const key of [
      'client_uri',
      'application_type',
      'contacts',
      'logo_uri',
      'tos_uri',
      'policy_uri',
      'software_id',
      'software_version',
    ]) {
      if ((clientInfo as Record<string, unknown>)[key]) {
        response[key] = (clientInfo as Record<string, unknown>)[key]
      }
    }

    return c.json(response, 201)
  } catch (error) {
    safeLog(c.env, 'registration error', {
      message: error instanceof Error ? error.message : 'unknown',
    })
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to register client',
      },
      500,
    )
  }
})
