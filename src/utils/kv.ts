// Redis-style get/set/del helpers over a Workers KV namespace.
import type { KVNamespace } from '@cloudflare/workers-types'

/**
 * KV wrapper that replaces Redis operations.
 * Provides get/set/del/exists with TTL support,
 * plus sAdd/sMembers emulation using JSON arrays.
 */
export const createKVStore = (kv: KVNamespace) => ({
  async get(key: string): Promise<string | null> {
    return kv.get(key)
  },

  async set(
    key: string,
    value: string,
    mode?: 'EX',
    duration?: number,
  ): Promise<void> {
    const options: { expirationTtl?: number } = {}
    if (mode === 'EX' && duration) {
      options.expirationTtl = duration
    }
    await kv.put(key, value, options)
  },

  async del(key: string): Promise<void> {
    await kv.delete(key)
  },

  async exists(key: string): Promise<boolean> {
    const value = await kv.get(key)
    return value !== null
  },

  // sAdd emulation: store set members as JSON array
  async sAdd(key: string, member: string, expirationTtl?: number): Promise<void> {
    const existing = await kv.get(key)
    const members: string[] = existing ? JSON.parse(existing) : []
    if (!members.includes(member)) {
      members.push(member)
    }
    const options: { expirationTtl?: number } = {}
    if (expirationTtl) {
      options.expirationTtl = expirationTtl
    }
    await kv.put(key, JSON.stringify(members), options)
  },

  // sMembers emulation
  async sMembers(key: string): Promise<string[]> {
    const existing = await kv.get(key)
    return existing ? JSON.parse(existing) : []
  },

  // sRem emulation
  async sRem(key: string, member: string): Promise<void> {
    const existing = await kv.get(key)
    if (!existing) return
    const members: string[] = JSON.parse(existing)
    const filtered = members.filter((m) => m !== member)
    if (filtered.length === 0) {
      await kv.delete(key)
    } else {
      await kv.put(key, JSON.stringify(filtered))
    }
  },

  // expire emulation (re-put with TTL)
  async expire(key: string, ttlSeconds: number): Promise<void> {
    const value = await kv.get(key)
    if (value !== null) {
      await kv.put(key, value, { expirationTtl: ttlSeconds })
    }
  },
})

export type KVStore = ReturnType<typeof createKVStore>
