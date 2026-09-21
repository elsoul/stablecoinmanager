import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advertisedTools, findTool, TOOLS, TOOL_NAMES } from './toolsList.ts'

test('PR-1 ships exactly the three read/identity tools', () => {
  // The count is a contract with the plan's tool table: 3 here, 9 after PR-2,
  // 13 after PR-3. A tool added without updating the plan trips this.
  assert.equal(TOOLS.length, 3)
  assert.deepEqual(TOOL_NAMES, ['wallet_status', 'holdings', 'wallet_export_seed'])
})

test('no money-moving tool is exposed yet', () => {
  for (const name of ['x402_pay', 'erpc_topup', 'swap', 'bridge', 'policy_set']) {
    assert.ok(!TOOL_NAMES.includes(name), `${name} must not be listed in PR-1`)
  }
})

test('every tool declares a closed input schema', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, tool.name)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} must not accept unknown arguments`,
    )
  }
})

test('the seed export advertises its confirmation word, and lets the TOOL refuse', () => {
  const tool = findTool('wallet_export_seed')
  assert.ok(tool)
  const properties = tool.inputSchema.properties as Record<string, { const?: string }>
  assert.equal(properties.confirm.const, 'EXPORT')

  // Deliberately NOT required. If zod rejected `{}` the caller would never
  // reach the tool's own refusal, which is where the two-step confirmation
  // actually says what is about to be handed over.
  assert.equal(tool.inputSchema.required, undefined)
  assert.equal(tool.schema.safeParse({}).success, true, 'the tool must see {}')
  assert.equal(
    tool.schema.safeParse({ confirm: 'export' }).success,
    false,
    'but a wrong word is still a schema error',
  )
})

test('the advertised schema is the ENFORCED schema, not a second copy', () => {
  // The failure this prevents: `additionalProperties: false` in tools/list
  // while the code accepts anything. Each tool's JSON Schema is derived from
  // the zod schema that actually parses the arguments.
  for (const tool of TOOLS) {
    assert.equal(tool.schema.safeParse({ nonsense: 1 }).success, false, tool.name)
  }
  assert.equal(findTool('wallet_status')!.schema.safeParse({}).success, true)
  assert.equal(
    findTool('holdings')!.schema.safeParse({ networks: ['solana-mainnet'] }).success,
    true,
  )
  assert.equal(findTool('holdings')!.schema.safeParse({ networks: 'x' }).success, false)
  assert.equal(
    findTool('wallet_export_seed')!.schema.safeParse({ confirm: 'export' }).success,
    false,
    'the confirmation word is exact',
  )
})

test('the zod schema never goes on the wire', () => {
  for (const advertised of advertisedTools()) {
    assert.deepEqual(Object.keys(advertised).sort(), [
      'description',
      'inputSchema',
      'name',
    ])
  }
})

test('findTool answers only for listed names', () => {
  assert.ok(findTool('wallet_status'))
  assert.equal(findTool('x402_pay'), undefined)
  assert.equal(findTool(''), undefined)
})

test('tool names are unique', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length)
})
