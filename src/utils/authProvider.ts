/**
 * Which login provider this deploy uses. See
 * docs/superpowers/plans/2026-09-25-stablecoin-manager-app-oidc-branch-madeen.md
 * §1.
 */

export const AUTH_PROVIDERS = ['erpc-auth-api', 'app-oidc'] as const

export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

export function resolveAuthProvider(env: { AUTH_PROVIDER?: string }): AuthProvider {
  const raw = env.AUTH_PROVIDER
  if (raw === undefined || raw === '') return 'erpc-auth-api'
  if ((AUTH_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as AuthProvider
  }
  throw new Error(`Unknown AUTH_PROVIDER: ${JSON.stringify(raw)}`)
}
