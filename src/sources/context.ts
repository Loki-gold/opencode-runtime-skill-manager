import type { Logger } from "../log.ts"
import type { DownloadOptions } from "../download.ts"
import type { Limits } from "../types.ts"

export interface CacheEntry<T> {
  readonly value: T
  readonly expires: number
}

export class Cache {
  private readonly values = new Map<string, CacheEntry<unknown>>()

  get<T>(key: string): T | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (entry.expires < Date.now()) {
      this.values.delete(key)
      return undefined
    }
    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs: number): T {
    this.values.set(key, { value, expires: Date.now() + ttlMs })
    if (this.values.size > 500) {
      const oldest = this.values.keys().next().value
      if (oldest) this.values.delete(oldest)
    }
    return value
  }
}

export interface SourceContext {
  readonly download: DownloadOptions
  readonly limits: Limits
  readonly log: Logger
  readonly cache: Cache
  readonly githubToken?: string
  readonly allowPrivateHosts: boolean
}
