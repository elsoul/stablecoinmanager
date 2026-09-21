/**
 * Deploy-time refusals. `deploy:prod` and `test:deploy` both run these before
 * anything is shipped, so a misconfigured wrangler.toml fails the pipeline
 * instead of producing a worker that holds a wallet but is reachable on the
 * wrong origin or with a dev fallback in place.
 */
const PLACEHOLDER_KV_IDS = [
  'REPLACE_WITH_KV_NAMESPACE_ID',
  'PLACEHOLDER_KV_ID',
  'PLACEHOLDER_KV_PREVIEW_ID',
]

const PRODUCTION_HOST = 'mcp-stablecoin-manager.erpc.global'

export const assertDeployableProductionConfig = (raw: string): void => {
  // Judge the CONFIG, not the prose about it. This file's own header explains
  // that WALLET_MNEMONIC and ERPC_API_KEY are `wrangler secret` only, and a
  // checker that reads its own documentation as a violation refuses every
  // correct deploy.
  const config = stripComments(raw)

  const kvId = config
    .match(
      /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"MCP_KV"[\s\S]*?id\s*=\s*"([^"]*)"/,
    )?.[1]
    ?.trim() ?? ''
  if (!kvId || PLACEHOLDER_KV_IDS.includes(kvId)) {
    throw new Error(
      'MCP_KV namespace is not provisioned; refusing production deployment',
    )
  }

  if (
    !/\[\[durable_objects\.bindings\]\][\s\S]*?class_name\s*=\s*"WalletLedger"/
      .test(config)
  ) {
    throw new Error('WalletLedger Durable Object binding is missing')
  }

  // Migration tags are cumulative. Dropping v1 orphans every ledger row, which
  // is how a double-payment guard silently stops guarding.
  if (!/\[\[migrations\]\][\s\S]*?tag\s*=\s*"v1"/.test(config)) {
    throw new Error('WalletLedger migration tag v1 is missing')
  }

  if (
    !new RegExp(
      `\\[\\[routes\\]\\][\\s\\S]*?pattern\\s*=\\s*"${PRODUCTION_HOST}"[\\s\\S]*?custom_domain\\s*=\\s*true`,
    ).test(config)
  ) {
    throw new Error(
      `custom domain route ${PRODUCTION_HOST} is missing; refusing production deployment`,
    )
  }

  const allowed = config
    .match(/ALLOWED_GOOGLE_EMAILS\s*=\s*"([^"]*)"/)?.[1]
    ?.trim() ?? ''
  if (!allowed) {
    throw new Error(
      'ALLOWED_GOOGLE_EMAILS is empty; refusing to deploy a wallet with no login allowlist',
    )
  }

  if (/NODE_ENV\s*=\s*"development"/.test(config)) {
    throw new Error('development NODE_ENV is present in the production config')
  }

  if (/workers_dev\s*=\s*true/.test(config)) {
    throw new Error(
      'workers_dev = true exposes a *.workers.dev origin the redirect_uri pin does not cover',
    )
  }

  // A seed phrase or API key that reaches a config file has to be treated as
  // disclosed. Both are `wrangler secret` only.
  if (/WALLET_MNEMONIC|ERPC_API_KEY/.test(config)) {
    throw new Error(
      'WALLET_MNEMONIC / ERPC_API_KEY must never appear in wrangler config; use `wrangler secret put`',
    )
  }

  // Exactly the values wrangler.dev.toml carries. They are spelled "dummy-…"
  // so the repository credential scanner recognises them as placeholders; the
  // point of this check is that they must never reach production anyway.
  for (
    const devSecret of [
      'dummy-jwt-secret-local-only',
      'dummy-refresh-secret-local-only',
      'dummy-state-secret-local-only',
    ]
  ) {
    if (config.includes(devSecret)) {
      throw new Error(`development secret ${devSecret} is present in the production config`)
    }
  }
}

/** Drop whole-line TOML comments. Values never start a line with `#`. */
function stripComments(config: string): string {
  return config
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}
