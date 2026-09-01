import { Injectable, Logger } from '@nestjs/common';

export interface OrphanChecker {
  /** 数据类型 */
  type: string;
  /** 检查指定 ID 是否存在 */
  exists(id: string): Promise<boolean>;
  /** 删除指定 ID 的记录 */
  delete(id: string): Promise<void>;
}

/**
 * 孤儿记录清理服务
 */
@Injectable()
export class OrphanCleanupService {
  private readonly logger = new Logger(OrphanCleanupService.name);
  private checkers = new Map<string, OrphanChecker>();

  registerChecker(checker: OrphanChecker): void {
    this.checkers.set(checker.type, checker);
  }

  unregisterChecker(type: string): void {
    this.checkers.delete(type);
  }

  /**
   * 检查引用的目标是否存在，返回孤儿引用列表
   */
  async findOrphans(
    referenceType: string,
    references: Array<{ id: string; targetType: string; targetId: string }>,
  ): Promise<Array<{ id: string; targetType: string; targetId: string }>> {
    const orphans: Array<{ id: string; targetType: string; targetId: string }> = [];

    for (const ref of references) {
      const checker = this.checkers.get(ref.targetType);
      if (!checker) continue;

      const exists = await checker.exists(ref.targetId);
      if (!exists) {
        orphans.push(ref);
      }
    }

    return orphans;
  }

  /**
   * 清理孤儿引用
   */
  async cleanup(
    referenceType: string,
    references: Array<{ id: string; targetType: string; targetId: string }>,
    onCleanup?: (ref: { id: string; targetType: string; targetId: string }) => Promise<void>,
  ): Promise<number> {
    const orphans = await this.findOrphans(referenceType, references);

    for (const orphan of orphans) {
      if (onCleanup) {
        await onCleanup(orphan);
      }
      this.logger.log(`Orphan reference cleaned: ${referenceType}/${orphan.id} -> ${orphan.targetType}/${orphan.targetId}`);
    }

    return orphans.length;
  }
}
