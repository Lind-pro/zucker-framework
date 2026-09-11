import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DATABASE_ADAPTER,
  type DatabaseAdapter,
  type ModelOperations,
} from '@zucker-framework/core';
import { LogSanitizer } from './log-sanitizer';

export type OperationLogStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface AccessLogData {
  action: string;
  describe?: string;
  module?: string;
  userId?: string;
  username?: string;
  requestUrl?: string;
  method?: string;
  ip?: string;
  userAgent?: string;
  requestTime?: Date;
  responseTime?: number;
  parameters?: Record<string, unknown>;
  result?: unknown;
  exception?: string;
}

export interface LogOperationData {
  module: string;
  action: string;
  userId?: string;
  targetId?: string;
  targetType?: string;
  method?: string;
  path?: string;
  ipAddress?: string;
  userAgent?: string;
  status?: OperationLogStatus;
  duration?: number;
  errorMessage?: string;
  requestData?: unknown;
  responseData?: unknown;
  metadata?: unknown;
}

export type StoredAccessLog = AccessLogData & { id: string; requestTime: Date };
export type StoredOperationLog = LogOperationData & {
  id: string;
  createdAt: Date;
  status: OperationLogStatus;
};
export interface LogQuery {
  module?: string;
  action?: string;
  userId?: string;
  ip?: string;
  method?: string;
  status?: OperationLogStatus;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
}
export interface PersistentLogOptions {
  accessModel?: string;
  operationModel?: string;
}
export const PERSISTENT_LOG_OPTIONS = Symbol('PERSISTENT_LOG_OPTIONS');

type LogRecord = { id: string };
type ActionCount = { action: string; _count: { _all: number } };
const emptyMetrics = () => ({
  totalLogs: 0,
  successCount: 0,
  failureCount: 0,
  totalDuration: 0,
  maxDuration: 0,
  minDuration: Number.MAX_SAFE_INTEGER,
});

/** Shared operations for the two supported audit records, executed by the supplied database adapter. */
abstract class PersistentLogService<T extends LogRecord> {
  protected readonly logger: Logger;
  protected readonly model: ModelOperations<T>;
  protected readonly sanitizer: LogSanitizer;
  private metrics = emptyMetrics();

  protected constructor(
    db: DatabaseAdapter,
    modelName: string,
    private readonly timeField: 'requestTime' | 'createdAt',
    private readonly filters: readonly string[],
    sanitizer?: LogSanitizer,
  ) {
    this.model = db.model(modelName) as ModelOperations<T>;
    this.sanitizer = sanitizer ?? new LogSanitizer();
    this.logger = new Logger(this.constructor.name);
  }

  protected async write(buildData: () => Record<string, unknown>): Promise<void> {
    const startedAt = Date.now();
    let success = false;
    try {
      await this.model.create({ data: buildData() });
      success = true;
    } catch (error) {
      // Best-effort telemetry must never replace the business result or reveal DB credentials.
      this.logger.error(
        `Log persistence failed: ${this.sanitizer.sanitizeText(error instanceof Error ? error.message : error)}`,
      );
    } finally {
      const duration = Date.now() - startedAt;
      this.metrics.totalLogs++;
      if (success) this.metrics.successCount++;
      else this.metrics.failureCount++;
      this.metrics.totalDuration += duration;
      this.metrics.maxDuration = Math.max(this.metrics.maxDuration, duration);
      this.metrics.minDuration = Math.min(this.metrics.minDuration, duration);
    }
  }

  protected where(params: LogQuery): Record<string, unknown> {
    const source = params as unknown as Record<string, unknown>;
    const where: Record<string, unknown> = {};
    for (const field of this.filters) if (source[field]) where[field] = source[field];
    if (params.startDate || params.endDate) {
      where[this.timeField] = {
        ...(params.startDate ? { gte: params.startDate } : {}),
        ...(params.endDate ? { lte: params.endDate } : {}),
      };
    }
    return where;
  }

