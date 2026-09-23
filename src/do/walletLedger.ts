/**
 * The single writer for anything that moves money.
 *
 * Every payment, swap and bridge goes through one Durable Object instance, so
 * nonce selection and idempotency are decided by serial execution rather than
 * by hope. KV is eventually consistent and therefore cannot be the source of
 * truth for "did we already pay this?" -- a stale read there is a double
 * payment.
 *
 * PR-1 ships the schema and the read paths. The money paths (x402_pay,
 * erpc_topup) land in PR-2 and write through this object.
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '@/types/env'
import { throttleIsLive } from '@/lib/throttle'
import { reserveDecision, type ReserveOutcome } from '@/lib/reserve'

export interface AuditRow {
  id: number
  at: number
  actor: string
  action: string
  detail: string
  /** `sql.exec<T>` requires rows to be indexable by column name. */
  [column: string]: string | number | ArrayBuffer | null
}

export class WalletLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.migrate()
    })
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql
    // Payments are keyed by the caller's idempotency key, so a retried tool
    // call returns the first receipt instead of signing a second time.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        idempotency_key TEXT PRIMARY KEY,
        status          TEXT NOT NULL,
        network         TEXT NOT NULL,
        asset           TEXT NOT NULL,
        amount_atomic   TEXT NOT NULL,
        amount_eurc     REAL NOT NULL,
        pay_to          TEXT NOT NULL,
        resource        TEXT,
        -- tx_hash, and NOT the obvious name: that word is a SQLite keyword,
        -- and CREATE TABLE rejects it outright. This migration would have
        -- thrown on the first Durable Object instantiation in production,
        -- taking the whole ledger with it. Caught before v1 shipped, when a
        -- rename is still free. walletLedger.test.ts runs this DDL against
        -- real SQLite so it cannot come back.
        tx_hash         TEXT,
        invoice_number  TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payments_created_at ON payments (created_at);

      CREATE TABLE IF NOT EXISTS policy_overrides (
        name       TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Deliberately NOT policy_overrides. That table is what PR-2's
      -- policy_set writes to, and the seed-export throttle must not be
      -- something a policy tool can extend, clear or even see. Separated
      -- before the first deploy, because after v1 has rows in production
      -- moving it costs a v2 migration.
      CREATE TABLE IF NOT EXISTS throttles (
        name       TEXT PRIMARY KEY,
        until      INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
    `)
  }

  /**
   * Check the daily ceiling and reserve the payment, in ONE method.
   *
   * 🔴 THIS METHOD MUST NOT CONTAIN AN `await`, for the same reason
   * claimExportThrottle must not: Durable Objects serialise METHOD CALLS, not
   * the span across an `await`. Reading today's total in one call and
   * inserting in another lets two payments interleave between them, and both
   * pass a ceiling that only one of them fits under. `sql.exec` is
   * synchronous, so nothing suspends here.
   *
   * The row is written as `pending` BEFORE anything is signed. A signature
   * that exists with no row is a payment the ledger does not know it made;
   * a row with no signature is a reservation we can reconcile or expire.
   * Of the two, only the first loses money.
   */
  async reservePayment(input: {
    idempotencyKey: string
    network: string
    asset: string
    amountAtomic: string
    amountEurc: number
    payTo: string
    resource?: string
    dailyCeilingEurc: number
    now?: number
  }): Promise<ReserveOutcome> {
    const now = input.now ?? Date.now()
    const sql = this.ctx.storage.sql

    const existing = sql
      .exec(
        `SELECT * FROM payments WHERE idempotency_key = ?`,
        input.idempotencyKey,
      )
      .toArray()

    const startOfDay = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    )
    // `stuck` counts. It is written when the payment was signed and submitted
    // but the grant did not complete, so the money has most likely MOVED --
    // excluding it would let repeated stuck payments spend past the ceiling
    // without limit, which is the ceiling failing open in the one case where
    // something has already gone wrong. `failed` is excluded because it is
    // only written on paths where nothing was signed, or where the resource
    // answered without a transaction hash.
    const spentRows = sql
      .exec<{ total: number | null }>(
        `SELECT SUM(amount_eurc) AS total FROM payments
          WHERE created_at >= ? AND status IN ('settled', 'pending', 'stuck')`,
        startOfDay,
      )
      .toArray()

    const decision = reserveDecision({
      existing: existing[0],
      spentTodayEurc: spentRows[0]?.total ?? 0,
      amountEurc: input.amountEurc,
      dailyCeilingEurc: input.dailyCeilingEurc,
    })
    if (decision.kind !== 'reserve') return decision

    sql.exec(
      `INSERT INTO payments (
         idempotency_key, status, network, asset, amount_atomic, amount_eurc,
         pay_to, resource, created_at, updated_at
       ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.idempotencyKey,
      input.network,
      input.asset,
      input.amountAtomic,
      input.amountEurc,
      input.payTo,
      input.resource ?? null,
      now,
      now,
    )
    return decision
  }

  /**
   * Record the outcome of a reserved payment.
   *
   * 🔴 `settled` is TERMINAL and is never overwritten. erpc_topup polls after
   * paying and settles again with whatever the poll returned, and the failure
   * path tells the caller to poll again -- so a late or repeated poll can
   * arrive after a grant has already landed. Letting it write `pending` over
   * `settled` would turn a completed purchase back into an open one in the
   * receipt the operator reads, while the money is long gone.
   *
   * No money is lost either way, which is exactly why it is worth guarding:
   * the damage is to the record, and a wrong record is what someone acts on
   * (steiner N-1 / gilgamesh N4, #14018).
   */
  async settlePayment(input: {
    idempotencyKey: string
    // `pending` is a legitimate terminal-for-now state: the resource accepted
    // the payment (202) but has not granted yet, and erpc_topup polls for it.
    status: 'settled' | 'pending' | 'failed' | 'stuck'
    txHash?: string
    invoiceNumber?: string
    now?: number
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE payments
          SET status = ?, tx_hash = COALESCE(?, tx_hash),
              invoice_number = COALESCE(?, invoice_number), updated_at = ?
        WHERE idempotency_key = ? AND status != 'settled'`,
      input.status,
      input.txHash ?? null,
      input.invoiceNumber ?? null,
      input.now ?? Date.now(),
      input.idempotencyKey,
    )
  }

  /** EURC-equivalent settled today (UTC), for the daily policy ceiling. */
  async spentTodayEurc(now = Date.now()): Promise<number> {
    const startOfDay = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    )
    const rows = this.ctx.storage.sql
      .exec<{ total: number | null }>(
        `SELECT SUM(amount_eurc) AS total FROM payments
          WHERE created_at >= ? AND status IN ('settled', 'pending', 'stuck')`,
        startOfDay,
      )
      .toArray()
    return rows[0]?.total ?? 0
  }

  async history(limit = 50): Promise<unknown[]> {
    const capped = Math.min(Math.max(limit, 1), 200)
    return this.ctx.storage.sql
      .exec(
        `SELECT * FROM payments ORDER BY created_at DESC LIMIT ?`,
        capped,
      )
      .toArray()
  }

  async receipt(idempotencyKey: string): Promise<unknown | null> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM payments WHERE idempotency_key = ?`, idempotencyKey)
      .toArray()
    return rows[0] ?? null
  }

  /**
   * Policy overrides only. Throttles live in their own table, so a future
   * `policy_get` cannot surface the seed-export rate limit and a future
   * `policy_set` cannot reach it.
   */
  async policyOverrides(): Promise<Record<string, string>> {
    const rows = this.ctx.storage.sql
      .exec<{ name: string; value: string }>(`SELECT name, value FROM policy_overrides`)
      .toArray()
    return Object.fromEntries(rows.map((row) => [row.name, row.value]))
  }

  /**
   * Atomically claim the seed-export throttle.
   *
   * Returns false when a claim is already live.
   *
   * 🔴 THIS METHOD MUST NOT CONTAIN AN `await`. What makes the read and the
   * write atomic is not that Durable Objects serialise method calls -- they
   * interleave at `await` boundaries -- it is that `ctx.storage.sql.exec` is
   * synchronous and nothing suspends between the SELECT and the INSERT.
   * Introducing an `await` here silently restores the read-then-write window
   * that two concurrent exports would both pass, which is exactly the burst a
   * stolen session produces.
   *
   * Reads fail CLOSED: a row that will not parse as a number is treated as a
   * live claim, not as an absent one.
   */
  async claimExportThrottle(windowSeconds: number, now = Date.now()): Promise<boolean> {
    const rows = this.ctx.storage.sql
      .exec<{ until: number }>(
        `SELECT until FROM throttles WHERE name = 'export_seed'`,
      )
      .toArray()

    // throttleIsLive is a module-level pure function so the shipping decision
    // is directly testable; see below.
    if (rows.length > 0 && throttleIsLive(rows[0]?.until, now)) return false

    this.ctx.storage.sql.exec(
      `INSERT INTO throttles (name, until, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET until = excluded.until, updated_at = excluded.updated_at`,
      'export_seed',
      now + windowSeconds * 1000,
      now,
    )
    return true
  }

  /**
   * Write a policy override and its audit row, in ONE method.
   *
   * 🔴 Must contain no `await`, for the same reason reservePayment must not:
   * the override and the audit row have to land together. A crash between two
   * separate calls leaves a tightened ceiling with no record of who tightened
   * it, or -- worse on a later widening path -- a record with no change.
   *
   * The caller has already decided this is a narrowing (see
   * lib/policyOverride.ts). This method does not re-derive that decision; it
   * records the one that was made, with the values on both sides so the audit
   * row is readable without replaying the code.
   */
  async setPolicyOverride(input: {
    name: string
    value: string
    from: number
    actor: string
    now?: number
  }): Promise<void> {
    const now = input.now ?? Date.now()
    const sql = this.ctx.storage.sql

    sql.exec(
      `INSERT INTO policy_overrides (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      input.name,
      input.value,
      now,
    )
    sql.exec(
      `INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)`,
      now,
      input.actor,
      'policy_set',
      `${input.name}: ${input.from} -> ${input.value}`,
    )
  }

  async appendAudit(actor: string, action: string, detail: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)`,
      Date.now(),
      actor,
      action,
      detail,
    )
  }

  async recentAudit(limit = 50): Promise<AuditRow[]> {
    const capped = Math.min(Math.max(limit, 1), 200)
    return this.ctx.storage.sql
      .exec<AuditRow>(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`, capped)
      .toArray()
  }
}

/** One deployment, one owner, one wallet -- therefore one ledger instance. */
export const LEDGER_INSTANCE_NAME = 'wallet'

