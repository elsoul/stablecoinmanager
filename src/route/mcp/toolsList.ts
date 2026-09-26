/**
 * The tool surface.
 *
 * Each tool's argument schema is a zod schema, and the JSON Schema we advertise
 * in `tools/list` is DERIVED from it. That is the point: an advertised schema
 * nobody enforces is a promise to the caller that the code does not keep, and
 * two hand-written copies drift the moment one is edited.
 *
 * The count is part of the contract and is asserted in toolsList.test.ts,
 * which grew from 3 to 9 to 13 tools over time. Counting from both the
 * design's table and the implementation is what keeps the two from drifting
 * apart.
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

/**
 * An idempotency key is REQUIRED on every tool that can move money, and it is
 * the replay key: the same key returns the first receipt without signing
 * anything a second time. Making it optional would make "pay twice" the
 * default behaviour of a retry.
 */
const IDEMPOTENCY_KEY = z
  .string()
  .min(8)
  .max(128)
  .describe('Caller-chosen. Reusing it returns the first receipt instead of paying again.')

const INSPECT_ARGS = z.strictObject({
  url: z.string().url(),
  method: z.string().optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  probeTwice: z
    .boolean()
    .optional()
    .describe('Read the 402 twice and report whether its `extra` changed shape between reads.'),
})

const PAY_ARGS = z.strictObject({
  url: z.string().url(),
  idempotencyKey: IDEMPOTENCY_KEY,
  method: z.string().optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

const TOPUP_ARGS = z.strictObject({
  amountCredits: z.number().int().min(1).max(100),
  idempotencyKey: IDEMPOTENCY_KEY,
})

const HISTORY_ARGS = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
})

const RECEIPT_ARGS = z.strictObject({
  idempotencyKey: IDEMPOTENCY_KEY,
})

const PLAN_ARGS = z.strictObject({
  fromSymbol: z.string().optional(),
  toSymbol: z.string().optional(),
  chainId: z.string().optional(),
})

const SWAP_ARGS = z.strictObject({
  fromSymbol: z.string(),
  toSymbol: z.string(),
  chainId: z.string(),
  amountIn: z.string().regex(/^\d+$/, 'atomic units, decimal digits only'),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
})

const BRIDGE_ARGS = z.strictObject({
  fromChainId: z.string(),
  toChainId: z.string(),
  amountIn: z.string().regex(/^\d+$/, 'atomic units, decimal digits only'),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
})

/**
 * 🔴 No `assetPreferences`, no `payTo`, no network allow-list here, and
 * `key` is constrained to the four numeric ceilings. The tool narrows only.
 * A client that could name the field freely could name `allowedPayTo`.
 */
const POLICY_SET_ARGS = z.strictObject({
  key: z.enum(['maxEurcPerPayment', 'maxEurcPerDay', 'maxSlippageBps', 'maxDeadlineSeconds']),
  value: z.number().min(0),
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
    'x402_inspect',
    'Read an x402 402 challenge without paying it: what the resource wants, which requirement this wallet would pay, and what stands in the way. Set probeTwice to detect a requirement whose `extra` changes between reads, which turns a correct signature into price_mismatch.',
    INSPECT_ARGS,
  ),
  tool(
    'x402_pay',
    'Pay an x402 402. Reserves in the ledger before signing, enforces the policy ceilings, and is idempotent on idempotencyKey: the same key returns the first receipt without signing again.',
    PAY_ARGS,
  ),
  tool(
    'erpc_topup',
    'Buy ERPC credit for the account this worker holds the api-key for: mint a billing session, pay the 402 with x402_pay, then poll until the credit is granted and report the invoice number.',
    TOPUP_ARGS,
  ),
  tool(
    'history',
    'Recent payments from the ledger, newest first.',
    HISTORY_ARGS,
  ),
  tool(
    'receipt',
    'One payment in full, by its idempotencyKey. Answers "did that go through?" without paying anything.',
    RECEIPT_ARGS,
  ),
  tool(
    'policy_get',
    'The active ceilings, any runtime overrides, and how much of today\'s allowance is left.',
    NO_ARGS,
  ),
  tool(
    'plan',
    'Say which swaps and bridges are possible TODAY, derived from the SDK catalogue, and name the wishlist item blocking each one that is not. Call this before swap or bridge.',
    PLAN_ARGS,
  ),
  tool(
    'swap',
    'Resolve and constrain a swap route on an allowed network. Returns the route, the quote constraints and the policy. Does NOT sign or broadcast: that step is held back until it can be run in production, and the wallet is unfunded.',
    SWAP_ARGS,
  ),
  tool(
    'bridge',
    'Confirm whether a bridge between two chains is possible from the SDK capability list. Does NOT sign or broadcast: that step is held back until it can be run in production, and the wallet is unfunded.',
    BRIDGE_ARGS,
  ),
  tool(
    'policy_set',
    'TIGHTEN a spending ceiling at runtime, with an audit row. It cannot raise one: the deploy-time value is a hard ceiling and overrides only narrow. Raising a limit requires editing wrangler vars and redeploying.',
    POLICY_SET_ARGS,
  ),
  tool(
    'wallet_export_seed',
    'Reveal the 24-word recovery phrase. Requires confirm:"EXPORT", writes an audit row, and is rate limited. It is the only tool here that returns secret material, and the only way to read the phrase back out of this deployment -- `wrangler secret` has no `get`. It is NOT the only way the phrase can leave: anyone who can deploy code to this worker can read the secret.',
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
