import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppContext } from '@/types/env'
import { heldSecrets, redact, safeLog } from '@/utils/redact'
import { advertisedTools, findTool } from './toolsList'
import { walletStatus } from './tools/walletStatus'
import { holdings } from './tools/holdings'
import { walletExportSeed } from './tools/walletExportSeed'
import { fail } from './result'

export const mcpRouter = new Hono<AppContext>()

const PROTOCOL_VERSION = '2025-06-18'

mcpRouter.post('/', async (c) => {
  let body: { method?: string; id?: unknown; params?: Record<string, unknown> }
  try {
    body = await c.req.json()
  } catch {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      400,
    )
  }

  try {
    if (body.method?.startsWith('notifications/')) {
      return new Response(null, { status: 202 })
    }

    if (body.method === 'initialize') {
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'stablecoin-manager', version: '0.1.0' },
        },
      })
    }

    if (body.method === 'ping') {
      return c.json({ jsonrpc: '2.0', id: body.id, result: {} })
    }

    if (body.method === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: advertisedTools() },
      })
    }

    if (body.method === 'tools/call') {
      const name = String(body.params?.name ?? '')
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: await callTool(c, name, args),
      })
    }

    return c.json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32601, message: `Method not found: ${body.method}` },
    })
  } catch (error) {
    safeLog(c.env, 'mcp request failed', {
      method: body.method,
      message: error instanceof Error ? error.message : 'unknown',
    })
    return c.json(
      {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: 'Internal server error' },
      },
      500,
    )
  }
})

async function callTool(
  c: Context<AppContext>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const env = c.env
  const actor = c.get('email')
  // Our own secrets, matched literally on the way out. An upstream error
  // string is the one place a shape rule cannot help.
  const held = heldSecrets(env)

  // Enforce the schema we advertise. Without this the `additionalProperties:
  // false` in tools/list is a claim the code does not keep, and a wallet tool
  // is the wrong place to accept arguments nobody checked.
  const tool = findTool(name)
  if (!tool) {
    return text(
      redact(
        fail({ tool: name }, ['Call tools/list to see the available tools.'], [
          `Unknown tool: ${name}`,
        ]),
        held,
      ),
      true,
    )
  }

  const parsed = tool.schema.safeParse(args)
  if (!parsed.success) {
    return text(
      redact(
        fail({ tool: name }, ['Check tools/list for this tool\'s input schema.'], [
          `Invalid arguments: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
        ]),
        held,
      ),
      true,
    )
  }
  const input = parsed.data as Record<string, unknown>

  try {
    switch (name) {
      case 'wallet_status':
        return text(redact(await walletStatus(env), held))
      case 'holdings':
        return text(redact(await holdings(env, input as { networks?: string[] }), held))
      case 'wallet_export_seed':
        // Deliberately NOT redacted: this result is the secret. See the tool.
        return text(await walletExportSeed(env, input as { confirm?: string }, actor))
      default:
        // findTool already rejected unknown names; this is the exhaustiveness
        // arm, and it fires only if TOOLS gains an entry with no case here.
        return text(
          redact(fail({ tool: name }, [], [`Tool ${name} is listed but not wired`]), held),
          true,
        )
    }
  } catch (error) {
    safeLog(env, 'tool failed', {
      tool: name,
      message: error instanceof Error ? error.message : 'unknown',
    })
    // Redacted like any other result: an exception message is the one string
    // here we did not author, so it is exactly where an upstream library can
    // echo a key or a signed payload back at us.
    return text(
      redact(
        fail({ tool: name }, [], [
          error instanceof Error ? error.message : 'Tool execution failed',
        ]),
        held,
      ),
      true,
    )
  }
}

function text(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

mcpRouter.get('/', (c) => c.text('Method Not Allowed', 405, { Allow: 'POST' }))
mcpRouter.delete('/', (c) => c.text('Method Not Allowed', 405, { Allow: 'POST' }))
