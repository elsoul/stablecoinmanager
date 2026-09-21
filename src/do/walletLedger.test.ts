import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { throttleIsLive } from '../lib/throttle.ts'

// ---------------------------------------------------------------------------
// The Durable Object's migration had never been executed anywhere: no PR-1
// route instantiates the DO, `wrangler dev` does not run it on boot, and the
// type checker does not read SQL. The first execution would have been the
// first production request -- where a syntax error takes the whole ledger with
// it, because `[[migrations]] tag = "v1"` runs once and the object has no
// schema without it.
//
// It was in fact broken: a column was named `transaction`, a SQLite keyword,
// and the CREATE TABLE was rejected outright.
//
// So the real DDL is extracted from the real source and run against real
// SQLite here. This does not prove workerd accepts it, but it does prove the
// SQL parses and the tables behave -- which is the failure that was actually
// present.
// ---------------------------------------------------------------------------

function migrationDDL(): string {
  const source = readFileSync(
    join(import.meta.dirname, 'walletLedger.ts'),
    'utf8',
  )
  const match = source.match(/sql\.exec\(`([\s\S]*?)`\)/)
  assert.ok(match, 'could not find the migration DDL in walletLedger.ts')
  return match[1]
}

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(migrationDDL())
  return db
}

test('the v1 migration is valid SQL', () => {
  migrated()
})

test('it creates exactly the tables the worker reads', () => {
  const names = migrated()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((row) => String(row.name))
    // sqlite_sequence is created by SQLite itself for the AUTOINCREMENT on
    // audit.id; it is not ours to declare.
    .filter((name) => !name.startsWith('sqlite_'))
  // 🔴 Load-bearing beyond its own subject. What proves the extraction grabbed
  // the migration, and not some other sql.exec template in the file, is this
  // exact-set assertion TOGETHER WITH the column-level tests below -- measured:
  // a decoy that keeps the table names passes this one and is caught by those,
  // and loosening this one to a subset match reddens four others. Neither half
  // alone is the check. Keep both exact.
  assert.deepEqual(names, ['audit', 'payments', 'policy_overrides', 'throttles'])
})

test('the throttle table is separate from policy overrides', () => {
  // A policy tool must not be able to see, extend or clear the seed-export
  // throttle, so they are not the same table.
  const db = migrated()
  db.exec(`INSERT INTO throttles (name, until, updated_at) VALUES ('export_seed', 1, 1)`)
  const overrides = db.prepare(`SELECT COUNT(*) AS n FROM policy_overrides`).get()
  assert.ok(overrides)
  assert.equal(overrides.n, 0)
})

test('a payment row round-trips, reserved words included', () => {
  const db = migrated()
  db.exec(`
    INSERT INTO payments (
      idempotency_key, status, network, asset, amount_atomic, amount_eurc,
      pay_to, tx_hash, invoice_number, created_at, updated_at
    ) VALUES (
      'key-1', 'settled', 'eip155:8453', 'EURC', '1210000', 1.21,
      '0x490842c32b83653dfd06eeeb53b9dbbf5d87f597', '0xabc', 'INV-1', 1, 1
    )
  `)
  const row = db.prepare(`SELECT tx_hash, amount_atomic FROM payments`).get()
  assert.ok(row)
  assert.equal(row.tx_hash, '0xabc')
  assert.equal(row.amount_atomic, '1210000')
})

test('no column is named with a SQLite keyword', () => {
  // The general form of the defect, not just the one instance of it.
  const RESERVED = new Set([
    'transaction', 'order', 'group', 'index', 'table', 'select', 'where',
    'from', 'values', 'default', 'check', 'references', 'primary', 'unique',
    'constraint', 'using', 'when', 'then', 'set', 'to', 'by', 'add', 'all',
  ])
  const db = migrated()
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((row) => String(row.name))

  for (const table of tables) {
    for (const column of db.prepare(`PRAGMA table_info(${table})`).all()) {
      assert.ok(
        !RESERVED.has(String(column.name).toLowerCase()),
        `${table}.${String(column.name)} is a SQLite keyword`,
      )
    }
  }
})

