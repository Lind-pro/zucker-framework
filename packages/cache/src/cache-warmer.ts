import { Injectable, Logger } from '@nestjs/common';
import type { ICache } from './cache.interface';

/**
 * 缓存预热器 — 系统启动时预加载热点数据。
 * 对标 hsweb CacheManager 的预热能力。
 */
export interface CacheWarmerTask {
  name: string;
  /** 预热执行函数，返回 key-value 对 */
  load(): Promise<Array<{ key: string; value: unknown; ttl?: number }>>;
  /** 执行优先级（数字越大越先执行） */
  priority?: number;
}

@Injectable()
export class CacheWarmer {
  private readonly logger = new Logger(CacheWarmer.name);
  private readonly tasks: CacheWarmerTask[] = [];

  /** 注册预热任务 */
  register(task: CacheWarmerTask): void {
    this.tasks.push(task);
    this.tasks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** 执行所有预热任务 */
  async warmUp(cache: ICache): Promise<{ total: number; loaded: number; failed: number }> {
    let loaded = 0;
    let failed = 0;

    for (const task of this.tasks) {
      try {
        const entries = await task.load();
        for (const entry of entries) {
          await cache.set(entry.key, entry.value, entry.ttl);
          loaded++;
        }
        this.logger.log(`Cache warmed: ${task.name} (${entries.length} entries)`);
      } catch (err) {
        failed++;
        this.logger.error(`Cache warm failed: ${task.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { total: this.tasks.length, loaded, failed };
  }
}

/**
 * 缓存统计信息。
 */
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  /** 命中率 (0-1) */
  hitRate: number;
  size: number;
}

/**
 * 带统计的缓存包装器。
 */
@Injectable()
export class CacheStatsCollector {
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private evictions = 0;

  recordHit(): void { this.hits++; }
  recordMiss(): void { this.misses++; }
  recordSet(): void { this.sets++; }
  recordDelete(): void { this.deletes++; }
  recordEviction(): void { this.evictions++; }

  getStats(cacheSize = 0): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
      size: cacheSize,
    };
  }

  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.evictions = 0;
  }
}
