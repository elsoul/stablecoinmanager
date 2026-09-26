/**
 * Last line of defence on the way out.
 *
 * Tool results and log lines pass through here. This is not a substitute for
 * not putting secrets in objects in the first place -- it is the backstop for
 * the case we did not think of, because the cost of one leaked mnemonic is the
 * whole wallet.
 *
 * SCOPE, measured rather than asserted: every `return text(...)` in
 * `route/mcp/index.ts` wraps its payload in `redact`, INCLUDING the
 * unknown-tool and catch-all branches, with exactly one deliberate exception
 * -- `wallet_export_seed`, whose entire purpose is the secret and which
 * therefore returns its own shape. If a new tool is added, the wrapping is
 * per-branch and has to be repeated; nothing enforces it structurally.
 */
const SECRET_KEY_PATTERN =
  /^(.*(mnemonic|seed_phrase|seedphrase|privatekey|private_key|secretkey|secret_key|apikey|api_key|access_token|refresh_token|authorization|password|jwt_secret|bearer).*)$/i

/** Anything long enough to be a credential in a value we did not expect. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi
/** A BIP-39 phrase is 12 or 24 lowercase words; 12+ in a row is never legitimate output. */
const MNEMONIC_PATTERN = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g

export const REDACTED = '[redacted]'

/**
 * Values we hold and must never emit, matched literally.
 *
 * `literals` is REQUIRED, like safeLog's env. Defaulting it to `[]` is the
 * same shape as the rule that went unfollowed at 17 of 18 call sites: an easy
 * way to call the function without the part that does the work. Pass
 * `heldSecrets(env)`, or `[]` deliberately when there is genuinely nothing to
 * match.
 *
 * The patterns above only recognise credential SHAPES and object KEY names,
 * which misses the case that actually happens: an upstream library echoing our
 * own api key back inside an error message, typically as the query string of
 * the request URL it failed on. That string reaches a caller through
 * `wallet_status`'s reachability detail and `holdings`' warnings, and no shape
 * rule can know it is a secret -- only we know, because we are holding it.
 */
/**
 * One predicate, used by both the collector and the stripper.
 *
 * A value that is only whitespace is not a secret -- `lib/runtimeSecrets.ts`
 * says so too, by trimming before deciding whether a secret is set. Taking it
 * as a needle would replace every run of spaces in ordinary output with
 * `[redacted]`: not a leak, but the same "two predicates for one question"
 * shape that has already been a defect once in this file.
 */
const MIN_LITERAL_LENGTH = 8
function isStrippableLiteral(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_LITERAL_LENGTH &&
    value.trim().length > 0
  )
}

export function redactString(value: string, literals: readonly string[]): string {
  let out = value
  for (const literal of literals) {
    // Same predicate as heldSecrets. They disagreed once: one measured the
    // trimmed length and the other split on the untrimmed value, so a secret
    // stored with surrounding whitespace was collected and then not stripped.
    if (isStrippableLiteral(literal)) {
      out = out.split(literal).join(REDACTED)
    }
  }
  return out
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(MNEMONIC_PATTERN, REDACTED)
}

export function redact<T>(value: T, literals: readonly string[]): T {
  return redactValue(value, 0, literals) as T
}

function redactValue(
  value: unknown,
  depth: number,
  literals: readonly string[],
): unknown {
  if (depth > 12) return REDACTED
  if (typeof value === 'string') return redactString(value, literals)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, literals))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValue(item, depth + 1, literals)
    }
    return out
  }
  return value
}

export interface SecretBearingEnv {
  ERPC_API_KEY?: string
  WALLET_MNEMONIC?: string
  JWT_SECRET?: string
  REFRESH_TOKEN_SECRET?: string
  OAUTH_STATE_SECRET?: string
}

/**
 * The literals this worker holds, in every form they could appear in.
 *
 * Both the stored value AND its trimmed form: a secret stored with surrounding
 * whitespace still travels through an upstream error message WITHOUT that
 * whitespace, so stripping only the stored form leaves the value itself
 * readable. Agreeing on one predicate is not the same as covering the value;
 * an earlier version missed that distinction and left a padded secret
 * readable.
 */
export function heldSecrets(env: SecretBearingEnv): string[] {
  const forms = new Set<string>()
  for (
    const value of [
      env.ERPC_API_KEY,
      env.WALLET_MNEMONIC,
      env.JWT_SECRET,
      env.REFRESH_TOKEN_SECRET,
      env.OAUTH_STATE_SECRET,
    ]
  ) {
    if (typeof value !== 'string') continue
    for (const form of [value, value.trim()]) {
      if (isStrippableLiteral(form)) forms.add(form)
    }
  }
  // Longest first, so a padded form is replaced before its own substring is.
  return [...forms].sort((a, b) => b.length - a.length)
}

/**
 * The logger this worker uses. `grep -rn 'console\.' src/ --include='*.ts'`
 * outside this file and the tests returns nothing, which is what makes the
 * redaction above worth anything.
 *
 * It takes `env` rather than a list of literals ON PURPOSE. The previous
 * signature accepted an optional `literals` argument with a doc comment asking
 * callers to pass it "wherever the detail can contain an upstream string" --
 * a rule followed at 1 of 18 call sites. Taking the env makes forgetting a
 * type error instead of a habit, which is the only version of this that stays
 * true as the file grows.
 *
 * It matters because observability runs with `invocation_logs = true` and
 * `head_sampling_rate = 1`: everything written here is captured durably, 100%
 * of the time. A log line and a caller-facing payload are the same disclosure.
 */
export function safeLog(
  env: SecretBearingEnv,
  message: string,
  detail?: unknown,
): void {
  const literals = heldSecrets(env)
  if (detail === undefined) {
    console.log(redactString(message, literals))
    return
  }
  console.log(redactString(message, literals), JSON.stringify(redact(detail, literals)))
}