test('idempotency_key is the primary key, so a retry cannot double-insert', () => {
  const db = migrated()
  const insert = () =>
    db.exec(`
      INSERT INTO payments (
        idempotency_key, status, network, asset, amount_atomic, amount_eurc,
        pay_to, created_at, updated_at
      ) VALUES ('same-key', 'pending', 'eip155:8453', 'EURC', '1', 1.0, '0x0', 1, 1)
    `)
  insert()
  assert.throws(insert, /UNIQUE|PRIMARY/i)
})

test('a throttle row this writer would not have produced is read as LIVE', () => {
  // Drives throttleIsLive -- the SHIPPING decision, exported for exactly this
  // reason. A guard re-implemented in the test only proves the copy works.
  const now = 1_000_000

  // Fails closed: Number('') and Number(null) are both 0, so a bare
  // Number.isFinite check would read these as "no claim" and let the phrase
  // out. The writer only ever stores a large positive integer.
  for (const rubbish of ['', 0, null, undefined, Number.NaN, -1, '12345', {}]) {
    assert.equal(throttleIsLive(rubbish, now), true, JSON.stringify(rubbish) ?? 'undefined')
  }

  assert.equal(throttleIsLive(now - 1, now), false, 'an expired claim is claimable again')
  assert.equal(throttleIsLive(now + 1, now), true, 'a live claim blocks')
})

test('a throttle row round-trips through SQLite as the number the guard expects', () => {
  // The other half: what the column actually gives back.
  const db = migrated()
  db.prepare(
    `INSERT INTO throttles (name, until, updated_at) VALUES ('export_seed', ?, 1)`,
  ).run(1_700_000_000_000)
  const row = db.prepare(`SELECT until FROM throttles`).get()
  assert.ok(row)
  assert.equal(typeof row.until, 'number')
  assert.equal(throttleIsLive(row.until, 1), true)

  // NULL cannot even be stored: `until INTEGER NOT NULL` refuses it, which is
  // a stronger guarantee than any read-side check.
  assert.throws(
    () =>
      db
        .prepare(`INSERT INTO throttles (name, until, updated_at) VALUES ('x', ?, 1)`)
        .run(null as never),
    /constraint/i,
  )
})

// ---------------------------------------------------------------------------
// Two invariants that hold today and would break SILENTLY. The file is already
// read from disk above (for the DDL), so checking the source costs nothing --
// and "a rule in a doc comment" has already been shown, twice in this package,
// to be a rule that stops being followed.
// ---------------------------------------------------------------------------

function methodBody(name: string): string {
  const source = readFileSync(join(import.meta.dirname, 'walletLedger.ts'), 'utf8')
  const start = source.indexOf(`async ${name}(`)
  assert.notEqual(start, -1, `${name} not found in walletLedger.ts`)

  // Walk braces from the method's opening brace to its matching close.
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `${name} has no body`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`${name} body is unbalanced`)
}

test('SOURCE: claimExportThrottle contains no await', () => {
  // Its own docblock says an await here "silently restores the read-then-write
  // window". Silently is the problem: adding one leaves every test green,
  // because what makes the claim atomic is that nothing suspends between the
  // SELECT and the INSERT -- not that Durable Objects serialise method calls.
  const body = methodBody('claimExportThrottle')
  assert.ok(!/\bawait\b/.test(body), 'claimExportThrottle must not suspend')

  // Positive control on the extractor itself: a method that does await.
  assert.ok(/\bawait\b/.test(methodBody('appendAudit')) === false)
  assert.ok(methodBody('claimExportThrottle').includes('INSERT INTO throttles'))
})

test('SOURCE: claimExportThrottle uses the shared throttle guard', () => {
  // The test above drives throttleIsLive directly. That proves the function is
  // right, not that the Durable Object still calls it -- an inline
  // re-implementation would leave both green.
  assert.ok(methodBody('claimExportThrottle').includes('throttleIsLive('))
})
