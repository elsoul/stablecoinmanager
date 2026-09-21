/**
 * The tool surface.
 *
 * Each tool's argument schema is a zod schema, and the JSON Schema we advertise
 * in `tools/list` is DERIVED from it. That is the point: an advertised schema
 * nobody enforces is a promise to the caller that the code does not keep, and
 * two hand-written copies drift the moment one is edited.
 *
 * The count is part of the contract and is asserted in toolsList.test.ts:
 * PR-1 ships 3, PR-2 takes it to 9, PR-3 to 13. Counting from both the plan's
 * table and the implementation is what keeps the two from drifting apart.
 */
import { z } from 'zod'

export interface McpTool {
  name: string
  description: string
  schema: z.ZodType
  inputSchema: Record<string, unknown>
}

const NO_ARGS = z.strictObject({})

const HOLDINGS_ARGS = z.strictObject({
  networks: z
    .array(z.string())
    .optional()
    .describe('Optional CAIP-2 subset; defaults to every readable network.'),
})

// `confirm` is OPTIONAL on purpose. Marking it required would have zod reject
// `{}` before the tool runs, and the tool's own refusal is the two-step
// confirmation: it tells the caller, in words, what it is about to hand over.
// Losing that friction is the opposite of what a confirmation gate is for.
const EXPORT_ARGS = z.strictObject({
  confirm: z.literal('EXPORT').optional(),
})

function tool(
  name: string,
  description: string,
  schema: z.ZodType,
): McpTool {
  return {
    name,
    description,
    schema,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
  }
}

export const TOOLS: McpTool[] = [
  tool(
    'wallet_status',
    'Wallet addresses (Solana and EVM), initialization state, ERPC RPC reachability and the active policy ceilings.',
    NO_ARGS,
  ),
  tool(
    'holdings',
    'Native and stablecoin balances across the networks the published ERPC SDK can read today (Solana, Ethereum, Avalanche C-Chain). Base is reported as unsupported_yet until the SDK gains a Base namespace.',
    HOLDINGS_ARGS,
  ),
  tool(
    'wallet_export_seed',
    'Reveal the 24-word recovery phrase. Requires confirm:"EXPORT", writes an audit row, and is rate limited. This is the only way to move the wallet off this deployment, and the only call that returns secret material.',
    EXPORT_ARGS,
  ),
]

export const TOOL_NAMES = TOOLS.map((tool) => tool.name)

/** What `tools/list` puts on the wire -- the zod schema never leaves. */
export function advertisedTools(): Array<
  Pick<McpTool, 'name' | 'description' | 'inputSchema'>
> {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }))
}

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((tool) => tool.name === name)
}
