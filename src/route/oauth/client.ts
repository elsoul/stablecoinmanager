// Copied from `api/mcp/master-api/src/route/oauth/client.ts` (only the doc
// comment on isAllowedRedirectUri reworded). The redirect_uri allowlist is
// deliberately identical, so a widening in either worker is visible as a diff
// against the other.
const CLAUDE_HOSTED_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CHATGPT_CONNECTOR_HOST = 'chatgpt.com'
const CHATGPT_CONNECTOR_PATH_PREFIX = '/connector/oauth/'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOOPBACK_CALLBACK_PATH = /^\/(?:oauth\/)?callback(?:\/[A-Za-z0-9_-]+)?$/

function getRawPathname(uri: string): string | null {
  const schemeSeparator = uri.indexOf('://')
  if (schemeSeparator === -1) return null

  const pathnameStart = uri.indexOf('/', schemeSeparator + 3)
  return pathnameStart === -1 ? '/' : uri.slice(pathnameStart)
}

export const OAUTH_CLIENT_PREFIX = 'oauth_client:'

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post'

export interface RegisteredOAuthClient {
  client_id: string
  client_name?: string
  client_secret?: string
  redirect_uris: string[]
  token_endpoint_auth_method: TokenEndpointAuthMethod
}

/**
 * This wallet-holding authorization server accepts callbacks only for
 * Anthropic's hosted Claude client, ChatGPT connector callbacks, and RFC 8252
 * loopback clients. Arbitrary web origins and custom URI schemes are not
 * trusted registration targets.
 *
 * Dynamic registration is open by design (that is what lets any MCP client
 * connect), so this allowlist carries the weight on the registration path.
 * Widening it widens who can be handed an authorization code for a wallet.
 *
 * It is checked on every route in this worker that can reach `encodeState`,
 * which is `route/oauth/authorize.ts` and only that one -- measured, not
 * assumed, because auth-api has a third route (`loginUrl.ts`) that reaches its
 * own `encodeState` without consulting its seeded-client table. Any new route
 * added here that mints state has to consult this allowlist too.
 */
export function isAllowedRedirectUri(redirectUri: string): boolean {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return false
  }

  if (url.username || url.password || url.hash || url.search) {
    return false
  }

  if (url.protocol === 'https:') {
    return (
      url.toString() === CLAUDE_HOSTED_CALLBACK ||
      (url.hostname === CHATGPT_CONNECTOR_HOST &&
        url.pathname.startsWith(CHATGPT_CONNECTOR_PATH_PREFIX) &&
        url.pathname.length > CHATGPT_CONNECTOR_PATH_PREFIX.length)
    )
  }

  const rawPathname = getRawPathname(redirectUri)

  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    rawPathname !== null &&
    rawPathname === url.pathname &&
    LOOPBACK_CALLBACK_PATH.test(rawPathname)
  )
}

function parseRegisteredClient(
  value: string,
  expectedClientId: string,
): RegisteredOAuthClient | null {
  try {
    const client = JSON.parse(value) as Record<string, unknown>
    const redirectUris = client.redirect_uris
    const authMethod = client.token_endpoint_auth_method

    if (
      client.client_id !== expectedClientId ||
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every(
        (uri) => typeof uri === 'string' && isAllowedRedirectUri(uri),
      ) ||
      (authMethod !== 'none' && authMethod !== 'client_secret_post') ||
      (authMethod === 'client_secret_post' &&
        typeof client.client_secret !== 'string')
    ) {
      return null
    }

    return client as unknown as RegisteredOAuthClient
  } catch {
    return null
  }
}

export async function getRegisteredClient(
  kv: { get(key: string): Promise<string | null> },
  clientId: string,
): Promise<RegisteredOAuthClient | null> {
  const stored = await kv.get(OAUTH_CLIENT_PREFIX + clientId)
  return stored ? parseRegisteredClient(stored, clientId) : null
}
