/**
 * The x402 payment leg.
 *
 * This is the part that must match the proven client byte-for-byte in
 * behaviour: `api/erpc/x402-rpc-api/.e2e-local/run-e2e-topup.mjs`. Same
 * packages, same pinned versions (@x402/core and @x402/evm 2.13.0), same
 * call order.
 *
 * Why that file and not some other reference. Predicate: `git grep -l "@x402/"`
 * over the tracked tree, then read each hit for which SIDE it is on.
 *
 *   run-e2e-topup.mjs   pays the top-up endpoint      <- the reference
 *   run-e2e-evm.mjs     pays the RPC endpoint instead
 *   x402-rpc-api/src/*  the server that charges (`@x402/core/server`,
 *                       `@x402/evm/exact/server`, `paymentMiddleware`)
 *   x402-rpc-api/test/* `@x402/core/types` only; they drive app.fetch, they
 *                       do not sign
 *
 * `src/middleware/x402.ts` is the near-miss worth naming: it RE-EXPORTS
 * `encodePaymentSignatureHeader`, so a grep for signing symbols hits it even
 * though every one of its own imports is from a `/server` path. Reading the
 * hits rather than counting them is what separates it from a real signer.
 *
 * This is a statement about this repository, not about the world: someone with
 * their own wallet can pay the same endpoint without anything here knowing.
 *
 * The payer needs no ETH: EIP-3009 `transferWithAuthorization` is gasless for
 * the payer and the facilitator submits the transaction. That is why Base
 * balances being unreadable through the SDK (wishlist W1) does not block this.
 */
import {
  type SelectPaymentRequirements,
  x402Client,
  x402HTTPClient,
} from '@x402/core/client'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import type { HDAccount } from 'viem'

export interface ProbeResult {
  status: number
  body: unknown
  headers: Headers
}

