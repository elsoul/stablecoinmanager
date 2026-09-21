#!/usr/bin/env node
/**
 * Generate this deployment's wallet and hand it straight to
 * `wrangler secret put WALLET_MNEMONIC`.
 *
 * The phrase is never printed, never written to a file, and never placed in
 * argv (where `ps` would show it). It exists in this process's memory and in
 * the pipe to wrangler, and nowhere else. The operator sees only the derived
 * addresses -- which is all they need in order to fund the wallet.
 *
 * Losing the phrase means losing the funds, so `wallet_export_seed` is the
 * intended way to take a backup afterwards, from a logged-in MCP session.
 *
 * Refuses to run when a secret already exists: silently replacing the
 * mnemonic of a funded wallet would strand every asset in it.
 *
 * Usage:
 *   pnpm -F mcp-stablecoin-manager wallet:init            # production
 *   pnpm -F mcp-stablecoin-manager wallet:init -- --dry-run
 */
import { spawn, spawnSync } from 'node:child_process'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { mnemonicToAccount } from 'viem/accounts'

const SECRET_NAME = 'WALLET_MNEMONIC'
const dryRun = process.argv.includes('--dry-run')

function listExistingSecrets() {
  const result = spawnSync('npx', ['wrangler', 'secret', 'list'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

// A dry run answers "does this script work and what would it create?", so it
// must not require Cloudflare credentials -- that is exactly the state an
// operator is in before they have set anything up.
if (dryRun) {
  const phrase = generateMnemonic(wordlist, 256)
  console.log('dry run: a 24-word phrase was generated and discarded.')
  console.log(
    'EVM address that would have been created: ' +
      mnemonicToAccount(phrase, { path: "m/44'/60'/0'/0/0" }).address,
  )
  process.exit(0)
}

const existing = listExistingSecrets()
if (existing === null) {
  console.error(
    `Could not read the current secret list. Refusing to write ${SECRET_NAME} ` +
      'without knowing whether one already exists.',
  )
  process.exit(1)
}
if (Array.isArray(existing) && existing.some((entry) => entry?.name === SECRET_NAME)) {
  console.error(
    `${SECRET_NAME} already exists on this worker. Refusing to overwrite it: ` +
      'if you replace the phrase of a funded wallet, the funds stay with the ' +
      'old one. Export the current phrase first (wallet_export_seed), then ' +
      `delete the secret deliberately with \`wrangler secret delete ${SECRET_NAME}\`.`,
  )
  process.exit(1)
}

// 24 words. 256 bits of entropy, from the platform CSPRNG via @scure/bip39.
const mnemonic = generateMnemonic(wordlist, 256)

// Derived only so the operator knows where to send money. Deriving the Solana
// side here would pull the whole keyring into a script whose single job is to
// pipe a secret, so the EVM address (the one the canary funds) is enough --
// `wallet_status` reports both once the worker is up.
const evm = mnemonicToAccount(mnemonic, { path: "m/44'/60'/0'/0/0" }).address

const child = spawn('npx', ['wrangler', 'secret', 'put', SECRET_NAME], {
  stdio: ['pipe', 'inherit', 'inherit'],
})

// `printf '%s'` semantics: no trailing newline. wrangler trims trailing
// whitespace but not a leading BOM or space, and a secret with a stray byte
// derives a different wallet than the one whose address is printed below.
child.stdin.write(mnemonic)
child.stdin.end()

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`wrangler secret put failed (exit ${code}). No wallet was stored.`)
    process.exit(code ?? 1)
  }
  console.log(`\n${SECRET_NAME} stored.`)
  console.log(`EVM address (Ethereum / Base / Avalanche C): ${evm}`)
  console.log(
    '\nNext:\n' +
      '  1. Deploy, then call wallet_status over MCP to see both addresses.\n' +
      '  2. Take a backup with wallet_export_seed and store it offline.\n' +
      '  3. Fund the EVM address with EURC on Base to run the top-up canary.',
  )
})
