import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { unrenderedPlaceholders } from './productionConfig.ts'

// `assert:prod-config` runs this module under plain node, not tsx, so an
// import that only resolves through tsconfig paths fails there and nowhere else.

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..')

// The checked-in wrangler.toml is a template until `erpc app init` renders it,
// and an unrendered template is refused by design. Exactly one of the next two
// tests runs: the first in a rendered app, the second in the template itself.
const unrendered = () =>
  unrenderedPlaceholders(readFileSync(join(PACKAGE_ROOT, 'wrangler.toml'), 'utf8')).length > 0

test('the deploy-config CLI script runs under plain node against the real wrangler.toml', (t) => {
  if (unrendered()) return t.skip('unrendered template')
  const result = spawnSync(process.execPath, ['scripts/assertProductionConfig.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
})

test('the deploy-config CLI script refuses the unrendered template under plain node', (t) => {
  if (!unrendered()) return t.skip('rendered app')
  const result = spawnSync(process.execPath, ['scripts/assertProductionConfig.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
  assert.match(result.stderr, /unrendered/)
})

test('a plain-node import of productionConfig.ts still refuses a bogus config', () => {
  const inline = [
    "import { assertDeployableProductionConfig } from './src/lib/productionConfig.ts'",
    'try {',
    '  assertDeployableProductionConfig(\'AUTH_PROVIDER = "bogus"\')',
    '  process.exit(0)',
    '} catch (error) {',
    '  console.error(error instanceof Error ? error.message : error)',
    '  process.exit(1)',
    '}',
  ].join('\n')

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', inline], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
  assert.match(result.stderr, /Unknown AUTH_PROVIDER/)
})
