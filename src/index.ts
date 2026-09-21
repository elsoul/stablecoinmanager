import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppContext } from '@/types/env'
import { mcpRouter } from '@/route/mcp/index'
import { metadataRouter } from '@/route/oauth/metadata'
import { authorizeRouter } from '@/route/oauth/authorize'
import { callbackRouter } from '@/route/oauth/callback'
import { tokenRouter } from '@/route/oauth/token'
import { registerRouter } from '@/route/oauth/register'
import { verifyMCPToken } from '@/utils/jwt'
import { parseAllowedEmails } from '@/utils/allowlist'
import {
  configState,
  missingMcpSecrets,
  missingOAuthSecrets,
  missingWalletSecrets,
} from '@/lib/runtimeSecrets'
import { safeLog } from '@/utils/redact'

export { WalletLedger } from '@/do/walletLedger'

const VERSION = '0.1.0'

const app = new Hono<AppContext>()

app.use(
  '*',
  cors({
    origin: (origin: string | undefined) => origin || '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'MCP-Protocol-Version',
      'Mcp-Session-Id',
    ],
    exposeHeaders: ['Content-Type', 'Mcp-Session-Id', 'WWW-Authenticate'],
    credentials: true,
  }),
)

// A worker that boots, accepts a login and signs tokens with `undefined` is
// worse than one that refuses. Secrets are operator-set here (slv.toml says
// why), so a fresh deployment genuinely starts without them.
app.use('/oauth/*', async (c, next) => {
  const missing = missingOAuthSecrets(c.env)
  if (missing.length > 0) {
    safeLog(c.env, 'oauth refused: unconfigured', { missing })
    return c.json(
      {
        error: 'server_error',
        error_description:
          `This deployment is not configured yet: ${missing.join(', ')} ` +
          'must be set with `wrangler secret put`.',
      },
      503,
    )
  }
  return await next()
})

app.route('/.well-known', metadataRouter)
app.route('/oauth/authorize', authorizeRouter)
app.route('/oauth/callback', callbackRouter)
app.route('/oauth/token', tokenRouter)
app.route('/oauth/register', registerRouter)

app.use('/mcp/*', async (c, next) => {
  // Only what this surface uses. A whitespace-only JWT_SECRET reads as
  // "missing" to runtimeSecrets but is accepted by sign/verify, so without
  // this the MCP surface would run on a key the operator believes is unset --
  // while guarding on all three OAuth secrets would 503 a live session during
  // an OAUTH_STATE_SECRET rotation.
  const missing = missingMcpSecrets(c.env)
  if (missing.length > 0) {
    safeLog(c.env, 'mcp refused: unconfigured', { missing })
    return c.json(
      {
        error: 'server_error',
        message: `This deployment is not configured yet: ${missing.join(', ')}`,
      },
      503,
    )
  }

  const base = c.env.MCP_SERVER_BASE_URL
  const authHeader = c.req.header('authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    c.header(
      'WWW-Authenticate',
      `Bearer realm="MCP Server", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    )
    return c.json(
      {
        error: 'authentication_required',
        message: 'Authorization required',
        authorization_server: `${base}/.well-known/oauth-authorization-server`,
      },
      401,
    )
  }

  try {
    const payload = await verifyMCPToken(
      authHeader.slice(7).trim(),
      c.env.JWT_SECRET,
      base,
    )

    // The allowlist is re-checked on every call, not just at login. A token
    // issued before an address was removed must stop working immediately --
    // this one controls a wallet, and an hour of residual access is an hour
    // too long.
    const allowed = parseAllowedEmails(c.env.ALLOWED_GOOGLE_EMAILS)
    const email = String(payload.email ?? '').toLowerCase()
    if (allowed.length === 0 || !allowed.includes(email)) {
      throw new Error('Account is no longer authorized for this server')
    }

    c.set('subject', payload.sub)
    c.set('email', email)
    return await next()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Token verification failed'
    safeLog(c.env, 'mcp auth refused', { message })
    c.header(
      'WWW-Authenticate',
      `Bearer realm="MCP Server", error="invalid_token"`,
    )
    return c.json({ error: 'invalid_token', message }, 401)
  }
})

app.route('/mcp', mcpRouter)

app.get('/health', (c) => {
  const base = c.env.MCP_SERVER_BASE_URL
  return c.json({
    status: 'ok',
    server: 'mcp-stablecoin-manager',
    version: VERSION,
    timestamp: new Date().toISOString(),
    authentication: 'oauth2.1_required',
    // Which secrets are absent is not itself a secret, and it is the single
    // most common reason a fresh deployment does nothing.
    config: configState(c.env),
    missingSecrets: [...missingOAuthSecrets(c.env), ...missingWalletSecrets(c.env)],
    wallet: c.env.WALLET_MNEMONIC ? 'initialized' : 'not_initialized',
    oauth: {
      metadata: `${base}/.well-known/oauth-protected-resource`,
      authorization: `${base}/oauth/authorize`,
      token: `${base}/oauth/token`,
    },
  })
})

app.get('/', (c) =>
  c.json({
    server: 'StableCoinManager MCP',
    version: VERSION,
    description:
      'A wallet-holding agent: it reads x402 payment requirements, lines up the stablecoins it needs through the ERPC SDK, pays, and keeps the receipts.',
    mcp: `${c.env.MCP_SERVER_BASE_URL}/mcp`,
  }))

app.notFound((c) =>
  c.json(
    {
      error: 'not_found',
      available_endpoints: {
        metadata: '/.well-known/oauth-protected-resource',
        authorization: '/oauth/authorize',
        token: '/oauth/token',
        register: '/oauth/register',
        mcp: '/mcp',
        health: '/health',
      },
    },
    404,
  ))

app.onError((err, c) => {
  safeLog(c.env, 'unhandled error', { message: err.message })
  return c.json({ error: 'server_error' }, 500)
})

export default { fetch: app.fetch }
