/**
 * The swap leg: quote -> simulate -> prepare -> allowance -> sign -> broadcast.
 *
 * Every step comes from `@elsoul/erpc-sdk`; there is no private DEX client and
 * no fallback path. What the published SDK cannot do, a tool refuses with the
 * wishlist item that would unblock it (see lib/routes.ts) rather than reaching
 * around it.
 *
 * 🔴 Two properties of the SDK's preparation shape the whole flow, both
 * measured rather than assumed (@elsoul/erpc-sdk 0.8.0, 2026-09-22):
 *
 *   1. `transaction.value` is the literal `'0'` and the path entries are
 *      `standard: 'erc20'`. The INPUT cannot be a native asset. The plan's
 *      stated canary, "0.001 ETH -> USDC", is not executable as written; it
 *      has to be WETH -> USDC, and there is no wrap step in the SDK.
 *   2. `allowance` is returned as a REQUIREMENT, not as something the SDK
 *      performs. Approving is ours to do, and it is a second signature.
 *
 * 🔴 NOTHING IN PRODUCTION IMPORTS THIS MODULE, on purpose.
 *
 * The `swap` tool answers with a route and refuses to broadcast, so none of
 * the code below runs today. Its tests pass, which is the problem worth
 * naming: a module with a green test file and no caller reads as covered, and
 * "covered" is what someone relies on when they wire it up.
 *
 * It is kept rather than deleted because the measurements above are the
 * expensive part and they are correct; deleting them means re-deriving them
 * against the same SDK. It is DECLARED rather than merely left here because
 * silence is what made it look alive: `chain/swap.test.ts` pins that the
 * importer count is zero, so the commit that finally wires this in reddens
 * and has to come back and delete this banner
 * (steiner, #14054 -- deferred from PR-3 to here).
 *
 * What unblocks it: a funded wallet, so the broadcast path can be exercised
 * in production before it ships rather than after.
 */
import type { HDAccount } from 'viem'
import type {
  ExactInputSwapPreparation,
  ExactInputSwapSimulation,
} from '@elsoul/erpc-sdk'

export interface SwapRequest {
  readonly chainId: string
  readonly poolDefinitionId: string
  readonly inputTokenDeploymentId: string
  readonly outputTokenDeploymentId: string
  readonly amountIn: string
  readonly sender: string
  readonly recipient: string
  readonly slippageBps: number
  readonly deadline: string
}

/** What the caller must be told before anything is signed. */
export interface SwapPlan {
  readonly simulation: ExactInputSwapSimulation
  readonly preparation: ExactInputSwapPreparation
  readonly needsApproval: boolean
  readonly approvalShortfall: string
}

/**
 * Minimal client surface, declared structurally.
 *
 * The tool passes the real `client.swap`; tests pass a double. Declaring the
 * shape here rather than importing the SDK's client type keeps this module
 * drivable without a network and without re-implementing its logic in a test
 * -- the same reason reserve.ts and throttle.ts are separate from the DO.
 */
export interface SwapCapableClient {
  simulateExactInputSwap(request: SwapRequest): Promise<ExactInputSwapSimulation>
}

/**
 * Decide whether an approval is needed, without signing anything.
 *
 * Simulation returns `currentAllowance` and the preparation states
 * `allowance.requiredAmount`. Comparing them as BigInt is deliberate: these
 * are atomic-unit decimal strings, and `'10' < '9'` is true as a string, which
 * would skip a needed approval on exactly the amounts most likely to occur.
 */
export function approvalGap(
  currentAllowance: string,
  requiredAmount: string,
): { needsApproval: boolean; shortfall: string } {
  // 🔴 `BigInt('')` and `BigInt(' ')` are both `0n`, and `BigInt('0x10')` is
  // 16 -- none of them throw. Relying on the try/catch alone would read an
  // EMPTY required amount as "nothing needs approving", which is the
  // fail-OPEN direction. Measured, and the same shape as `Number('')` being 0.
  // Only a plain decimal string counts.
  const atomic = /^\d+$/
  if (!atomic.test(currentAllowance.trim()) || !atomic.test(requiredAmount.trim())) {
    return { needsApproval: true, shortfall: requiredAmount }
  }

  let current: bigint
  let required: bigint
  try {
    current = BigInt(currentAllowance)
    required = BigInt(requiredAmount)
  } catch {
    // Unreadable allowance fails CLOSED: assume an approval is needed rather
    // than skipping it. A wrong "no approval needed" costs a reverted swap
    // and the gas that went with it.
    return { needsApproval: true, shortfall: requiredAmount }
  }
  if (current >= required) return { needsApproval: false, shortfall: '0' }
  return { needsApproval: true, shortfall: (required - current).toString() }
}

export async function planSwap(
  client: SwapCapableClient,
  request: SwapRequest,
): Promise<SwapPlan> {
  const simulation = await client.simulateExactInputSwap(request)
  const preparation = simulation.preparation
  const gap = approvalGap(simulation.currentAllowance, preparation.allowance.requiredAmount)
  return {
    simulation,
    preparation,
    needsApproval: gap.needsApproval,
    approvalShortfall: gap.shortfall,
  }
}

/** Never sign a preparation whose transaction moves native value. */
export function assertNoNativeValue(preparation: ExactInputSwapPreparation): void {
  if (preparation.transaction.value !== '0') {
    throw new Error(
      `the prepared swap moves native value (${preparation.transaction.value}); ` +
        'this worker signs ERC-20 exact-input swaps only',
    )
  }
}

export type { HDAccount }
