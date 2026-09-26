import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createErpcClient, getTokenDeployment, tokens } from '@elsoul/erpc-sdk'
import type { Env } from '@/types/env'
import { createGateway, probeReachability } from '@/chain/gateway'
import { deriveAddresses } from '@/wallet/keys'
import { balanceOfCalldata, holdings, hexToAtomic, readHoldings, wordToAtomic } from './holdings.ts'

// The production wallet (EVM side). Public: it is the payTo-facing address
// shown by wallet_status and on Basescan.
const WALLET = '0x7A5837f5bB52C53e08fcFf214c2Cd11daa8EF9EE' as const
const SOLANA_PLACEHOLDER = '11111111111111111111111111111111'
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const BASE_EURC = getTokenDeployment(tokens.base.EURC)!
const BASE_USDC = getTokenDeployment(tokens.base.USDC)!

/** A catalogue deployment's contract address, lower-cased; a token without one is a test setup error. */
function catalogueAddress(deploymentId: string): string {
  const address = getTokenDeployment(deploymentId)?.address
  if (!address) throw new Error(`catalogue deployment ${deploymentId} has no contract address`)
  return address.toLowerCase()
}

/** The catalogue addresses each stubbed host answers `balanceOf` for. */
const CATALOGUE_BY_CHAIN: Record<'ethereum' | 'base' | 'avalanche', string[]> = {
  ethereum: [tokens.ethereum.EURC, tokens.ethereum.USDC].map(catalogueAddress),
  base: [tokens.base.EURC, tokens.base.USDC].map(catalogueAddress),
  avalanche: [tokens.avalancheC.EURC, tokens.avalancheC.USDC].map(catalogueAddress),
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

interface Call {
  host: string
  path: string
  method: string
  params: unknown[]
}

/**
 * A chain stub: 5.5 EURC and 0 ETH on Base for `owner`, a zero word for the
 * other catalogue tokens. It answers `balanceOf` only for `owner` (any other
 * calldata is an RPC error) and only at the requested chain's catalogue
 * addresses -- any other `to` gets `0x`, the answer a node gives for an
 * address with no contract code -- so a wrong owner or a wrong token address
 * surfaces as a warning, never as a plausible zero. Every EVM host answers
 * its own chain id, as the real endpoints do, unless `misrouteBase` points
 * the Base host at Ethereum mainnet.
 */
function installChain(
  owner: string,
  opts: { failBaseUsdc?: boolean; emptyBaseUsdc?: boolean; misrouteBase?: boolean } = {},
): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] }
    calls.push({ host: url.hostname, path: url.pathname, method: body.method, params: body.params })
    const isBase = url.hostname === 'base.erpc.global'
    const chainOf = isBase ? 'base' : url.pathname.startsWith('/ava') ? 'avalanche' : 'ethereum'
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    switch (body.method) {
      case 'getBalance':
        return reply({ context: { slot: 1 }, value: 0 })
      case 'eth_getBalance':
        return reply('0x0')
      case 'eth_chainId':
        if (isBase) return reply(opts.misrouteBase ? '0x1' : '0x2105')
        return reply(url.pathname.startsWith('/ava') ? '0xa86a' : '0x1')
      case 'eth_call': {
        const [tx] = body.params as [{ to: string; data: string }]
        if (tx.data !== balanceOfCalldata(owner)) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'unexpected calldata' } }))
        }
        // Not this chain's catalogue address: no contract code here, and a
        // node answers such a call with `0x`. This is what pins the address.
        if (!CATALOGUE_BY_CHAIN[chainOf].includes(tx.to.toLowerCase())) return reply('0x')
        if (isBase && tx.to === BASE_EURC.address) return reply('0x' + (5_500_000).toString(16).padStart(64, '0'))
        if (isBase && tx.to === BASE_USDC.address && opts.failBaseUsdc) {
          return new Response('upstream down', { status: 502 })
        }
        // What a node answers for a call to an address with no contract code.
        if (isBase && tx.to === BASE_USDC.address && opts.emptyBaseUsdc) return reply('0x')
        return reply('0x' + '0'.repeat(64))
      }
      default:
        return new Response('unexpected method', { status: 500 })
    }
  }) as typeof fetch
  return calls
}

