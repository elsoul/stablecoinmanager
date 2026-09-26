/**
 * The SDK catalogue, mapped into the shape `lib/routes.ts` reasons about.
 *
 * The mapping is here and not in routes.ts so the decision logic stays free of
 * the SDK and can be driven directly by tests instead of re-implemented in
 * them -- the same split as reserve.ts and throttle.ts.
 *
 * `POOL_DEFINITIONS` nests the adapter (`adapter.kind`, `adapter.feeNumerator`,
 * `adapter.feeDenominator`) while routes.ts takes them flat, because the two
 * fee halves and the kind are one decision there: quotable adapter AND a fee
 * present. Flattening at the boundary keeps that decision readable.
 */
import {
  POOL_DEFINITIONS,
  TOKEN_DEPLOYMENTS,
} from '@elsoul/erpc-sdk'
import type { PoolRow, TokenRow } from '@/lib/routes'

export function catalogTokens(): TokenRow[] {
  return TOKEN_DEPLOYMENTS.map((t) => ({
    deploymentId: t.deploymentId,
    chainId: t.chainId,
    symbol: t.symbol,
    standard: t.standard,
    status: t.status,
  }))
}

export function catalogPools(): PoolRow[] {
  return POOL_DEFINITIONS.map((p) => ({
    poolDefinitionId: p.poolDefinitionId,
    chainId: p.chainId,
    token0DeploymentId: p.token0DeploymentId,
    token1DeploymentId: p.token1DeploymentId,
    adapterKind: p.adapter.kind,
    feeNumerator: p.adapter.feeNumerator,
    feeDenominator: p.adapter.feeDenominator,
    status: p.status,
  }))
}
