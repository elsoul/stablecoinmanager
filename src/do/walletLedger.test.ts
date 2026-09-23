import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { OVERRIDE_ROWS_SQL, policyFromLedger, reserveDecision } from '@/lib/reserve'
import { ERPC_TREASURY_BASE, loadPolicy } from '@/lib/policy'
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

function methodBody(name: string, file = 'do/walletLedger.ts'): string {
  const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
  // Methods are `async name(`; module-level handlers are `function name(`.
  // Both are matched so one extractor covers both, rather than a second copy
  // of this logic drifting away from the parameter-list fix below.
  // `private ` is here because the ceiling reader is a synchronous private
  // method: an extractor that only knows `async ` reports "not found", which
  // is indistinguishable from "the method was deleted" -- the failure mode
  // this helper's own comment below is about.
  const start = ['async ', 'function ', 'private '].reduce((found, prefix) => {
    if (found !== -1) return found
    return source.indexOf(`${prefix}${name}(`)
  }, -1)
  assert.notEqual(start, -1, `${name} not found in ${file}`)

  // Skip the parameter list FIRST. A method whose parameter is an object type
  // has a `{` before its body, and walking from that one silently returns the
  // parameter type instead of the code -- which is how a source-scanning test
  // quietly stops looking at the thing it names.
  const paramOpen = source.indexOf('(', start)
  assert.notEqual(paramOpen, -1, `${name} has no parameter list`)
  let parenDepth = 0
  let afterParams = -1
  for (let i = paramOpen; i < source.length; i++) {
    if (source[i] === '(') parenDepth++
    else if (source[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        afterParams = i
        break
      }
    }
  }
  assert.notEqual(afterParams, -1, `${name} parameter list is unbalanced`)

  const open = source.indexOf('{', afterParams)
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

  // What proves the extractor returned real content rather than an empty
  // string -- which would make the assertion above pass vacuously -- is the
  // anchored INSERT below. Anchored on purpose: `INSERT INTO throttles` is a
  // prefix of `INSERT INTO throttles_anything`, so a bare includes() survives
  // a table rename. What proves the await matcher itself works is mutation:
  // adding one await to this method reddens exactly this test, which is how
  // it was verified.
  //
  // An earlier revision asserted the same thing about appendAudit here. That
  // was removed: a failure in appendAudit would have reddened a test named
  // after claimExportThrottle, pointing the next reader at the wrong method
  // (steiner, #13980 N-2).
  assert.ok(/INSERT INTO throttles\s*\(/.test(body))
})

test('SOURCE: claimExportThrottle uses the shared throttle guard', () => {
  // The test above drives throttleIsLive directly. That proves the function is
  // right, not that the Durable Object still calls it -- an inline
  // re-implementation would leave both green.
  assert.ok(methodBody('claimExportThrottle').includes('throttleIsLive('))
})

