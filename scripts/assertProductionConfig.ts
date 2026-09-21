import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertDeployableProductionConfig } from '../src/lib/productionConfig.ts'

// import.meta.dirname rather than new URL(...): @cloudflare/workers-types
// replaces the global URL with the Workers one, which node:fs refuses.
try {
  const config = await readFile(
    join(import.meta.dirname, '../wrangler.toml'),
    'utf8',
  )
  assertDeployableProductionConfig(config)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
