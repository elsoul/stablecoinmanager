import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogPools, catalogTokens } from './catalog.ts'
import { routableSwaps } from '../lib/routes.ts'

// ---------------------------------------------------------------------------
// Driven against the REAL shipped catalogue, not a fixture.
//
// lib/routes.test.ts proves the decision logic on rows I wrote. This proves
// the decision logic meets the rows the SDK actually ships -- which is where
// a field-name or nesting mistake in the mapping would hide. The adapter is
// nested (`adapter.kind`) in the SDK and flat in routes.ts, and a mapping that
// silently produced `undefined` there would make every pool unquotable and
// every answer "not supported", which reads exactly like an honest refusal.
// ---------------------------------------------------------------------------

test('the mapping produces usable rows from the shipped catalogue', () => {
  const tokens = catalogTokens()
  const pools = catalogPools()

  assert.ok(tokens.length > 0, 'the SDK ships tokens')
  assert.ok(pools.length > 0, 'the SDK ships pools')

  // The failure this guards: a wrong path yields undefined everywhere, which
  // still "works" and refuses everything.
  for (const t of tokens) {
    assert.ok(t.deploymentId && t.chainId && t.symbol && t.standard && t.status, JSON.stringify(t))
  }
  for (const p of pools) {
    assert.ok(p.poolDefinitionId && p.chainId && p.adapterKind && p.status, JSON.stringify(p))
    assert.ok(p.token0DeploymentId && p.token1DeploymentId, JSON.stringify(p))
  }
})

test('the real catalogue yields named routes on Ethereum and Avalanche', () => {
  const routes = routableSwaps(catalogTokens(), catalogPools())

  // Not a count: counts move with every SDK release. The property is that
  // routes exist, that they include Ethereum (eip155:1) and Avalanche
  // (eip155:43114), and that the pairs are named rather than discovered-token
  // hashes.
  assert.ok(routes.length > 0, 'at least one pair is quotable today')

  const chains = new Set(routes.map((r) => r.chainId))
  assert.ok(chains.has('eip155:1'), 'Ethereum has reviewed pools')
  assert.ok(chains.has('eip155:43114'), 'Avalanche has reviewed pools')

  // 🔴 Checked on the DEPLOYMENT ID, not the symbol. A discovered token's
  // symbol is its contract address; the `discovered-` marker is on the id.
  // The earlier version of this assertion tested the symbol and matched 0 of
  // 70 tokens -- it could not fail, while 20 of 32 routes went through a
  // discovered token.
  for (const r of routes) {
    for (const id of [r.inputTokenDeploymentId, r.outputTokenDeploymentId]) {
      assert.match(id, /^deployment-\d+$/, `unreviewed token routed: ${id}`)
    }
  }

  // And the guard must be doing work: the catalogue really does ship
  // discovered tokens, so an empty effect would mean the filter is inert.
  const discovered = catalogTokens().filter((t) => !/^deployment-\d+$/.test(t.deploymentId))
  assert.ok(discovered.length > 0, 'the catalogue ships discovered tokens to exclude')
  const pools = catalogPools()
  const touching = pools.filter(
    (pl) =>
      !/^deployment-\d+$/.test(pl.token0DeploymentId) ||
      !/^deployment-\d+$/.test(pl.token1DeploymentId),
  )
  assert.ok(touching.length > 0, 'and pools that reference them, which routableSwaps must drop')
})

test('🔴 Base and Solana yield no routes from the real catalogue', () => {
  // The two claims the plan tool makes about what is NOT possible, checked
  // against the shipped data rather than against the roadmap:
  //   Base   -> no pool at all (W1/W2)
  //   Solana -> pools exist but carry no quote adapter and no fee (W4)
  const routes = routableSwaps(catalogTokens(), catalogPools())
  const chains = new Set(routes.map((r) => r.chainId))

  assert.ok(!chains.has('eip155:8453'), 'Base must not be routable yet')
  for (const chain of chains) {
    assert.ok(!chain.startsWith('solana:'), `Solana must not be routable yet: ${chain}`)
  }

  // Control: Solana pools DO exist in the catalogue, so the absence above is
  // the adapter/fee rule doing its job and not an empty input.
  const solanaPools = catalogPools().filter((p) => p.chainId.startsWith('solana:'))
  assert.ok(solanaPools.length > 0, 'the catalogue does ship Solana pools')
  assert.ok(
    solanaPools.every((p) => p.feeNumerator === null || p.feeDenominator === null),
    'and every Solana pool is missing its fee',
  )
})
