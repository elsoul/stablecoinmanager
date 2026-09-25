import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

// Pointer: PR #14211 steiner r1 B-1.

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..')

test('the deploy-config CLI script runs under plain node against the real wrangler.toml', () => {
  const result = spawnSync(process.execPath, ['scripts/assertProductionConfig.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
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
