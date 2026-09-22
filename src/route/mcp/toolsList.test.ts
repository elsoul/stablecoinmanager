import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { advertisedTools, findTool, TOOLS, TOOL_NAMES } from './toolsList.ts'

test('PR-2 ships exactly nine tools', () => {
  // The count is a contract with the plan's tool table: 3 after PR-1, 9 here,
  // 13 after PR-3. A tool added without updating the plan trips this.
  assert.equal(TOOLS.length, 9)
  assert.deepEqual(TOOL_NAMES, [
    'wallet_status',
    'holdings',
    'x402_inspect',
    'x402_pay',
    'erpc_topup',
    'history',
    'receipt',
    'policy_get',
    'wallet_export_seed',
  ])
})

test('PR-3 tools are not exposed yet', () => {
  for (const name of ['plan', 'swap', 'bridge', 'policy_set']) {
    assert.ok(!TOOL_NAMES.includes(name), `${name} must not be listed in PR-2`)
  }
})

test('every money-moving tool requires an idempotency key', () => {
  // Without it, a retried tool call is a second payment. Optional would make
  // paying twice the default behaviour of a timeout.
  for (const name of ['x402_pay', 'erpc_topup', 'receipt']) {
    const tool = findTool(name)
    assert.ok(tool, name)
    assert.ok(
      (tool.inputSchema.required as string[]).includes('idempotencyKey'),
      `${name} must require idempotencyKey`,
    )
    assert.equal(tool.schema.safeParse({ url: 'https://x.test/', amountCredits: 1 }).success, false)
  }
})

test('x402_inspect cannot move money: it takes no idempotency key', () => {
  const tool = findTool('x402_inspect')
  assert.ok(tool)
  assert.ok(!('idempotencyKey' in (tool.inputSchema.properties as object)))
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
  assert.equal(findTool('swap'), undefined)
  assert.equal(findTool(''), undefined)
})

test('tool names are unique', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length)
})

// ---------------------------------------------------------------------------
// wallet_export_seed's description tells the model it is "the only tool here
// that returns secret material". A tool description is read by the client's
// model and shapes what it is willing to call, so an inaccurate one is not a
// documentation defect -- and it is the kind of claim that stays in the file
// long after a new tool makes it false.
//
// So it is checked rather than asserted. The predicate: outside
// walletExportSeed.ts, every mention of the mnemonic must be handed straight
// to a derivation call on the same expression. Binding it to a local is how it
// reaches a result object, and that is what this rejects.
// ---------------------------------------------------------------------------

test('only wallet_export_seed can put the mnemonic in a result', () => {
  const dir = join(import.meta.dirname, 'tools')
  const files = readdirSync(dir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  )

  // Vacuity guard: an empty directory listing would pass the loop below.
  assert.ok(files.length >= 7, `expected the tool handlers, found ${files.length}`)

  // And the exporter must actually be here, or the exemption below is
  // exempting nothing.
  assert.ok(files.includes('walletExportSeed.ts'), 'the exporter is in this set')

  for (const name of files) {
    if (name === 'walletExportSeed.ts') continue
    const source = readFileSync(join(dir, name), 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      // String literals are stripped first. Several handlers name the secret in
      // an operator-facing message ("Run wallet:init to store the
      // WALLET_MNEMONIC secret"), and a predicate that cannot tell prose from a
      // read reports those -- measured: the first version of this test failed
      // on walletStatus.ts:23, which is a sentence. Stripping literals also
      // catches the destructuring form, which `env.WALLET_MNEMONIC` would miss.
      const code = stripLiterals(line)
      if (!code.includes('WALLET_MNEMONIC')) continue
      assert.match(
        code,
        /derive[A-Za-z]*\(\s*env\.WALLET_MNEMONIC/,
        `${name}:${index + 1} reads the mnemonic outside a derivation call`,
      )
    }
  }
})

/** Blank out '...', "..." and `...` so prose about the secret is not a read. */
function stripLiterals(line: string): string {
  return line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")
}