  async findAll(params: LogQuery) {
    const page = params.page || 1;
    const pageSize = Math.min(params.pageSize || 20, 100);
    const where = this.where(params);
    const [data, total] = await Promise.all([
      this.model.findMany({
        where,
        orderBy: { [this.timeField]: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.model.count({ where }),
    ]);
    return { data, total, page, pageSize };
  }

  findOne(id: string) {
    return this.model.findUnique({ where: { id } });
  }

  async batchDelete(ids: string[]) {
    if (!ids?.length) throw new Error('删除列表不能为空');
    if (ids.length > 1000) throw new Error('单次删除数量不能超过 1000 条');
    const result = await this.model.deleteMany({ where: { id: { in: ids } } });
    return { success: true, requested: ids.length, deletedCount: result.count };
  }

  async cleanOldLogs(daysToKeep = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const result = await this.model.deleteMany({ where: { [this.timeField]: { lt: cutoffDate } } });
    return { success: true, deletedCount: result.count, cutoffDate: cutoffDate.toISOString() };
  }

  protected async actionStatistics(module: string) {
    if (!this.model.groupBy) throw new Error('Log storage requires database groupBy support');
    const rows = (await this.model.groupBy({
      by: ['action'],
      where: { module },
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
    })) as ActionCount[];
    return rows.map((row) => ({ action: row.action, count: row._count._all }));
  }

  protected async average(module: string, field: string) {
    if (!this.model.aggregate) throw new Error('Log storage requires database aggregate support');
    const result = await this.model.aggregate({ where: { module }, _avg: { [field]: true } });
    return Math.round((result._avg as Record<string, number | null>)[field] || 0);
  }

  protected async csv(params: LogQuery & { limit?: number }, columns: Array<[keyof T, string]>) {
    const logs = await this.model.findMany({
      where: this.where(params),
      orderBy: { [this.timeField]: 'desc' },
      take: params.limit || 10000,
    });
    const field = (value: unknown) => {
      if (value === null || value === undefined) return '';
      let text = value instanceof Date ? value.toISOString() : String(value);
      // CSV downloads can contain user-controlled text; prevent spreadsheet formula execution.
      if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
      columns.map(([, label]) => field(label)).join(','),
      ...logs.map((log) => columns.map(([key]) => field(log[key])).join(',')),
    ].join('\n');
  }

  getMetrics() {
    const m = this.metrics;
    return {
      totalLogs: m.totalLogs,
      successCount: m.successCount,
      failureCount: m.failureCount,
      successRate: m.totalLogs ? ((m.successCount / m.totalLogs) * 100).toFixed(2) + '%' : '0%',
      avgDuration: m.totalLogs ? Math.round(m.totalDuration / m.totalLogs) : 0,
      maxDuration: m.maxDuration,
      minDuration: m.minDuration === Number.MAX_SAFE_INTEGER ? 0 : m.minDuration,
    };
  }
  resetMetrics() {
    this.metrics = emptyMetrics();
  }
}

@Injectable()
export class AccessLogService extends PersistentLogService<StoredAccessLog> {
  private readonly operationModel: string;
  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() sanitizer?: LogSanitizer,
    @Optional() @Inject(PERSISTENT_LOG_OPTIONS) options: PersistentLogOptions = {},
  ) {
    super(
      db,
      options.accessModel ?? 'accessLogs',
      'requestTime',
      ['module', 'action', 'userId', 'ip', 'method'],
      sanitizer,
    );
    this.operationModel = options.operationModel ?? 'operationLogs';
  }

  async log(input: AccessLogData): Promise<void> {
    await this.write(() => ({
      action: input.action,
      describe: input.describe,
      module: input.module,
      userId: input.userId,
      username: input.username ? this.sanitizer.sanitizeText(input.username) : input.username,
      requestUrl: input.requestUrl
        ? this.sanitizer.sanitizeText(input.requestUrl).slice(0, 500)
        : input.requestUrl,
      method: input.method,
      ip: input.ip,
      userAgent: input.userAgent
        ? this.sanitizer.sanitizeText(input.userAgent).slice(0, 500)
        : input.userAgent,
      requestTime: input.requestTime || new Date(),
      responseTime: input.responseTime,
      parameters: this.sanitizer.sanitizeValue(input.parameters),
      result: this.sanitizer.sanitizeValue(input.result),
      exception:
        input.exception == null
          ? input.exception
          : this.sanitizer.sanitizeText(input.exception).slice(0, 2000),
    }));
  }

  async getIpTimeline(ip: string, days = 7) {
    const since = new Date(Date.now() - days * 86400000);
    const [accessLogs, operationLogs] = await Promise.all([
      this.model.findMany({
        where: { ip, requestTime: { gte: since } },
        orderBy: { requestTime: 'desc' },
        take: 200,
        select: {
          id: true,
          action: true,
          describe: true,
          module: true,
          userId: true,
          username: true,
          requestUrl: true,
          method: true,
          ip: true,
          userAgent: true,
          requestTime: true,
          responseTime: true,
          parameters: true,
          exception: true,
        },
      }),
      (this.db.model(this.operationModel) as ModelOperations<StoredOperationLog>).findMany({
        where: { ipAddress: ip, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          action: true,
          module: true,
          status: true,
          userId: true,
          targetId: true,
          targetType: true,
          method: true,
          path: true,
          ipAddress: true,
          userAgent: true,
          duration: true,
          errorMessage: true,
          requestData: true,
          createdAt: true,
        },
      }),
    ]);
    const timeline = [
      ...accessLogs.map((log) => ({ ...log, source: 'access' as const, time: log.requestTime })),
      ...operationLogs.map((log) => ({
        ...log,
        source: 'operation' as const,
        time: log.createdAt,
      })),
    ].sort((a, b) => b.time.getTime() - a.time.getTime());
    const userIds = [
      ...new Set(
        [...accessLogs, ...operationLogs].flatMap((log) => (log.userId ? [log.userId] : [])),
      ),
    ];
    return {
      ip,
      userAgent:
        accessLogs.find((log) => log.userAgent)?.userAgent ||
        operationLogs.find((log) => log.userAgent)?.userAgent,
      totalEvents: timeline.length,
      uniqueUserCount: userIds.length,
      userIds,
      timeline: timeline.slice(0, 100),
    };
  }

  async getModuleStatistics(module: string) {
    const [total, avgResponseTime, actionStats] = await Promise.all([
      this.model.count({ where: { module } }),
      this.average(module, 'responseTime'),
      this.actionStatistics(module),
    ]);
    return { module, total, avgResponseTime, actionStats };
  }

  exportToCsv(params: LogQuery & { limit?: number }): Promise<string> {
    return this.csv(params, [
      ['id', 'ID'],
      ['module', '模块'],
      ['action', '操作'],
      ['describe', '描述'],
      ['userId', '用户ID'],
      ['username', '用户名'],
      ['requestUrl', '请求URL'],
      ['method', 'HTTP方法'],
      ['ip', 'IP地址'],
      ['requestTime', '请求时间'],
      ['responseTime', '响应时长(ms)'],
      ['exception', '异常信息'],
    ]);
  }
}

@Injectable()
export class OperationLogService extends PersistentLogService<StoredOperationLog> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    @Optional() sanitizer?: LogSanitizer,
    @Optional() @Inject(PERSISTENT_LOG_OPTIONS) options: PersistentLogOptions = {},
  ) {
    super(
      db,
      options.operationModel ?? 'operationLogs',
      'createdAt',
      ['module', 'action', 'userId', 'status'],
      sanitizer,
    );
  }

