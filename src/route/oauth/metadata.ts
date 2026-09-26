import { Hono } from 'hono'
import type { AppContext } from '@/types/env'

export const metadataRouter = new Hono<AppContext>()

// RFC 9728: OAuth 2.0 Protected Resource Metadata
metadataRouter.get('/oauth-protected-resource', (c) => {
  return c.json({
    resource: c.env.MCP_SERVER_BASE_URL,
    authorization_servers: [c.env.OAUTH_ISSUER],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['HS256'],
  })
})

// RFC 8414: OAuth 2.0 Authorization Server Metadata
metadataRouter.get('/oauth-authorization-server', (c) => {
  const base = c.env.MCP_SERVER_BASE_URL
  return c.json({
    issuer: c.env.OAUTH_ISSUER,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. `plain` would make the code interception this flow guards
    // against trivial again.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['wallet'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['HS256'],
  })
})
