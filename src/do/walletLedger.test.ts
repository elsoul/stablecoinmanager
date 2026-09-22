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

function methodBody(name: string, file = 'do/walletLedger.ts'): string {
  const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
  // Methods are `async name(`; module-level handlers are `function name(`.
  // Both are matched so one extractor covers both, rather than a second copy
  // of this logic drifting away from the parameter-list fix below.
  const start = ['async ', 'function '].reduce((found, prefix) => {
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
  // Twelve is the count today.
  assert.equal(queries.length, 12, 'extractor still finds the DO statements')

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

test("SOURCE: after a signed resend, only a repeated 402 may be called 'failed'", () => {
  // Once a signed payment has been transmitted, the ledger may claim nothing
  // happened ONLY with evidence. A resource answering 402 again is that
  // evidence -- it is still asking, so ours was not consumed. Every other
  // non-acceptance is `stuck`, which the daily ceiling counts.
  //
  // This replaced a rule that keyed on the transaction hash. That rule fixed
  // "error status WITH a hash" and left its converse open: an ACCEPTED answer
  // with NO hash -- the ordinary success shape of a generic x402 resource, a
  // 200 with content and no settle header -- was recorded `failed` and went
  // uncounted. A successful payment telling the ceiling it never happened is
  // the same fail-open reached from the other side (steiner, #14018 B-2).
  const body = methodBody('x402Pay', 'route/mcp/tools/x402Pay.ts')
  const afterReserve = body.slice(body.indexOf('reservePayment('))

  assert.match(
    afterReserve,
    /const\s+stillAsking\s*=\s*paid\.status\s*===\s*402/,
    'the refusal branch must decide on a repeated 402',
  )
  assert.match(
    afterReserve,
    /const\s+settledStatus\s*=\s*stillAsking\s*\?\s*'failed'\s*:\s*'stuck'/,
    "and only that case may be 'failed'",
  )

  // Acceptance must not require a hash. Requiring one is exactly what routed
  // the no-hash success into the refusal branch.
  //
  // 🔴 ANCHORED to the whole line. The first version matched the expression
  // unanchored and then ruled out ONE textual shape (`|| !txHash`). Measured
  // by cyan: appending `&& Boolean(txHash)` re-introduces B-2 and this test
  // stays green -- the positive match still succeeds and the negative one
  // does not describe that shape. A guard that runs, names the coverage in
  // its own comment, and does not have it is worse than an absent one,
  // because the next reader greps, finds it, and stops looking.
  assert.match(
    afterReserve,
    /^\s*const accepted = \[200, 202, 409\]\.includes\(paid\.status\)\s*$/m,
    'acceptance is decided by status ALONE -- nothing else on that line',
  )

  // 409 is the rail's "stuck", so it must not land as `pending`.
  assert.match(
    afterReserve,
    /paidBody\.status === 'stuck' \|\| paid\.status === 409/,
    "409 settles as stuck, matching the proven client's status map",
  )

  // Two places may still say 'failed' after the reservation, and they are
  // named rather than counted: the signing failure, where nothing was ever
  // transmitted, and the repeated-402 case above. Anything else appearing
  // here would be a third claim that nothing happened.
  const signingFailure = /catch \(error\) \{[\s\S]{0,200}?status: 'failed'/
  assert.match(afterReserve, signingFailure, "the signing failure still writes 'failed'")

  const failedWrites = afterReserve.match(/'failed'/g) ?? []
  assert.equal(
    failedWrites.length,
    2,
    `'failed' appears ${failedWrites.length} times after the reservation; ` +
      'expected exactly the signing failure and the repeated-402 case',
  )
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
  const accepted = body.slice(body.indexOf('const accepted ='))

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
