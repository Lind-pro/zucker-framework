/**
 * 数据迁移框架 — 对标 Claude Code migrations/ 目录的幂等迁移模式
 *
 * 每个迁移是一个自包含的函数，自行判断是否需要执行。
 * 不依赖全局注册表或执行顺序——迁移的幂等性由 condition 保证。
 *
 * 用法:
 * ```ts
 * const migrations: MigrationDefinition[] = [
 *   {
 *     id: '20240401_unify_permissions',
 *     description: '迁移旧版权限格式',
 *     condition: async (db) => {
 *       const count = await db.model('permissions').count({ where: { version: null } });
 *       return count > 0;
 *     },
 *     execute: async (db) => {
 *       await db.model('permissions').updateMany({ where: { version: null }, data: { version: 2 } });
 *     },
 *   },
 * ];
 *
 * const runner = new MigrationRunner(db);
 * const results = await runner.run(migrations);
 * ```
 */

import type { DatabaseAdapter } from './database-adapter';

export interface MigrationDefinition {
  /** 唯一标识（建议格式: YYYYMMDD_描述） */
  id: string;
  /** 人类可读的描述 */
  description: string;
  /** 判断是否需要执行。返回 true 则执行 execute */
  condition: (db: DatabaseAdapter) => Promise<boolean>;
  /** 执行迁移逻辑 */
  execute: (db: DatabaseAdapter) => Promise<void>;
}

export type MigrationStatus = 'skipped' | 'executed' | 'failed';

export interface MigrationResult {
  id: string;
  status: MigrationStatus;
  durationMs: number;
  error?: string;
}

export class MigrationRunner {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 执行所有迁移
   * 每个迁移独立评估 condition，互不影响
   */
  async run(migrations: MigrationDefinition[]): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];

    for (const migration of migrations) {
      const start = Date.now();
      try {
        const shouldRun = await migration.condition(this.db);

        if (!shouldRun) {
          results.push({
            id: migration.id,
            status: 'skipped',
            durationMs: Date.now() - start,
          });
          continue;
        }

        await migration.execute(this.db);
        results.push({
          id: migration.id,
          status: 'executed',
          durationMs: Date.now() - start,
        });
      } catch (error) {
        results.push({
          id: migration.id,
          status: 'failed',
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * 仅检查哪些迁移需要执行（dry run）
   */
  async check(migrations: MigrationDefinition[]): Promise<{ id: string; description: string; needsRun: boolean }[]> {
    const results: { id: string; description: string; needsRun: boolean }[] = [];

    for (const migration of migrations) {
      try {
        const needsRun = await migration.condition(this.db);
        results.push({ id: migration.id, description: migration.description, needsRun });
      } catch {
        results.push({ id: migration.id, description: migration.description, needsRun: false });
      }
    }

    return results;
  }
}