const client = () => createErpcClient({ apiKey: 'test-key-0000000000' })

test('Base: EURC 5.5 and ETH 0 for the production wallet, read via the SDK catalogue', async () => {
  const calls = installChain(WALLET)
  const { entries, unsupported, warnings } = await readHoldings(
    client(),
    { solana: SOLANA_PLACEHOLDER, evm: WALLET },
    ['eip155:8453'],
  )

  assert.deepEqual(warnings, [])
  assert.deepEqual(unsupported, [])
  assert.deepEqual(entries, [
    { network: 'eip155:8453', address: WALLET, asset: 'ETH', atomic: '0', human: '0', currency: 'ETH' },
    { network: 'eip155:8453', address: WALLET, asset: 'EURC', atomic: '5500000', human: '5.5', currency: 'EURC' },
    { network: 'eip155:8453', address: WALLET, asset: 'USDC', atomic: '0', human: '0', currency: 'USDC' },
  ])
  // Every read went to the default Base endpoint, and the EURC read targeted
  // the catalogue's deployment-0063 address.
  assert.ok(calls.every((c) => c.host === 'base.erpc.global'))
  assert.equal(BASE_EURC.address, '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42')
  assert.equal(BASE_EURC.decimals, 6)
  assert.ok(calls.some((c) => c.method === 'eth_call' && (c.params[0] as { to: string }).to === BASE_EURC.address))
})

test('default networks include Base, and Ethereum/Avalanche now report EURC and USDC too', async () => {
  const { evm } = deriveAddresses(ABANDON)
  installChain(evm)
  const result = await holdings({ WALLET_MNEMONIC: ABANDON, ERPC_API_KEY: 'test-key-0000000000' } as Env)
  const data = result.data as {
    entries: Array<{ network: string; asset: string }>
    unsupported: Array<{ network: string; asset: string; error: string }>
  }

  assert.equal(result.ok, true)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(
    data.entries.map((e) => `${e.network} ${e.asset}`),
    [
      'solana-mainnet SOL',
      'eip155:1 ETH', 'eip155:1 EURC', 'eip155:1 USDC',
      'eip155:8453 ETH', 'eip155:8453 EURC', 'eip155:8453 USDC',
      'eip155:43114 AVAX', 'eip155:43114 EURC', 'eip155:43114 USDC',
    ],
  )
  // Not an empty list: what is not read is said out loud.
  assert.deepEqual(
    data.unsupported.map((u) => `${u.network} ${u.asset} ${u.error}`),
    ['solana-mainnet EURC, USDC (SPL) not_read'],
  )
})

