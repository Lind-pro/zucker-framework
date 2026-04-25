import type { ICache } from '../cache.interface';

const CACHE_METADATA = Symbol('CACHE_METADATA');

/**
 * 解析缓存 key 模板，将 #0, #1 替换为对应参数值
 *
 * @example resolveCacheKey('user:#0', ['42']) => 'user:42'
 */
function resolveCacheKey(template: string, args: unknown[]): string {
  return template.replace(/#(\d+)/g, (_, index) => {
    const idx = parseInt(index, 10);
    return idx < args.length ? String(args[idx]) : '';
  });
}

/**
 * 稳定序列化：对象按 key 排序后 stringify，保证相同内容生成相同 key。
 * 避免 {a:1,b:2} 和 {b:2,a:1} 生成不同缓存 key 的问题。
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map(k => `${k}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',') + '}';
}

/** 获取实例上挂载的 __cacheService__（由 @InjectCache 配合 CacheModule 注入） */
function getCacheService(instance: unknown): ICache | undefined {
  return (instance as Record<string, unknown>).__cacheService__ as ICache | undefined;
}

/**
 * @Cacheable — 方法结果自动缓存
 * 对标 Spring @Cacheable
 *
 * - 先查缓存，命中则直接返回
 * - 未命中则执行原方法，并将结果写入缓存
 *
 * @param cacheName 缓存名称（用作 key 前缀）
 * @param options.key 自定义 key 模板，支持 #0, #1 引用参数
 * @param options.ttl 过期时间（毫秒）
 */
export function Cacheable(
  cacheName: string,
  options?: { key?: string; ttl?: number },
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const cache = getCacheService(this);
      if (!cache) return originalMethod.apply(this, args);

      const cacheKey = options?.key
        ? resolveCacheKey(options.key, args)
        : `${cacheName}:${propertyKey.toString()}:${args.map(stableStringify).join(':')}`;

      const cached = await cache.get(cacheKey);
      if (cached !== undefined && cached !== null) return cached;

      const result = await originalMethod.apply(this, args);
      if (result !== undefined && result !== null) {
        await cache.set(cacheKey, result, options?.ttl);
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * @CacheEvict — 清除缓存
 * 对标 Spring @CacheEvict
 *
 * - 先执行原方法，然后删除对应缓存
 * - allEntries=true 时通过 keys() 列出并批量删除同前缀的 key
 *
 * @param cacheName 缓存名称
 * @param options.key 自定义 key 模板
 * @param options.allEntries 是否清除该 cacheName 下所有条目
 */
export function CacheEvict(
  cacheName: string,
  options?: { key?: string; allEntries?: boolean },
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const result = await originalMethod.apply(this, args);
      const cache = getCacheService(this);
      if (cache) {
        if (options?.allEntries) {
          // 若缓存实现支持 keys()，则按前缀过滤删除；否则 clear() 全清
          if (typeof cache.keys === 'function') {
            const allKeys = await cache.keys();
            const prefix = `${cacheName}:`;
            const toDelete = allKeys.filter((k) => k.startsWith(prefix));
            if (cache.evictAll) {
              await cache.evictAll(toDelete);
            } else {
              await Promise.all(toDelete.map((k) => cache.del(k)));
            }
          } else {
            await cache.clear();
          }
        } else {
          const cacheKey = options?.key
            ? resolveCacheKey(options.key, args)
            : `${cacheName}:${propertyKey.toString()}:${args.map(stableStringify).join(':')}`;
          await cache.del(cacheKey);
        }
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * @CachePut — 执行方法并更新缓存（不查缓存，始终执行）
 * 对标 Spring @CachePut
 *
 * @param cacheName 缓存名称
 * @param options.key 自定义 key 模板
 * @param options.ttl 过期时间（毫秒）
 */
export function CachePut(
  cacheName: string,
  options?: { key?: string; ttl?: number },
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const result = await originalMethod.apply(this, args);
      const cache = getCacheService(this);
      if (cache && result !== undefined) {
        const cacheKey = options?.key
          ? resolveCacheKey(options.key, args)
          : `${cacheName}:${propertyKey.toString()}:${args.map(stableStringify).join(':')}`;
        await cache.set(cacheKey, result, options?.ttl);
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * @InjectCache — 类装饰器，标记此类需要注入缓存服务
 *
 * 配合 CacheModule 的 OnModuleInit 钩子，在实例化时将 CACHE_PROVIDER
 * 注入到实例的 __cacheService__ 属性上，供 @Cacheable/@CacheEvict/@CachePut 使用。
 */
export function InjectCache(): ClassDecorator {
  return (target: Function) => {
    (target as unknown as Record<symbol, boolean>)[CACHE_METADATA] = true;
  };
}

export { CACHE_METADATA };
