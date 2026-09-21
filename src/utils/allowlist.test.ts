import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeJwtPayload,
  evaluateLogin,
  parseAllowedEmails,
} from './allowlist.ts'

const OWNER = 'f.kawasaki@elsoul.nl'
const good = {
  sub: '1234567890',
  provider: 'google',
  email: OWNER,
  isEmailVerified: true,
}

test('the allowlist parses a comma list and normalizes case and spacing', () => {
  assert.deepEqual(parseAllowedEmails(' A@x.com , b@Y.com ,, '), [
    'a@x.com',
    'b@y.com',
  ])
  assert.deepEqual(parseAllowedEmails(''), [])
  assert.deepEqual(parseAllowedEmails(undefined), [])
})

test('the owner is authorized', () => {
  const result = evaluateLogin(good, OWNER)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.identity, {
    subject: '1234567890',
    email: OWNER,
  })
})

test('an email outside the list is refused', () => {
  const result = evaluateLogin({ ...good, email: 'someone@else.com' }, OWNER)
  assert.deepEqual(result, { ok: false, reason: 'email_not_allowed' })
})

test('an EMPTY allowlist authorizes nobody (fails closed)', () => {
  // The failure that matters: reading "no entries" as "no restriction" would
  // hand the wallet to whoever logs in first.
  assert.deepEqual(evaluateLogin(good, ''), {
    ok: false,
    reason: 'allowlist_empty',
  })
  assert.deepEqual(evaluateLogin(good, undefined), {
    ok: false,
    reason: 'allowlist_empty',
  })
  assert.deepEqual(evaluateLogin(good, '  ,  '), {
    ok: false,
    reason: 'allowlist_empty',
  })
})

test('an unverified address is refused even when it is on the list', () => {
  assert.deepEqual(evaluateLogin({ ...good, isEmailVerified: false }, OWNER), {
    ok: false,
    reason: 'email_unverified',
  })
  assert.deepEqual(
    evaluateLogin({ ...good, isEmailVerified: undefined }, OWNER),
    { ok: false, reason: 'email_unverified' },
  )
})

test('a non-google provider is refused even with the right address', () => {
  assert.deepEqual(evaluateLogin({ ...good, provider: 'discord' }, OWNER), {
    ok: false,
    reason: 'provider_not_google',
  })
  assert.deepEqual(evaluateLogin({ ...good, provider: undefined }, OWNER), {
    ok: false,
    reason: 'provider_not_google',
  })
})

test('matching is case- and whitespace-insensitive on both sides', () => {
  assert.equal(
    evaluateLogin({ ...good, email: '  F.Kawasaki@ELSOUL.nl ' }, ` ${OWNER} `)
      .ok,
    true,
  )
})

test('a missing email or subject is refused', () => {
  assert.deepEqual(evaluateLogin({ ...good, email: undefined }, OWNER), {
    ok: false,
    reason: 'email_missing',
  })
  assert.deepEqual(evaluateLogin({ ...good, sub: '' }, OWNER), {
    ok: false,
    reason: 'subject_missing',
  })
})

test('jwt payload decoding survives base64url and rejects junk', () => {
  const payload = { sub: 'abc', email: OWNER, isEmailVerified: true }
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(
      /=/g,
      '',
    )
  const token = `header.${b64(payload)}.signature`
  assert.deepEqual(decodeJwtPayload(token), payload)

  assert.equal(decodeJwtPayload('not-a-jwt'), null)
  assert.equal(decodeJwtPayload('a.b'), null)
  assert.equal(decodeJwtPayload('a.!!!!.c'), null)
  assert.equal(decodeJwtPayload(`a.${btoa('"just-a-string"')}.c`), null)
})
