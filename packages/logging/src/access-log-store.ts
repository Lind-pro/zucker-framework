import { Injectable } from '@nestjs/common';

/**
 * 访问日志持久化存储接口。
 * 将访问日志写入数据库而非仅内存。
 *
 * 默认实现为内存存储（ring buffer），生产环境可替换为数据库实现。
 */
export interface AccessLogStore {
  /** 写入一条访问日志 */
  save(log: AccessLogRecord): Promise<void>;
  /** 分页查询访问日志 */
  query(options: AccessLogQuery): Promise<{ data: AccessLogRecord[]; total: number }>;
  /** 按条件统计 */
  count(filter?: Record<string, unknown>): Promise<number>;
}

export interface AccessLogRecord {
  id?: string;
  userId?: string;
  username?: string;
  ip?: string;
  method: string;
  url: string;
  module?: string;
  action?: string;
  httpMethod: string;
  statusCode: number;
  duration: number;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  createdAt: Date;
}

export interface AccessLogQuery {
  page?: number;
  pageSize?: number;
  userId?: string;
  module?: string;
  method?: string;
  httpMethod?: string;
  startTime?: Date;
  endTime?: Date;
  statusCode?: number;
}

export const ACCESS_LOG_STORE = 'ACCESS_LOG_STORE';

/** 默认内存实现 — ring buffer */
@Injectable()
export class InMemoryAccessLogStore implements AccessLogStore {
  private readonly logs: AccessLogRecord[] = [];
  private static readonly MAX_SIZE = 10000;

  async save(log: AccessLogRecord): Promise<void> {
    if (this.logs.length >= InMemoryAccessLogStore.MAX_SIZE) {
      this.logs.shift();
    }
    this.logs.push({ ...log, id: log.id ?? `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: log.createdAt ?? new Date() });
  }

  async query(options: AccessLogQuery): Promise<{ data: AccessLogRecord[]; total: number }> {
    let filtered = this.logs;

    if (options.userId) filtered = filtered.filter(l => l.userId === options.userId);
    if (options.module) filtered = filtered.filter(l => l.module === options.module);
    if (options.method) filtered = filtered.filter(l => l.method === options.method);
    if (options.httpMethod) filtered = filtered.filter(l => l.httpMethod === options.httpMethod);
    if (options.statusCode) filtered = filtered.filter(l => l.statusCode === options.statusCode);
    if (options.startTime) filtered = filtered.filter(l => l.createdAt >= options.startTime!);
    if (options.endTime) filtered = filtered.filter(l => l.createdAt <= options.endTime!);

    // 按时间倒序
    filtered = [...filtered].reverse();
    const total = filtered.length;
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    return { data, total };
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    if (!filter) return this.logs.length;
    return (await this.query({ ...filter } as AccessLogQuery)).total;
  }
}
