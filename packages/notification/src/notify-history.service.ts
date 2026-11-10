import { Injectable, Logger } from '@nestjs/common';
import type { NotifyChannel, NotifyResult, NotifyMessage } from './notifier.interface';

/**
 * Notification history record — tracks each send attempt.
 */
export interface NotifyHistoryRecord {
  /** Unique record ID */
  id: string;
  /** Channel used */
  channel: NotifyChannel;
  /** Template ID if used */
  templateId?: string;
  /** Recipient */
  to: string;
  /** Subject/title */
  subject?: string;
  /** Whether delivery succeeded */
  success: boolean;
  /** Provider message ID */
  messageId?: string;
  /** Error message on failure */
  error?: string;
  /** Timestamp of the attempt */
  timestamp: Date;
  /** Notifier config ID used */
  configId?: string;
  /** Provider name */
  provider?: string;
  /** Number of retry attempts */
  retryCount: number;
}

/**
 * Notification history persistence interface.
 *
 * Applications implement this to store notification delivery history
 * in their database for auditing and tracking.
 */
export interface NotifyHistoryFilter {
  channel?: NotifyChannel;
  to?: string;
  success?: boolean;
  startTime?: Date;
  endTime?: Date;
}

export interface NotifyHistoryStore {
  save(record: NotifyHistoryRecord): Promise<void>;
  query(filter: {
    channel?: NotifyChannel;
    to?: string;
    success?: boolean;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
    offset?: number;
  }): Promise<NotifyHistoryRecord[]>;
  count(filter: {
    channel?: NotifyChannel;
    success?: boolean;
    startTime?: Date;
    endTime?: Date;
  }): Promise<number>;
}

/**
 * In-memory notification history service.
 *
 * Provides delivery tracking for notifications. Records each send attempt
 * with success/failure status for auditing. In production, applications
 * should provide a persistent NotifyHistoryStore implementation.
 */
@Injectable()
export class NotifyHistoryService {
  private readonly logger = new Logger(NotifyHistoryService.name);
  private readonly records: NotifyHistoryRecord[] = [];
  private readonly maxRecords = 10000;
  private idCounter = 0;

  /**
   * Record a notification delivery attempt.
   */
  record(
    message: NotifyMessage,
    result: NotifyResult,
    meta?: { configId?: string; provider?: string; retryCount?: number },
  ): void {
    const record: NotifyHistoryRecord = {
      id: String(++this.idCounter),
      channel: result.channel,
      templateId: message.templateId,
      to: result.to,
      subject: message.subject,
      success: result.success,
      messageId: result.messageId,
      error: result.error,
      timestamp: result.timestamp,
      configId: meta?.configId,
      provider: meta?.provider,
      retryCount: meta?.retryCount ?? 0,
    };

    this.records.push(record);

    // Evict oldest records if over limit
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }

    if (!result.success) {
      this.logger.warn(
        `Notification delivery failed: channel=${record.channel}, retryCount=${record.retryCount}`,
      );
    }
  }

  /**
   * Query notification history with optional filters (newest first, default limit 100).
   */
  query(filter: NotifyHistoryFilter & { limit?: number; offset?: number }): NotifyHistoryRecord[] {
    const results = this.matching(filter);

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  /** Number of records matching the filter (no paging limit). */
  count(filter: NotifyHistoryFilter): number {
    return this.matching(filter).length;
  }

  private matching(filter: NotifyHistoryFilter): NotifyHistoryRecord[] {
    return this.records.filter((r) => {
      if (filter.channel && r.channel !== filter.channel) return false;
      if (filter.to && r.to !== filter.to) return false;
      if (filter.success !== undefined && r.success !== filter.success) return false;
      if (filter.startTime && r.timestamp < filter.startTime) return false;
      if (filter.endTime && r.timestamp > filter.endTime) return false;
      return true;
    });
  }

  /**
   * Get delivery statistics.
   */
  getStats(filter?: {
    channel?: NotifyChannel;
    startTime?: Date;
    endTime?: Date;
  }): { total: number; success: number; failed: number } {
    const filtered = this.records.filter((r) => {
      if (filter?.channel && r.channel !== filter.channel) return false;
      if (filter?.startTime && r.timestamp < filter.startTime) return false;
      if (filter?.endTime && r.timestamp > filter.endTime) return false;
      return true;
    });

    return {
      total: filtered.length,
      success: filtered.filter((r) => r.success).length,
      failed: filtered.filter((r) => !r.success).length,
    };
  }
}