test('SOURCE: reservePayment contains no await', () => {
  // steiner's PR-2 acceptance condition, and the same mechanism as
  // claimExportThrottle: Durable Objects serialise METHOD CALLS, not the span
  // across an `await`. Reading today's total in one call and inserting in
  // another lets two payments interleave and both pass a ceiling only one of
  // them fits under. What makes this atomic is that nothing suspends between
  // the SELECT and the INSERT -- and that is invisible at a glance, so it is
  // checked here.
  const body = methodBody('reservePayment')
  assert.ok(!/\bawait\b/.test(body), 'reservePayment must not suspend')
  // Anchored: `INSERT INTO payments` is a prefix of `INSERT INTO payments_x`,
  // so a bare includes() passes when the table is renamed -- measured, the
  // control did not fire until this was anchored.
  assert.match(body, /INSERT INTO payments\s*\(/, 'and it must be the method that inserts')
  assert.ok(body.includes('reserveDecision('), 'using the shared decision')
})

test('SOURCE: the effective policy is decided inside the reservation, not handed in', () => {
  // 🔴 steiner N-11. The overrides feature opened a read-then-act window that
  // did not exist before it: `x402Pay` read the effective ceiling at the top
  // of the request and passed it down, with a DO round trip and a network
  // probe of the resource in between. A `policy_set` landing in that window
  // was stored and acknowledged and then not applied to the payment already in
  // flight -- the exact payment an operator tightening a ceiling mid-incident
  // is trying to stop.
  //
  // Two properties are checked, because either one alone is satisfiable by the
  // broken version: the ceiling is read here, AND reading it does not suspend.
  const body = methodBody('effectivePolicy')
  assert.ok(!/\bawait\b/.test(body), 'effectivePolicy must not suspend')
  assert.ok(
    body.includes('policyFromLedger('),
    'and compose them with the shared function that runs the query itself',
  )
  assert.match(
    body,
    /sql\.exec<\{ name: string; value: string \}>\(query\)/,
    'handing it the real executor, not a lambda that returns nothing',
  )
  assert.ok(body.includes('loadPolicy('), 'which needs the deploy-time ceiling')
  assert.ok(body.includes('refuseEverything('), 'and it must fail closed')

  // And the caller must no longer be able to hand one in. A parameter that
  // still exists is a parameter someone passes a stale value to.
  const reserve = methodBody('reservePayment')
  assert.ok(
    !/dailyCeilingEurc:\s*input\./.test(reserve),
    'reservePayment must not take a ceiling from its caller',
  )
  assert.ok(
    reserve.includes('this.effectivePolicy(sql)'),
    'it must compose the policy inside its own turn',
  )
  // 🔴 steiner B-2: the reservation must not be able to compute a refusal
  // and ignore it. It cannot, because it does not compute one -- the whole
  // decision arrives from `reserveDecision`, which node drives directly.
  assert.ok(
    reserve.includes('reserveDecision('),
    'the decision must come from the shared pure function',
  )
  assert.ok(
    !/checkPayment\s*\(/.test(reserve),
    'and the reservation must not re-derive the policy check itself',
  )
})

test('SOURCE: the pending row is written by the same method that checks', () => {
  // A reservation written by a different method than the one that read the
  // total is the interleaving bug wearing a different shape.
  const source = readFileSync(join(import.meta.dirname, 'walletLedger.ts'), 'utf8')
  const inserts = source.match(/INSERT INTO payments\s*\(/g) ?? []
  assert.equal(inserts.length, 1, 'exactly one place inserts a payment row')
  assert.match(methodBody('reservePayment'), /INSERT INTO payments\s*\(/)
})

// ---------------------------------------------------------------------------
// The anchored `INSERT INTO payments (` above catches one table's name drifting
// in one method. It does not catch a COLUMN that the DDL never declared, and it
// does not look at the other eleven statements at all -- and every one of those
// has the same property that made the `transaction` keyword survive to PR-1:
// the type checker does not read SQL, so the first execution of any of them is
// the first production request that reaches that method.
//
// So every statement in the Durable Object is prepared against the schema the
// migration actually creates. SQLite resolves table and column names at prepare
// time, which is what makes this a real check rather than a string comparison.
// ---------------------------------------------------------------------------

function statements(): string[] {
  const source = readFileSync(
    join(import.meta.dirname, 'walletLedger.ts'),
    'utf8',
  )
  const found = source.match(/`\s*(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?`/g) ?? []
  return found.map((raw) => raw.slice(1, -1))
}

test('every query in the Durable Object prepares against the real schema', () => {
  const db = migrated()
  const queries = statements()

  // Vacuity guard. Extraction by regex is the kind of thing that silently
  // returns [] after an unrelated refactor, and an empty loop below would then
  // report success. The assertion is that the extractor still finds the
  // statements, so a change in this number is meant to be read and updated
  // deliberately, not to be loosened to `> 0`.
  //
  // 13: `policyOverrides` was retyping the same SELECT that
  // `OVERRIDE_ROWS_SQL` already holds, so there were two copies of one query
  // in this file (cyan N-3). It now uses the constant, and the extractor --
  // which only sees literals here -- counts one fewer. It was 14 earlier in
  // PR-4, 15 briefly, 14 in PR-3, 12 in PR-2, and this guard reported every
  // one of those moves rather than absorbing them.
  assert.equal(queries.length, 13, 'extractor still finds the DO statements')

  for (const query of queries) {
    // `db.prepare` throws on an unknown table or column, which is exactly the
    // class of defect this file exists for.
    db.prepare(query)
  }
})

test('the query extractor does not pick up the migration', () => {
  // If it did, the loop above would be exercising CREATE TABLE and not the
  // statements it claims to cover.
  for (const query of statements()) {
    assert.ok(!/CREATE\s+TABLE/i.test(query), 'migration leaked into the query set')
  }
})

// ---------------------------------------------------------------------------
// Which statuses the daily ceiling counts is a money decision, so it is
// executed rather than read. The query is extracted from the source and run
// against the real schema with one row in every status the ledger can write.
// ---------------------------------------------------------------------------

function ceilingQuery(): string {
  const source = readFileSync(
    join(import.meta.dirname, 'walletLedger.ts'),
    'utf8',
  )
  const found = source.match(
    /`SELECT SUM\(amount_eurc\) AS total FROM payments[\s\S]*?`/g,
  ) ?? []
  // Two call sites read this total: spentTodayEurc and reservePayment. If they
  // ever disagree, the reservation and the report would enforce different
  // ceilings, so they are required to be the same string.
  assert.equal(found.length, 2, 'both readers of the daily total are present')
  assert.equal(found[0], found[1], 'the two readers use the same query')
  return found[0].slice(1, -1)
}

test('the daily ceiling counts settled, pending and stuck -- not failed', () => {
  const db = migrated()
  const statuses = ['settled', 'pending', 'stuck', 'failed']
  for (const [index, status] of statuses.entries()) {
    db.exec(`
      INSERT INTO payments (
        idempotency_key, status, network, asset, amount_atomic, amount_eurc,
        pay_to, created_at, updated_at
      ) VALUES (
        'key-${index}', '${status}', 'eip155:8453', 'EURC', '1000000', 1.0,
        '0x0', 1000, 1000
      )
    `)
  }

  const row = db.prepare(ceilingQuery()).get(0)
  assert.ok(row)
  // 3.0, not 4.0: `failed` is excluded. And not 2.0: `stuck` is included,
  // because it is written when the payment was signed and submitted but the
  // outcome is unknown -- treating that as unspent lets repeated stuck
  // payments spend past the ceiling, which is the ceiling failing open in
  // exactly the case where something has already gone wrong.
  assert.equal(row.total, 3)
})

test('SOURCE: every exit after the reservation resolves the row', () => {
  // A row is written as `pending` before anything is signed. An exit that
  // leaves it there is a reservation that never resolves, and it is invisible:
  // the tool returns, the caller sees an error, and the ledger keeps counting
  // the amount against the daily ceiling forever.
  //
  // The exit that is easy to miss is the one that throws. The resend can move
  // money and then fail to return, so it must be wrapped.
  const body = methodBody('x402Pay', 'route/mcp/tools/x402Pay.ts')
  const afterReserve = body.slice(body.indexOf('reservePayment('))

  const settles = afterReserve.match(/settlePayment\(/g) ?? []
  // signing throw, resend throw, bad status, success.
  assert.equal(settles.length, 4, 'each post-reservation outcome resolves the row')

  // And the resend specifically is inside a try whose catch settles.
  assert.match(
    afterReserve,
    /try\s*\{[\s\S]*?paid = await probe\([\s\S]*?\}\s*catch[\s\S]*?settlePayment\(/,
    'the resend is wrapped and its catch resolves the row',
  )
  assert.match(
    afterReserve,
    /catch[\s\S]*?settlePayment\(\{[^}]*status:\s*'stuck'/,
    "and it resolves to 'stuck', which the ceiling counts, not 'failed'",
  )
})

test('SOURCE: x402Pay delegates the post-resend decision, it does not re-derive it', () => {
  // This replaces a set of textual pins. Three re-introductions of one
  // fail-open were caught here by pinning shapes (B-2, C-1, O-3), and each
  // pin only covered the shapes someone had thought of -- O-3 was still open
  // when PR-2 merged because `if (!accepted)` could be narrowed without
  // touching any pinned line.
  //
  // The decision now lives in lib/settle.ts, which node CAN load, and is
  // swept over its whole input grid there. What remains to check here is only
  // that this module asks it rather than answering for itself.
  const body = methodBody('x402Pay', 'route/mcp/tools/x402Pay.ts')
  const afterReserve = body.slice(body.indexOf('reservePayment('))

  assert.match(
    afterReserve,
    /const outcome = settleOutcome\(\{/,
    'the outcome comes from the shared decision',
  )
  assert.match(afterReserve, /if \(!outcome\.accepted\) \{/, 'acceptance is read, not recomputed')

  // No second opinion: the status literals and the accepted-status list must
  // not reappear in this module.
  assert.ok(
    !/\[200,\s*202,\s*409\]/.test(afterReserve),
    'the accepted-status list must live only in lib/settle.ts',
  )
  assert.ok(
    !/paid\.status === 402/.test(afterReserve),
    'the repeated-402 test must live only in lib/settle.ts',
  )

  // And the ledger writes use it.
  const writes = afterReserve.match(/status: settledStatus/g) ?? []
  assert.equal(writes.length, 3, 'both branches settle from the shared outcome, and one reports it')
})

test('README documents exactly the statuses the ledger can write', () => {
  // The README has a table saying which statuses exist and which count
  // toward the daily ceiling. It is a permanent surface describing code that
  // moves: `stuck` was added to the ceiling, and the stuck/failed split was
  // changed to turn on the transaction hash, after that table was first
  // written. A prose table that drifts from the union type tells an operator
  // the wrong thing about where their money went.
  const source = readFileSync(
    join(import.meta.dirname, 'walletLedger.ts'),
    'utf8',
  )
  const union = source.match(/status:\s*((?:'[a-z]+'\s*\|\s*)+'[a-z]+')/)
  assert.ok(union, 'settlePayment still declares a status union')
  const declared = [...union[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

  const readme = readFileSync(
    join(import.meta.dirname, '..', '..', 'README.md'),
    'utf8',
  )
  const table = readme.slice(readme.indexOf('| status | written when'))
  const documented = [...table.slice(0, table.indexOf('\n\n')).matchAll(/^\| `([a-z]+)` \|/gm)]
    .map((m) => m[1])
    .sort()

  assert.deepEqual(documented, declared)

  // And the ceiling's own list must be a subset of what can be written --
  // counting a status the code cannot produce would be a silent no-op.
  const counted = ceilingQuery().match(/'([a-z]+)'/g)?.map((s) => s.slice(1, -1)) ?? []
  assert.ok(counted.length > 0, 'the ceiling names statuses')
  for (const status of counted) {
    assert.ok(declared.includes(status), `the ceiling counts '${status}', which is never written`)
  }
})

test('settled is terminal: a late poll cannot reopen a completed payment', () => {
  // erpc_topup settles after paying and again after polling, and the failure
  // path tells the caller to poll again -- so a late poll arriving after the
  // grant landed is an ordinary event, not a pathology. Writing `pending`
  // over `settled` would show a finished purchase as open in the receipt an
  // operator reads. Executed against the real DDL and the real UPDATE.
  const db = migrated()
  db.exec(`
    INSERT INTO payments (
      idempotency_key, status, network, asset, amount_atomic, amount_eurc,
      pay_to, created_at, updated_at
    ) VALUES ('k', 'settled', 'eip155:8453', 'EURC', '1', 1.0, '0x0', 1, 1)
  `)

  const source = readFileSync(join(import.meta.dirname, 'walletLedger.ts'), 'utf8')
  const update = source.match(/`UPDATE payments[\s\S]*?`/)
  assert.ok(update, 'the settle UPDATE is still in the source')
  const sql = update[0].slice(1, -1)

  db.prepare(sql).run('pending', null, null, 2, 'k')
  const after = db.prepare(`SELECT status FROM payments WHERE idempotency_key = 'k'`).get()
  assert.ok(after)
  assert.equal(after.status, 'settled', 'a late poll must not reopen it')

  // Control: a non-terminal row IS still updated by the same statement, so
  // the guard narrows exactly one transition and not the whole method.
  db.exec(`
    INSERT INTO payments (
      idempotency_key, status, network, asset, amount_atomic, amount_eurc,
      pay_to, created_at, updated_at
    ) VALUES ('k2', 'pending', 'eip155:8453', 'EURC', '1', 1.0, '0x0', 1, 1)
  `)
  db.prepare(sql).run('settled', null, null, 2, 'k2')
  const moved = db.prepare(`SELECT status FROM payments WHERE idempotency_key = 'k2'`).get()
  assert.ok(moved)
  assert.equal(moved.status, 'settled', 'pending -> settled still works')
})

test('SOURCE: the synchronous grant records its invoice number', () => {
  // The rail answers a re-sent payment with 200 + status:'granted' +
  // invoiceNumber when the grant completes inline. That path never enters
  // erpc_topup's poll loop, whose condition is `status !== 'granted'`, and
  // with `settled` terminal there is no later repair either -- so if x402_pay
  // does not read it here, the tool's promise to report an invoice number
  // silently fails on the fastest, most ordinary outcome (steiner N-7).
  const body = methodBody('x402Pay', 'route/mcp/tools/x402Pay.ts')
  // Anchored on a marker that still exists. This slice used to start at
  // `const accepted =`, which PR-3 renamed when the decision moved into
  // lib/settle.ts -- indexOf returned -1, slice(-1) returned one character,
  // and the test failed saying the settle call was missing rather than saying
  // its anchor was. A slice anchor is a dependency like any other.
  const anchor = body.indexOf('const outcome = settleOutcome(')
  assert.notEqual(anchor, -1, 'the shared decision is still where this test looks')
  const accepted = body.slice(anchor)

  // Anchored to the LEDGER WRITE, not to any occurrence after that point.
  // Measured: a first version sliced from `const accepted =` and matched
  // `invoiceNumber: paidBody.invoiceNumber` anywhere in the tail -- which the
  // RESULT payload also contains, so deleting the ledger write left it green.
  // An assertion that cannot fail for the reason it names is the defect class
  // this package has shipped twice.
  // The LAST settlePayment in the method is the accepted-branch one; the
  // earlier one belongs to the refusal branch, which must NOT carry an
  // invoice number. Measured: slicing from the first occurrence grabbed the
  // refusal branch and failed for the wrong reason.
  const start = accepted.lastIndexOf('await ledger.settlePayment({')
  assert.notEqual(start, -1, 'the settle call was located')
  const settleCall = accepted.slice(start, accepted.indexOf('})', start) + 2)
  assert.ok(settleCall.includes('status: settledStatus'), 'and it is the accepted-branch one')
  assert.match(
    settleCall,
    /invoiceNumber:\s*paidBody\.invoiceNumber/,
    'the ledger write carries the invoice number',
  )
  assert.match(body, /invoiceNumber\?:\s*string/, 'and the body type declares it')
})

test('SOURCE: signPayment actually calls barrier 2', () => {
  // Extracting barrier 2 into `assertSignedMatchesTarget` bought evidence that
  // the FUNCTION is right and spent the evidence that it is WIRED. Measured:
  // deleting the call from signPayment leaves all 158 tests green and tsc
  // rc=0, because the four new tests call the function directly and the three
  // end-to-end ones pass on barrier 1 alone.
  //
  // This package has been here before. In round 1 the EURC-only top-up
  // restriction was "only as real as one unchecked wire" -- the control did
  // not fire until a SOURCE test pinned the call site. Same fix, same reason
  // (steiner B-6, #14018).
  const body = methodBody('signPayment', 'chain/x402Client.ts')
  assert.match(
    body,
    /assertSignedMatchesTarget\(\s*payload\s*,\s*target\s*\)/,
    'signPayment must invoke barrier 2, not merely define it',
  )

  // It must be a BARE STATEMENT, not merely text that appears before the
  // return. Measured: a first version checked only that the call's index was
  // lower than the return's, which is satisfied by
  // `const _late = () => assertSignedMatchesTarget(payload, target)` -- a
  // closure that is never invoked and never throws. Source position cannot
  // prove execution; requiring statement form can rule out the shapes that
  // definitely do not execute.
  assert.match(
    body,
    /^\s*assertSignedMatchesTarget\(payload, target\)\s*$/m,
    'barrier 2 must be called as a statement, not stored in a closure',
  )

  const callAt = body.indexOf('assertSignedMatchesTarget(')
  const returnAt = body.indexOf('return {')
  assert.ok(callAt !== -1 && returnAt !== -1, 'both sites located')
  assert.ok(callAt < returnAt, 'and it precedes the signed header being returned')
})

test('SOURCE: erpc_topup seeds its invoice number from the payment response', () => {
  // The other half of N-7. x402_pay records the invoice number in the ledger
  // on the synchronous grant; erpc_topup's OWN answer was still built from a
  // variable only the poll loop assigns, and that loop never runs when the
  // grant completed inline (`status !== 'granted'`). So the tool promised an
  // invoice number and returned none on the fastest outcome (steiner N-10).
  const source = readFileSync(
    join(import.meta.dirname, '..', 'route', 'mcp', 'tools', 'erpcTopup.ts'),
    'utf8',
  )
  assert.match(
    source,
    /let invoiceNumber: string \| undefined = data\.invoiceNumber/,
    'seeded from the payment response, not left undefined',
  )
  // The poll may still overwrite it; that ordering is what makes the seed a
  // floor rather than a cap.
  assert.match(source, /invoiceNumber = checkBody\.invoiceNumber \?\? invoiceNumber/)
})

// ---------------------------------------------------------------------------
// PR-3: policy overrides. The override and its audit row must land together,
// and the same no-await rule applies as for reservePayment.
// ---------------------------------------------------------------------------

test('SOURCE: setPolicyOverride contains no await', () => {
  // A crash between two separate calls leaves a changed ceiling with no
  // record of who changed it. `sql.exec` is synchronous; nothing may suspend
  // between the override write and the audit write.
  const body = methodBody('setPolicyOverride')
  assert.ok(!/\bawait\b/.test(body), 'setPolicyOverride must not suspend')
  assert.match(body, /INSERT INTO policy_overrides\s*\(/, 'it writes the override')
  assert.match(body, /INSERT INTO audit\s*\(/, 'and the audit row')
})

test('REACH: an override written to the real table refuses the next payment', () => {
  // 🔴 gilgamesh R2-N1. The binding "an override that lands mid-request binds
  // to THIS payment" was held by a SOURCE pin alone, and the pin passes a
  // broken implementation: `policyFromOverrideRows(loadPolicy(env), rows)`
  // changed to `(..., [])` keeps every token the pin looks for -- the SELECT,
  // the composition, the ceiling -- while discarding what it read. Measured
  // at the previous head: 237 pass, 0 red.
  //
  // So this runs the chain instead of reading it: write an override with the
  // real upsert into the real schema, read it back with the SAME string
  // production uses (OVERRIDE_ROWS_SQL), compose, and ask the decision.
  const db = migrated()
  const source = readFileSync(join(import.meta.dirname, 'walletLedger.ts'), 'utf8')
  const upsert = source
    .slice(source.indexOf('async setPolicyOverride'))
    .match(/`INSERT INTO policy_overrides[\s\S]*?`/)
  assert.ok(upsert, 'the real upsert was extracted from the source')

  const intent = {
    amountEurcEquivalent: '40',
    network: 'eip155:8453',
    asset: 'EURC',
    payTo: ERPC_TREASURY_BASE,
  }
  const ceiling = loadPolicy({ POLICY_ALLOW_ANY_PAYTO: 'true' } as never)
  // The executor production uses, backed by the real table. `policyFromLedger`
  // runs the query itself, so discarding the rows would have to happen inside
  // the function this drives.
  const select = (query: string) =>
    db.prepare(query).all() as { name: string; value: string }[]
  const read = () => policyFromLedger(ceiling, select)

  // Control first: with no override, 40 EURC is inside the shipped ceiling.
  assert.equal(
    reserveDecision({
      existing: undefined,
      spentTodayEurc: 0,
      policy: read(),
      intent,
    }).kind,
    'reserve',
    'control: the deploy-time ceiling allows this payment',
  )

  // Now an operator tightens the per-payment limit -- the key the first
  // version of this fix did not read at all (steiner B-1).
  db.prepare(upsert[0].slice(1, -1)).run('maxEurcPerPayment', '5', 1000)
  const refused = reserveDecision({
    existing: undefined,
    spentTodayEurc: 0,
    policy: read(),
    intent,
  })
  assert.equal(refused.kind, 'policy_violation', 'the stored override must bind')
  assert.deepEqual(
    refused.kind === 'policy_violation' ? refused.violations.map((v) => v.kind) : [],
    ['amount_over_per_payment'],
  )

  // And the daily key too, so this does not pass by covering one ceiling.
  db.prepare(upsert[0].slice(1, -1)).run('maxEurcPerDay', '1', 2000)
  const daily = reserveDecision({
    existing: undefined,
    spentTodayEurc: 0,
    policy: read(),
    intent: { ...intent, amountEurcEquivalent: '2' },
  })
  assert.equal(daily.kind, 'over_daily_ceiling')
})

test('the override and its audit row land together, against the real schema', () => {
  const db = migrated()
  const source = readFileSync(join(import.meta.dirname, 'walletLedger.ts'), 'utf8')
  const body = source.slice(source.indexOf('async setPolicyOverride'))

  const upsert = body.match(/`INSERT INTO policy_overrides[\s\S]*?`/)
  const audit = body.match(/`INSERT INTO audit[\s\S]*?`/)
  assert.ok(upsert && audit, 'both statements extracted from the real source')

  db.prepare(upsert[0].slice(1, -1)).run('maxEurcPerDay', '20', 1000)
  db.prepare(audit[0].slice(1, -1)).run(1000, 'f.kawasaki@elsoul.nl', 'policy_set', 'maxEurcPerDay: 200 -> 20')

  const row = db.prepare(`SELECT value FROM policy_overrides WHERE name = 'maxEurcPerDay'`).get()
  assert.ok(row)
  assert.equal(row.value, '20')

  const logged = db.prepare(`SELECT action, detail FROM audit`).get()
  assert.ok(logged)
  assert.equal(logged.action, 'policy_set')
  assert.match(String(logged.detail), /200 -> 20/, 'both sides of the change are readable')

  // Upsert, not insert-only: tightening twice must not fail on the primary key.
  db.prepare(upsert[0].slice(1, -1)).run('maxEurcPerDay', '5', 2000)
  const again = db.prepare(`SELECT value FROM policy_overrides WHERE name = 'maxEurcPerDay'`).get()
  assert.ok(again)
  assert.equal(again.value, '5')
})

test('SOURCE: a replay reports the prior OUTCOME, not a bare success', () => {
  // B-3 had no control at all. Measured by cyan: replacing
  // `if (priorStatus === 'failed')` with `if (false)` left the whole suite
  // green, so the branch that stops a failed payment replaying as `ok: true`
  // was entirely unguarded.
  //
  // Reporting a failure as a success is worse than the failure: the caller
  // reads "already paid" about a payment that never happened, and the
  // idempotency key is spent either way so it cannot retry.
  const body = methodBody('x402Pay', 'route/mcp/tools/x402Pay.ts')
  const replay = body.slice(0, body.indexOf('const challenge ='))

  assert.match(
    replay,
    /^\s*const priorStatus = String\(/m,
    'the prior row\'s status is read',
  )
  assert.match(
    replay,
    /^\s*if \(priorStatus === 'failed'\) \{\s*$/m,
    "a prior 'failed' is branched on by value, not by a constant",
  )
  assert.match(
    replay,
    /^\s*if \(priorStatus === 'stuck'\) \{\s*$/m,
    "and so is a prior 'stuck', whose outcome is unknown",
  )

  // Both refusals must precede the only ok() in the replay block, or the
  // branch order decides nothing.
  const okAt = replay.indexOf('return ok(')
  assert.notEqual(okAt, -1, 'the replay block still has its success path')
  for (const status of ['failed', 'stuck']) {
    const at = replay.indexOf(`priorStatus === '${status}'`)
    assert.ok(at !== -1 && at < okAt, `'${status}' is decided before the success path`)
  }
})

test('SOURCE: the status x402_pay reports is the status it wrote', () => {
  // They were computed separately, and a 409 wrote `stuck` while returning
  // 'pending'. erpc_topup fed that back into settlePayment and demoted the
  // row, losing "the outcome is unknown" from the record. `settled` is
  // terminal so it was safe; `stuck` is not (it can still resolve), which is
  // exactly why it was demotable (cyan O-1).
  const body = methodBody('x402Pay', 'route/mcp/tools/x402Pay.ts')
  // Sliced from the ACCEPTED branch, not from `const accepted =` -- the
  // refusal branch above computes its own settledStatus and writes it too,
  // so a slice from the declaration counts three and says nothing about the
  // pairing this test is named for. Measured: the first version asserted 2
  // and found 3.
  const accepted = body.slice(body.indexOf('// Accepted.'))

  // One source of truth, used for both the ledger write and the answer.
  const writes = accepted.match(/status: settledStatus/g) ?? []
  assert.equal(writes.length, 2, 'settledStatus is both written and reported')
  assert.ok(
    !/status: paidBody\.status \?\?/.test(accepted),
    'the reported status must not be recomputed from the body',
  )
})