/** POST a JSON body and return the raw pieces a 402 decision needs. */
export async function probe(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<ProbeResult> {
  const response = await fetch(url, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text.slice(0, 2000)
  }
  return { status: response.status, body, headers: response.headers }
}

export interface SignedPayment {
  header: string
  from?: string
  to?: string
  value?: string
}

/**
 * Sign the 402 and produce the `X-Payment` header.
 *
 * Takes the ORIGINAL response headers and body, because the x402 client reads
 * the challenge from both; reconstructing it from normalized fields would be a
 * second source of truth for the thing being signed.
 */
/** The fields that must be identical between what we chose and what we sign. */
export interface SignTarget {
  readonly scheme: string
  readonly network: string
  readonly asset: string
  readonly amountAtomic: string
  readonly payTo: string
}

class PaymentTargetMismatch extends Error {}

const sameRequirement = (a: SignTarget, b: Record<string, unknown>): boolean =>
  String(b.scheme ?? 'exact') === a.scheme &&
  String(b.network ?? '') === a.network &&
  String(b.asset ?? '').toLowerCase() === a.asset.toLowerCase() &&
  String(b.amount ?? '') === a.amountAtomic &&
  String(b.payTo ?? '').toLowerCase() === a.payTo.toLowerCase()

/**
 * Barrier 2, as its own function so it can be measured on its own.
 *
 * 🔴 It is extracted for a reason. The end-to-end test signs a divergent
 * challenge and passes -- but it passes because BARRIER 1 works, so deleting
 * barrier 2 entirely would leave that suite green. A defence whose only
 * evidence is another defence working is not independently verified
 *, and barrier 2 exists precisely because barrier 1
 * depends on SDK behaviour this worker does not own.
 *
 * Checks all five fields, not the two the EIP-3009 authorization carries:
 * "10000 EURC to X" and "10000 USDC to X" share a payee and an amount.
 */
export function assertSignedMatchesTarget(payload: unknown, target: SignTarget): void {
  const accepted = (payload as { accepted?: Record<string, unknown> })?.accepted
  if (!accepted || !sameRequirement(target, accepted)) {
    throw new PaymentTargetMismatch(
      'the signer accepted a different requirement than the authorised one: ' +
        `signed ${JSON.stringify(accepted ?? null)}, authorised ` +
        `${target.amountAtomic} of ${target.asset} to ${target.payTo} on ${target.network}`,
    )
  }

  const authorization = (payload as { payload?: { authorization?: Record<string, string> } })
    ?.payload?.authorization
  const to = authorization?.to
  const value = authorization?.value
  if (!to || to.toLowerCase() !== target.payTo.toLowerCase()) {
    throw new PaymentTargetMismatch(
      `signed payee ${to ?? '(none)'} does not match the authorised payee ${target.payTo}`,
    )
  }
  if (!value || value !== target.amountAtomic) {
    throw new PaymentTargetMismatch(
      `signed amount ${value ?? '(none)'} does not match the authorised amount ${target.amountAtomic}`,
    )
  }
}

/**
 * Sign the requirement THIS WORKER CHOSE -- not whichever one the resource
 * put first.
 *
 * 🔴 `new x402Client()` with no argument installs the SDK's default selector,
 * which is `(version, accepts) => accepts[0]`. Every check this worker makes
 * -- per-payment ceiling, daily ceiling, treasury fence, EURC-only for
 * top-ups, the ledger row -- is computed from the requirement `selectRequirement`
 * picked. With the default selector, none of those checks constrain the thing
 * that actually gets signed: a resource can list a large payment to an
 * attacker first and the reviewed one second, pass every policy check on the
 * second, and be signed for the first. Reproduced: policy violations 0,
 * ledger row EURC, signature 49 USDC to an unrelated address.
 *
 * The reference client never had this hole because it refused any challenge
 * with more than one requirement (`if (accepts.length !== 1) die(...)`). This
 * worker accepts several on purpose, so the binding has to be explicit.
 *
 * Two independent barriers, because the first depends on SDK behaviour we do
 * not own:
 *   1. the selector returns OUR requirement, and throws if it is not among the
 *      ones the SDK is willing to pay;
 *   2. the signed authorization is compared back against it afterwards.
 */
export async function signPayment(
  account: HDAccount,
  challenge: { headers: Headers; body: unknown },
  target: SignTarget,
): Promise<SignedPayment> {
  const selector: SelectPaymentRequirements = (_version, accepts) => {
    const list = (accepts ?? []) as unknown as Record<string, unknown>[]
    const match = list.find((candidate) => sameRequirement(target, candidate))
    if (!match) {
      // Fail closed. Returning `list[0]` here would be the defect itself.
      throw new PaymentTargetMismatch(
        `the chosen requirement (${target.amountAtomic} of ${target.asset} to ` +
          `${target.payTo} on ${target.network}) is not among the ${list.length} ` +
          'requirement(s) the signer would accept; nothing was signed',
      )
    }
    return match as unknown as ReturnType<SelectPaymentRequirements>
  }

  const client = new x402Client(selector)
  registerExactEvmScheme(client, { signer: account })
  const httpClient = new x402HTTPClient(client)

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name: string) => challenge.headers.get(name),
    challenge.body,
  )
  const payload = await client.createPaymentPayload(paymentRequired)
  const authorization = (payload as { payload?: { authorization?: Record<string, string> } })
    .payload?.authorization

  // Barrier 2: what the signer actually accepted, compared to what was
  // authorised -- all five fields, not just the two the EIP-3009
  // authorization happens to carry.
  //
  // 🔴 An earlier revision compared only `to` and `value` while claiming "two
  // independent barriers". That claim was false for `scheme`, `network` and
  // above all `asset`: "10000 EURC to X" and "10000 USDC to X" have identical
  // payee and amount, so barrier 2 could not tell them apart and the token
  // contract was guarded by barrier 1 alone -- the barrier this very docstring
  // says we do not own.
  //
  // `payload.accepted` is the requirement the SDK recorded as the one it paid,
  // and it carries all five. Measured on @x402/core 2.13.0: the payload's
  // top-level keys are x402Version / payload / extensions / resource /
  // accepted.
  assertSignedMatchesTarget(payload, target)

  const to = authorization?.to
  const value = authorization?.value

  return {
    header: encodePaymentSignatureHeader(payload),
    from: authorization?.from,
    to,
    value,
  }
}

/** Read the settle response the resource server returns after a payment. */
export function readSettle(
  headers: Headers,
): { transaction?: string; network?: string; payer?: string } | undefined {
  try {
    const client = new x402HTTPClient(new x402Client())
    const settle = client.getPaymentSettleResponse((name: string) => headers.get(name))
    return settle as { transaction?: string; network?: string; payer?: string }
  } catch {
    return undefined
  }
}
