export type { ICache, ICacheManager } from './cache.interface';

export interface CacheOptions {
  ttl: number;
  prefix: string;
}

export enum CacheProvider {
  MEMORY = 'MEMORY',
  REDIS = 'REDIS',
  HYBRID = 'HYBRID',
}

export { MemoryCache } from './memory-cache';
export { MemoryCacheManager } from './memory-cache-manager';
export { RedisCache } from './redis-cache';
export type { RedisClient } from './redis-cache';
export { HybridCache } from './hybrid-cache';
export { ZuckerCacheModule, CACHE_PROVIDER } from './cache.module';
export type { CacheModuleOptions, CacheModuleAsyncOptions, CacheModuleOptionsFactory } from './cache.module';
export { Cacheable, CacheEvict, CachePut, InjectCache, CACHE_METADATA } from './decorators/cache.decorators';

export { CacheWarmer, CacheStatsCollector } from './cache-warmer';
export type { CacheWarmerTask, CacheStats } from './cache-warmer';

export { TaggedCache } from './tagged-cache';