test('a failed read and an unknown network are reported, never silently dropped', async () => {
  installChain(WALLET, { failBaseUsdc: true })
  const { entries, unsupported, warnings } = await readHoldings(
    client(),
    { solana: SOLANA_PLACEHOLDER, evm: WALLET },
    ['eip155:8453', 'eip155:137'],
  )

  assert.deepEqual(entries.map((e) => e.asset), ['ETH', 'EURC'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^eip155:8453 USDC balance read failed: /)
  assert.deepEqual(unsupported.map((u) => [u.network, u.error]), [['eip155:137', 'unknown_network']])
})

test('an eth_call that returns no data is a warning, never a zero balance', async () => {
  installChain(WALLET, { emptyBaseUsdc: true })
  const { entries, unsupported, warnings } = await readHoldings(
    client(),
    { solana: SOLANA_PLACEHOLDER, evm: WALLET },
    ['eip155:8453'],
  )
  assert.deepEqual(entries.map((e) => `${e.asset}=${e.human}`), ['ETH=0', 'EURC=5.5'])
  assert.deepEqual(unsupported, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^eip155:8453 USDC balance read failed: eth_call returned no data/)
})

test("a Base endpoint that answers another chain id yields warnings, not another chain's balances", async () => {
  const calls = installChain(WALLET, { misrouteBase: true })
  const { entries, unsupported, warnings } = await readHoldings(
    client(),
    { solana: SOLANA_PLACEHOLDER, evm: WALLET },
    ['eip155:8453', 'eip155:1'],
  )
  // Ethereum is still read; nothing from the misrouted Base host is.
  assert.deepEqual(
    entries.map((e) => `${e.network} ${e.asset}`),
    ['eip155:1 ETH', 'eip155:1 EURC', 'eip155:1 USDC'],
  )
  assert.deepEqual(unsupported, [])
  assert.deepEqual(warnings, [
    'eip155:8453 ETH balance read failed: endpoint answered chainId 0x1 (expected 0x2105)',
    'eip155:8453 EURC balance read failed: endpoint answered chainId 0x1 (expected 0x2105)',
    'eip155:8453 USDC balance read failed: endpoint answered chainId 0x1 (expected 0x2105)',
  ])
  // No balance was even asked of the misrouted host.
  assert.deepEqual(
    calls.filter((c) => c.host === 'base.erpc.global').map((c) => c.method),
    ['eth_chainId'],
  )
})

test('wallet_status reachability includes Base with chain id 0x2105', async () => {
  installChain(WALLET)
  const reachability = await probeReachability(
    createGateway({ ERPC_API_KEY: 'test-key-0000000000' } as Env),
  )
  assert.deepEqual(
    reachability.find((r) => r.network === 'eip155:8453'),
    { network: 'eip155:8453', ok: true, detail: 'chainId 0x2105' },
  )
})

test('calldata and hex parsing', () => {
  assert.equal(
    balanceOfCalldata(WALLET),
    '0x70a082310000000000000000000000007a5837f5bb52c53e08fcff214c2cd11daa8ef9ee',
  )
  assert.throws(() => balanceOfCalldata('0x1234'))
  // A bare `0x` is not a quantity (zero is `0x0`) and never reads as zero.
  assert.throws(() => hexToAtomic('0x'))
  assert.equal(hexToAtomic('0x0'), '0')
  assert.equal(hexToAtomic('0x53ec60'), '5500000')
  assert.throws(() => hexToAtomic('not hex'))
  // balanceOf answers one 32-byte word; `0x` (no contract code) and a short
  // quantity are both refused rather than read as a balance.
  assert.equal(wordToAtomic('0x' + '0'.repeat(64)), '0')
  assert.equal(wordToAtomic('0x' + (5_500_000).toString(16).padStart(64, '0')), '5500000')
  assert.throws(() => wordToAtomic('0x'), /returned no data/)
  assert.throws(() => wordToAtomic('0x53ec60'))
})

// Live check against the real chain, through the real SDK and base.erpc.global.
// Opt-in: runs only with ERPC_LIVE_API_KEY set, so CI stays hermetic.
test('LIVE: base.erpc.global answers 0x2105 and the wallet holds EURC on Base', {
  skip: !process.env.ERPC_LIVE_API_KEY && 'set ERPC_LIVE_API_KEY to run',
}, async () => {
  const erpc = createErpcClient({ apiKey: process.env.ERPC_LIVE_API_KEY })
  assert.equal(await erpc.base.rpc.eth_chainId().send(), '0x2105')
  const { entries, warnings } = await readHoldings(
    erpc,
    { solana: SOLANA_PLACEHOLDER, evm: WALLET },
    ['eip155:8453'],
  )
  assert.deepEqual(warnings, [])
  const eurc = entries.find((e) => e.asset === 'EURC')
  const eth = entries.find((e) => e.asset === 'ETH')
  console.log('LIVE base holdings', JSON.stringify(entries))
  if (process.env.EXPECT_BASE_EURC) assert.equal(eurc?.human, process.env.EXPECT_BASE_EURC)
  if (process.env.EXPECT_BASE_ETH) assert.equal(eth?.human, process.env.EXPECT_BASE_ETH)
})
