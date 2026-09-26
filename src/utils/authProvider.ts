/**
 * Which login provider this deploy uses. `app-oidc` signs in through the
 * app-oidc-api broker (utils/appOidc.ts); `erpc-auth-api`, the default when
 * AUTH_PROVIDER is unset, is ERPC's own auth-api (utils/authApi.ts).
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
