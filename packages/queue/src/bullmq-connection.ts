import type { ConnectionOptions } from 'bullmq';

export interface BullMqConnectionFromUrlOptions {
  role?: 'producer' | 'worker';
}

/** Converts a redis:// or rediss:// URL into BullMQ/ioredis connection options. */
export function bullMqConnectionFromUrl(
  redisUrl: string,
  options: BullMqConnectionFromUrlOptions = {},
): ConnectionOptions {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new TypeError('BullMQ connection URL must use redis:// or rediss://');
  }

  const databasePath = parsed.pathname.replace(/^\//, '');
  const database = databasePath === '' ? 0 : Number(databasePath);
  if (!Number.isInteger(database) || database < 0) {
    throw new TypeError('BullMQ Redis database must be a non-negative integer');
  }

  return {
    // WHATWG URL keeps IPv6 literals bracketed ("[::1]"); ioredis expects the bare address.
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: database,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: options.role === 'worker' ? null : 1,
  };
}
