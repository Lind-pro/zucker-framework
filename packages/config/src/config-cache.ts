/** Options for the process-local configuration caches. */
export interface ConfigCacheOptions {
  /**
   * Lifetime of a cached value. Bounds how long another replica's change can stay
   * invisible when no cross-instance event bus delivers the change topic. Default 60 s;
   * `0` disables expiry (single-instance deployments only).
   */
  ttlMs?: number;
  /** Maximum cached entries; the oldest is evicted first. Default 1024. */
  maxEntries?: number;
}

/** Injection token for {@link ConfigCacheOptions}. */
export const CONFIG_CACHE_OPTIONS = 'CONFIG_CACHE_OPTIONS';

/** Unambiguous composite key: a separator that cannot appear in ordinary scope or key names. */
export function configCacheKey(...parts: string[]): string {
  return parts.join('\u0000');
}

/** Bounded insertion-ordered cache with optional TTL. */
export class BoundedTtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: ConfigCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 1024);
  }

  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== 0 && Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  get(key: string): unknown {
    return this.has(key) ? this.entries.get(key)!.value : undefined;
  }

  set(key: string, value: unknown): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0 });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (predicate(key)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Optional TopicEventBus shape; `subscribe` is used for cross-instance cache eviction. */
export interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe?(pattern: string, handler: (message: { payload?: unknown }) => unknown): unknown;
}

/** True when an update failed only because the row does not exist yet. */
export function isRecordNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 'P2025' || (typeof message === 'string' && /not found|does not exist|No record/i.test(message));
}

export function unsubscribeQuietly(handle: unknown): void {
  try {
    if (typeof handle === 'function') (handle as () => void)();
    else if (handle && typeof (handle as { unsubscribe?: unknown }).unsubscribe === 'function') {
      (handle as { unsubscribe: () => void }).unsubscribe();
    }
  } catch {
    // shutdown only
  }
}
