/**
 * The one sanctioned way secret material leaves this worker.
 *
 * It exists because the alternative is worse: a wallet whose only copy lives
 * in a Durable Object is a wallet that a deleted namespace destroys. So the
 * phrase is exportable -- deliberately, loudly, and with a trail.
 *
 * This result bypasses the redactor by construction (it is the one response
 * whose whole purpose is the secret), so it never travels through `redact`
 * and is never logged.
 */
import type { Env } from '@/types/env'
import { deriveAddresses } from '@/wallet/keys'
import { LEDGER_INSTANCE_NAME, type WalletLedger } from '@/do/walletLedger'
import { fail, ok, type ToolResult } from '../result'

const COOLDOWN_SECONDS = 300

export async function walletExportSeed(
  env: Env,
  args: { confirm?: string },
  actor: string,
): Promise<ToolResult> {
  if (args.confirm !== 'EXPORT') {
    return fail(
      { exported: false },
      ['Call again with confirm:"EXPORT" if you really mean to reveal the recovery phrase.'],
      ['This returns the phrase that controls every asset in this wallet.'],
    )
  }

  const mnemonic = env.WALLET_MNEMONIC?.trim() ?? ''
  if (!mnemonic) {
    return fail({ exported: false, state: 'not_initialized' }, [
      'Run `pnpm wallet:init` first.',
    ])
  }

  const ledger = env.WALLET_LEDGER.get(
    env.WALLET_LEDGER.idFromName(LEDGER_INSTANCE_NAME),
  ) as unknown as WalletLedger

  // Claimed in the Durable Object, not KV: KV is read-then-write, so two
  // concurrent calls would both see "no cooldown" and both reveal the phrase.
  // The claim is atomic because the DO method holds no `await` between its
  // read and its write -- see claimExportThrottle.
  if (!(await ledger.claimExportThrottle(COOLDOWN_SECONDS))) {
    await ledger.appendAudit(actor, 'wallet_export_seed', 'refused: cooling down')
    return fail(
      { exported: false, state: 'cooling_down' },
      [`Wait up to ${COOLDOWN_SECONDS}s between exports.`],
      ['A rapid series of export calls is what a stolen session looks like.'],
    )
  }

  await ledger.appendAudit(actor, 'wallet_export_seed', 'recovery phrase revealed')

  return ok(
    { exported: true, mnemonic, addresses: deriveAddresses(mnemonic) },
    [
      'Store this offline. Anyone holding it controls the wallet on every chain.',
      'If it may have been seen, move the funds to a new wallet and re-run wallet:init.',
    ],
    ['An audit row was written for this export.'],
  )
}