  async log(input: LogOperationData): Promise<void> {
    await this.write(() => ({
      module: input.module,
      action: input.action,
      userId: input.userId,
      targetId: input.targetId,
      targetType: input.targetType,
      method: input.method,
      path: input.path ? this.sanitizer.sanitizeText(input.path) : input.path,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent ? this.sanitizer.sanitizeText(input.userAgent) : input.userAgent,
      status: input.status || 'SUCCESS',
      duration: input.duration,
      errorMessage:
        input.errorMessage == null ? undefined : this.sanitizer.sanitizeText(input.errorMessage),
      requestData: this.sanitizer.sanitizeValue(input.requestData),
      responseData: this.sanitizer.sanitizeValue(input.responseData),
      metadata: this.sanitizer.sanitizeValue(input.metadata),
    }));
  }

  async getModuleStatistics(module: string) {
    const [total, successCount, failedCount, avgDuration, actionStats] = await Promise.all([
      this.model.count({ where: { module } }),
      this.model.count({ where: { module, status: 'SUCCESS' } }),
      this.model.count({ where: { module, status: 'FAILED' } }),
      this.average(module, 'duration'),
      this.actionStatistics(module),
    ]);
    return {
      module,
      total,
      successCount,
      failedCount,
      successRate: total ? ((successCount / total) * 100).toFixed(2) : '0',
      avgDuration,
      actionStats,
    };
  }

  exportToCsv(params: LogQuery & { limit?: number }): Promise<string> {
    return this.csv(params, [
      ['id', 'ID'],
      ['module', '模块'],
      ['action', '操作'],
      ['userId', '用户ID'],
      ['targetId', '目标ID'],
      ['targetType', '目标类型'],
      ['method', 'HTTP方法'],
      ['path', '路径'],
      ['ipAddress', 'IP地址'],
      ['status', '状态'],
      ['duration', '耗时(ms)'],
      ['errorMessage', '错误信息'],
      ['createdAt', '创建时间'],
    ]);
  }
}

export interface MetadataLogOptions<T> {
  modelName: string;
  /** Explicit metadata allowlist/projection. Never implicitly persist the whole input. */
  serialize(input: T): Record<string, unknown>;
}

/** Reuse log persistence, redaction and retention for consumer-defined metadata records. */
export class MetadataLogService<T> extends PersistentLogService<LogRecord> {
  constructor(db: DatabaseAdapter, private readonly options: MetadataLogOptions<T>, sanitizer?: LogSanitizer) {
    super(db, options.modelName, 'createdAt', [], sanitizer);
  }
  record(input: T): Promise<void> {
    return this.write(() => this.options.serialize(input));
  }
}
