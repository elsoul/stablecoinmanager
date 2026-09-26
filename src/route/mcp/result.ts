/**
 * The output contract every tool obeys.
 *
 * `next` is the point of it: the caller is an agent, so a result that says
 * only "insufficient funds" wastes a turn. Saying "send >= 4.84 EURC on Base
 * to 0x..., then call erpc_topup again" is a result it can act on.
 *
 * Money is always reported three ways -- atomic string, human string, and a
 * currency label -- because a bare number is the shape that turns into a
 * hundred-fold payment somewhere downstream.
 */
export interface ToolResult<T = unknown> {
  ok: boolean
  data: T
  next: string[]
  warnings: string[]
  receipt?: unknown
}

export interface Money {
  atomic: string
  human: string
  currency: string
}

export function money(atomic: string, decimals: number, currency: string): Money {
  return { atomic, human: formatAtomic(atomic, decimals), currency }
}

export function formatAtomic(atomic: string, decimals: number): string {
  const negative = atomic.startsWith('-')
  const digits = (negative ? atomic.slice(1) : atomic).replace(/^0+(?=\d)/, '')
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : ''
  const trimmed = fraction.replace(/0+$/, '')
  const body = trimmed ? `${whole}.${trimmed}` : whole
  return negative ? `-${body}` : body
}

export function ok<T>(data: T, next: string[] = [], warnings: string[] = []): ToolResult<T> {
  return { ok: true, data, next, warnings }
}

export function fail<T>(data: T, next: string[] = [], warnings: string[] = []): ToolResult<T> {
  return { ok: false, data, next, warnings }
}
