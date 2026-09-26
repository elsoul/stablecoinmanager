// HMAC-signed OAuth `state` for the login round trip. Two things here are
// deliberate:
//   1. `StateData.upstreamVerifier` (see below).
//   2. `verify()` compares in constant time rather than with `a === b`:
//      this worker's token.ts already uses a timingSafeEqual for client
//      secrets, and two different answers to the same question in one worker
//      is how the wrong one survives a refactor.
function toBase64Url(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function fromBase64Url(str: string): Uint8Array {
  // Restore padding
  let padded = str.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4 !== 0) {
    padded += '='
  }
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export interface StateData {
  resource: string
  /** The MCP CLIENT's PKCE challenge, verified on our own /oauth/token. */
  codeChallenge: string
  timestamp: number
  nonce: string
  redirectUri?: string
  clientState?: string
  clientId?: string
  /**
   * OUR PKCE verifier for the upstream auth-api leg. It is carried here rather
   * than in KV because the state is already HMAC-signed and single-use by
   * expiry, and because a KV round trip would introduce an eventually
   * consistent read into the middle of a login. It never leaves the worker:
   * the signed blob goes to auth-api, which treats it as opaque, and comes
   * back to our own callback.
   */
  upstreamVerifier?: string
}

async function sign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(data),
  )
  return toBase64Url(signature)
}

async function verify(
  data: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expected = await sign(data, secret)
  // Constant time, to match the comparison token.ts already does for client
  // secrets. Two different answers to the same question in one worker is the
  // kind of inconsistency that becomes the wrong one after a refactor.
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

export async function encodeState(
  data: StateData,
  secret: string,
): Promise<string> {
  const json = JSON.stringify(data)
  const encoded = toBase64Url(new TextEncoder().encode(json))
  const signature = await sign(encoded, secret)
  return `${encoded}.${signature}`
}

export async function decodeState(
  state: string,
  secret: string,
): Promise<StateData> {
  const [encoded, signature] = state.split('.')

  if (!encoded || !signature) {
    throw new Error('Invalid state format')
  }

  const isValid = await verify(encoded, signature, secret)
  if (!isValid) {
    throw new Error('State signature verification failed')
  }

  const json = new TextDecoder().decode(fromBase64Url(encoded))
  const data = JSON.parse(json) as StateData

  // 10 minute expiry
  const now = Date.now()
  if (now - data.timestamp > 600000) {
    throw new Error('State expired')
  }

  return data
}

export function generateNonce(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return toBase64Url(array)
}
