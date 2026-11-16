import type { ICache } from './cache.interface';
import { assertSequenceArguments, assertSequenceValue } from './sequence';

/** Minimal Redis client interface (compatible with ioredis) */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  getdel?(key: string): Promise<string | null>;
  pttl?(key: string): Promise<number>;
  eval?(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const ADVANCE_SEQUENCE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local current = 0
if raw then
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'number' or value < 0 or value > 9007199254740991 or value ~= math.floor(value) then
    return redis.error_reply('Invalid cache sequence')
  end
  current = value
end
if current >= 9007199254740991 then return redis.error_reply('Cache sequence overflow') end
local next = math.max(tonumber(ARGV[1]), current + 1)
local encoded = string.format('%.0f', next)
local ttl = tonumber(ARGV[2])
local previousTtl = redis.call('PTTL', KEYS[1])
if previousTtl == -1 then
  redis.call('SET', KEYS[1], encoded)
else
  redis.call('SET', KEYS[1], encoded, 'PX', math.max(ttl, previousTtl))
end
return encoded`;

export class RedisCache<T = unknown> implements ICache<T> {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisClient,
    options?: { prefix?: string },
  ) {
    this.prefix = options?.prefix ?? 'zucker:cache:';
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined && ttlMs !== null && !(ttlMs > 0)) {
      // A non-positive TTL expires the entry immediately; it must not create an immortal key.
      await this.redis.del(this.key(key));
      return;
    }
    const serialized = JSON.stringify(value);
    if (ttlMs) {
      await this.redis.set(this.key(key), serialized, 'PX', Math.ceil(ttlMs));
    } else {
      await this.redis.set(this.key(key), serialized);
    }
  }

  async remainingTtlMs(key: string): Promise<number | null | undefined> {
    if (!this.redis.pttl) return null;
    const ttl = await this.redis.pttl(this.key(key));
    if (ttl === -2) return undefined;
    return ttl < 0 ? null : ttl;
  }

  async readSequence(key: string): Promise<number | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    assertSequenceValue(value);
    return value;
  }

  async advanceSequence(key: string, minimum: number, ttlMs: number): Promise<number> {
    assertSequenceArguments(minimum, ttlMs);
    if (!this.redis.eval) throw new Error('Redis cache sequences require atomic EVAL support');
    const reply = await this.redis.eval(ADVANCE_SEQUENCE_SCRIPT, 1, this.key(key), minimum, ttlMs);
    // Return a bulk decimal string from Lua: some RESP integer parsers round
    // MAX_SAFE_INTEGER up before JavaScript can validate the returned number.
    const result: unknown = typeof reply === 'string' && /^(?:0|[1-9]\d*)$/.test(reply)
      ? Number(reply) : reply;
    assertSequenceValue(result);
    return result;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(this.key(key))) === 1;
  }

  async clear(): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  async getOrDefault(key: string, defaultValue: T): Promise<T> {
    const val = await this.get(key);
    return val !== undefined ? val : defaultValue;
  }

  async getAndRemove(key: string): Promise<T | undefined> {
    if (this.redis.getdel) {
      const raw = await this.redis.getdel(this.key(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    }
    // Fallback for Redis < 6.2: non-atomic but best effort
    const val = await this.get(key);
    if (val !== undefined) {
      await this.del(key);
    }
    return val;
  }

  async keys(): Promise<string[]> {
    const result: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      for (const k of keys) {
        result.push(k.substring(this.prefix.length));
      }
    } while (cursor !== '0');
    return result;
  }

  async getAll(...keys: string[]): Promise<T[]> {
    if (!keys || keys.length === 0) {
      const allKeys = await this.keys();
      const result: T[] = [];
      for (const k of allKeys) {
        const val = await this.get(k);
        if (val !== undefined) result.push(val);
      }
      return result;
    }
    const result: T[] = [];
    for (const k of keys) {
      const val = await this.get(k);
      if (val !== undefined) result.push(val);
    }
    return result;
  }

  async evictAll(keys: Iterable<string>): Promise<void> {
    const keysArray = Array.from(keys).map(k => this.key(k));
    if (keysArray.length > 0) {
      await this.redis.del(...keysArray);
    }
  }
}
