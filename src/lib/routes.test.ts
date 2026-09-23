import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QUOTABLE_ADAPTERS,
  routableSwaps,
  swapRefusal,
  unsupported,
  WISH_REASON,
  type PoolRow,
  type TokenRow,
} from './routes.ts'

// ---------------------------------------------------------------------------
// These rows mirror the shipped @elsoul/erpc-sdk 0.8.0 catalogue, measured
// 2026-09-22. The point of the module is to answer "can you do this today?"
// honestly, so the fixtures reproduce the three situations the real catalogue
// actually contains -- not three invented ones.
// ---------------------------------------------------------------------------

// Ids use the catalogue's curated shape (`deployment-<n>`). That is not
// cosmetic: routableSwaps only routes curated tokens, so a fixture with
// invented ids would exercise the rejection path for every case and the
// positive tests would pass vacuously.
const TOKENS: TokenRow[] = [
  { deploymentId: 'deployment-0002', chainId: 'eip155:1', symbol: 'WETH', standard: 'erc20', status: 'active' },
  { deploymentId: 'deployment-0008', chainId: 'eip155:1', symbol: 'USDC', standard: 'erc20', status: 'active' },
  { deploymentId: 'deployment-0001', chainId: 'eip155:1', symbol: 'ETH', standard: 'native', status: 'active' },
  { deploymentId: 'deployment-0014', chainId: 'solana:x', symbol: 'WSOL', standard: 'spl-token', status: 'active' },
  { deploymentId: 'deployment-0013', chainId: 'solana:x', symbol: 'EURC', standard: 'spl-token', status: 'active' },
  { deploymentId: 'deployment-0099', chainId: 'eip155:1', symbol: 'OLD', standard: 'erc20', status: 'retired' },
]

const pool = (over: Partial<PoolRow>): PoolRow => ({
  poolDefinitionId: 'p',
  chainId: 'eip155:1',
  token0DeploymentId: 'deployment-0008',
  token1DeploymentId: 'deployment-0002',
  adapterKind: 'evm-constant-product-v2',
  feeNumerator: '3',
  feeDenominator: '1000',
  status: 'active',
  ...over,
})

test('a reviewed EVM pool yields both directions', () => {
  const routes = routableSwaps(TOKENS, [pool({})])
  assert.equal(routes.length, 2)
  assert.deepEqual(
    routes.map((r) => `${r.inputSymbol}->${r.outputSymbol}`).sort(),
    ['USDC->WETH', 'WETH->USDC'],
  )
})

test('🔴 a pool whose tokens are not in the curated table is not routable', () => {
  // The shipped catalogue carries pools referencing `discovered-token-<hash>`
  // entries that have no symbol. They are real pools; they are not reviewed
  // ones, and a money tool should not route through a token nobody named.
  // The token must EXIST in the table and be uncurated -- the earlier version
  // used an id absent from the fixture, so it was measuring "unknown token"
  // rather than "known but not reviewed", which is the real situation.
  const withDiscovered: TokenRow[] = [
    ...TOKENS,
    {
      deploymentId: 'discovered-token-abc123',
      chainId: 'eip155:1',
      symbol: '0x50b7545627a5162f82a992c33b87adc75187b218',
      standard: 'erc20',
      status: 'active',
    },
  ]
  const routes = routableSwaps(withDiscovered, [
    pool({ token0DeploymentId: 'discovered-token-abc123' }),
  ])
  assert.deepEqual(routes, [])

  // Control: the same pool with a curated token on both sides IS routable, so
  // the rejection above is the curation rule and not a broken fixture.
  assert.equal(routableSwaps(withDiscovered, [pool({})]).length, 2)
})

test('🔴 a Solana pool is not routable: no quote adapter and no fee', () => {
  // Measured in the shipped dist: solana-orca-whirlpool and
  // solana-raydium-clmm appear as catalogue data with one code reference each
  // (evm-constant-product-v2 has twenty), and both Solana pools carry null for
  // feeNumerator and feeDenominator -- a constant-product quote is arithmetic
  // on the fee.
  const orca = pool({
    chainId: 'solana:x',
    token0DeploymentId: 'deployment-0014',
    token1DeploymentId: 'deployment-0013',
    adapterKind: 'solana-orca-whirlpool',
    feeNumerator: null,
    feeDenominator: null,
  })
  assert.deepEqual(routableSwaps(TOKENS, [orca]), [])

  // Both conditions are checked, not just whichever fires first: an adapter
  // that gains quote code but still ships null fees must still refuse.
  const quotableButFeeless = { ...orca, adapterKind: 'evm-constant-product-v2' }
  assert.deepEqual(routableSwaps(TOKENS, [quotableButFeeless]), [])

  // And a Solana adapter with a fee is still refused, because the adapter is
  // what cannot be quoted.
  const feeButUnquotable = { ...orca, feeNumerator: '3', feeDenominator: '1000' }
  assert.deepEqual(routableSwaps(TOKENS, [feeButUnquotable]), [])
})

test('🔴 a native asset cannot be the INPUT, but can be the output', () => {
  // The preparation's transaction is `value: '0'` and its path entries are
  // `standard: 'erc20'`, so native ETH cannot start a swap. The plan's stated
  // canary, "0.001 ETH -> USDC", is not executable as written; WETH -> USDC is.
  const routes = routableSwaps(TOKENS, [
    pool({ token0DeploymentId: 'deployment-0001', token1DeploymentId: 'deployment-0008' }),
  ])
  assert.deepEqual(routes.map((r) => `${r.inputSymbol}->${r.outputSymbol}`), ['USDC->ETH'])
})

test('a retired token or pool is not routable', () => {
  assert.deepEqual(routableSwaps(TOKENS, [pool({ status: 'retired' })]), [])
  assert.deepEqual(
    routableSwaps(TOKENS, [pool({ token0DeploymentId: 'deployment-0099' })]),
    [],
  )
})

test('the refusal names the wishlist item, and distinguishes "not yet" from "not this pair"', () => {
  // Two different answers: waiting on the SDK, versus this pair is not
  // reviewed and another one on the same chain may work today.
  assert.equal(swapRefusal('eip155:8453', 'EURC/USDC').needs, 'W2')
  assert.equal(swapRefusal('solana:x', 'WSOL/EURC').needs, 'W4')

  const unreviewed = swapRefusal('eip155:1', 'FOO/BAR')
  assert.equal(unreviewed.needs, null)
  assert.match(unreviewed.why, /not a wishlist gap/)
})

test('every wishlist item carries a reason, and the reasons are distinct', () => {
  const reasons = Object.values(WISH_REASON)
  assert.equal(reasons.length, 4)
  assert.equal(new Set(reasons).size, 4, 'a shared reason would hide which one is missing')
  for (const [wish, why] of Object.entries(WISH_REASON)) {
    assert.ok(why.length > 20, `${wish} needs a real reason, not a label`)
    assert.equal(unsupported(wish as 'W1').why, why)
  }
})

test('the quotable-adapter list is a list, not a wildcard', () => {
  // A future SDK adding an adapter must be a deliberate edit here, not an
  // automatic inclusion: the whole module exists to refuse what it cannot
  // actually quote.
  assert.deepEqual([...QUOTABLE_ADAPTERS], ['evm-constant-product-v2'])
})
