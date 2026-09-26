import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BASE_MAINNET_CAIP2_NETWORK } from '@constants/base'
import { bridgeCapabilities, bridgeRoute } from './bridge.ts'

const ETH = 'eip155:1'
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
// Imported, not retyped -- the same guard that caught this file on its
// first run (lib/x402.test.ts: no money-critical literal is retyped).
const BASE = BASE_MAINNET_CAIP2_NETWORK

test('the capability list parses from the shipped SDK', () => {
  const caps = bridgeCapabilities()
  assert.ok(caps.length > 0, 'the SDK ships bridge capabilities')
  for (const c of caps) {
    assert.ok(c.bridgeCapabilityId && c.sourceChainId && c.destinationChainId, JSON.stringify(c))
    assert.equal(c.status, 'active')
  }
})

test('both EURC directions between Ethereum and Solana are routable', () => {
  // Asked as two separate questions, because the SDK lists them as two
  // separate capabilities and symmetry is not guaranteed by anything.
  const out = bridgeRoute(ETH, SOL)
  assert.equal(out.supported, true)
  const back = bridgeRoute(SOL, ETH)
  assert.equal(back.supported, true)
})

test('🔴 Base in either direction names W3, not a generic miss', () => {
  for (const [from, to] of [[BASE, SOL], [SOL, BASE], [BASE, ETH], [ETH, BASE]]) {
    const out = bridgeRoute(from, to)
    assert.equal(out.supported, false)
    assert.equal((out as { needs?: string }).needs, 'W3', `${from} -> ${to}`)
  }
})

test('an unlisted non-Base pair is refused as "not this pair", not as a wishlist gap', () => {
  const out = bridgeRoute('eip155:43114', SOL)
  assert.equal(out.supported, false)
  assert.equal((out as { needs: null }).needs, null)
  assert.match((out as { why: string }).why, /not a wishlist gap/)
})

test('control: the refusals are not produced by an empty capability list', () => {
  // If parsing silently yielded [], every answer above would be a refusal and
  // the tests would pass for the wrong reason.
  const caps = bridgeCapabilities()
  assert.ok(
    caps.some((c) => c.sourceChainId === ETH && c.destinationChainId === SOL),
    'the Ethereum -> Solana capability is really in the parsed list',
  )
})
