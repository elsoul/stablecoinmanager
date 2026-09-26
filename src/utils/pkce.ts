// Copied unchanged from `api/mcp/master-api/src/utils/` -- generic OAuth/KV
// primitives with no Discord or master-api specifics. Kept identical so the
// two MCP workers' OAuth surfaces stay auditable against each other.
function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return toBase64Url(array.buffer)
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(hash)
}

export async function verifyPKCE(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const computedChallenge = await generateCodeChallenge(verifier)
  return computedChallenge === challenge
}
