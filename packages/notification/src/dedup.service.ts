import { Injectable, Logger } from '@nestjs/common';

/**
 * 通知去重服务。
 *
 * 基于 (channel + recipient + contentHash) 在指定时间窗口内去重。
 */
export interface NotificationDedup {
  /** 检查是否重复消息 */
  isDuplicate(key: string): boolean;
  /** 标记消息已发送 */
  markSent(key: string): void;
  /** 清理过期记录 */
  cleanup(): void;
}

@Injectable()
export class InMemoryNotificationDedup implements NotificationDedup {
  private readonly logger = new Logger(InMemoryNotificationDedup.name);
  private readonly sent = new Map<string, number>();
  private readonly windowMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(windowMs = 300_000) {
    // 默认5分钟去重窗口
    this.windowMs = windowMs;
    // 自动清理：每个窗口周期清理一次过期记录
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** 停止自动清理定时器（用于模块销毁时） */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  isDuplicate(key: string): boolean {
    const sentAt = this.sent.get(key);
    if (sentAt === undefined) return false;
    return Date.now() - sentAt < this.windowMs;
  }

  markSent(key: string): void {
    this.sent.set(key, Date.now());
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, sentAt] of this.sent) {
      if (now - sentAt >= this.windowMs) {
        this.sent.delete(key);
      }
    }
  }

  get size(): number {
    this.cleanup();
    return this.sent.size;
  }

  /**
   * 生成去重 key
   * @param channel 通知渠道
   * @param recipient 接收者
   * @param contentHash 内容哈希（可用简单的字符串拼接）
   */
  static buildKey(channel: string, recipient: string, contentHash: string): string {
    return `${channel}:${recipient}:${contentHash}`;
  }
}

/**
 * 通知优先级枚举。
 */
export enum NotificationPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  URGENT = 3,
}

/**
 * 按优先级排序的通知队列。
 */
export class PriorityNotificationQueue<T extends { priority?: NotificationPriority }> {
  private readonly items: T[] = [];

  enqueue(item: T): void {
    const priority = item.priority ?? NotificationPriority.NORMAL;
    // 插入到正确的优先级位置（高优先级在前）
    const index = this.items.findIndex(
      (existing) => (existing.priority ?? NotificationPriority.NORMAL) < priority,
    );
    if (index === -1) {
      this.items.push(item);
    } else {
      this.items.splice(index, 0, item);
    }
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items.length = 0;
  }
}
