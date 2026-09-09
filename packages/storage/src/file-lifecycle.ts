import { Injectable, Logger } from '@nestjs/common';

/**
 * 文件生命周期管理器。
 *
 * 支持文件过期自动清理、临时文件管理、存储配额检查。
 */
export interface FileLifecyclePolicy {
  /** 文件最大保留时间（毫秒），0 表示永久 */
  maxAge?: number;
  /** 文件最大数量，超出后按 FIFO 清理 */
  maxCount?: number;
  /** 文件最大总大小（字节），超出后按 FIFO 清理 */
  maxTotalSize?: number;
  /** 文件路径前缀匹配（用于作用域限定） */
  pathPrefix?: string;
}

export interface FileMetadata {
  key: string;
  size: number;
  createdAt: number;
  lastAccessedAt?: number;
  contentType?: string;
  tags?: Record<string, string>;
}

export interface LifecycleResult {
  deletedCount: number;
  freedBytes: number;
  reason: 'expired' | 'count_exceeded' | 'size_exceeded';
}

@Injectable()
export class FileLifecycleManager {
  private readonly logger = new Logger(FileLifecycleManager.name);
  private readonly policies: FileLifecyclePolicy[] = [];

  /** 注册一个生命周期策略 */
  registerPolicy(policy: FileLifecyclePolicy): void {
    this.policies.push(policy);
    this.logger.log(`File lifecycle policy registered: prefix=${policy.pathPrefix ?? '*'}, maxAge=${policy.maxAge ?? 'none'}`);
  }

  /** 获取所有已注册策略 */
  getPolicies(): FileLifecyclePolicy[] {
    return [...this.policies];
  }

  /**
   * 评估文件列表，返回需要清理的文件 keys。
   * 调用方负责实际删除操作。
   */
  evaluate(files: FileMetadata[], policy?: FileLifecyclePolicy): string[] {
    const toDelete: string[] = [];
    const activePolicies = policy ? [policy] : this.policies;
    const now = Date.now();

    for (const p of activePolicies) {
      let scopedFiles = files;
      if (p.pathPrefix) {
        scopedFiles = files.filter(f => f.key.startsWith(p.pathPrefix!));
      }

      // 按创建时间排序（旧的在前）
      const sorted = [...scopedFiles].sort((a, b) => a.createdAt - b.createdAt);

      // 过期清理
      if (p.maxAge && p.maxAge > 0) {
        for (const f of sorted) {
          if (now - f.createdAt > p.maxAge) {
            toDelete.push(f.key);
          }
        }
      }

      // 数量超限清理
      if (p.maxCount && p.maxCount > 0) {
        const remaining = sorted.filter(f => !toDelete.includes(f.key));
        if (remaining.length > p.maxCount) {
          const excess = remaining.slice(0, remaining.length - p.maxCount);
          for (const f of excess) {
            toDelete.push(f.key);
          }
        }
      }

      // 大小超限清理
      if (p.maxTotalSize && p.maxTotalSize > 0) {
        const remaining = sorted.filter(f => !toDelete.includes(f.key));
        let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);
        for (const f of remaining) {
          if (totalSize <= p.maxTotalSize) break;
          toDelete.push(f.key);
          totalSize -= f.size;
        }
      }
    }

    return [...new Set(toDelete)];
  }
}
