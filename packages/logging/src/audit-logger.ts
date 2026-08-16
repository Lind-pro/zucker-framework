import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PiiFilter } from './pii-filter';

/**
 * 审计日志系统 — 追加式审计事件接口
 *
 * 记录敏感操作的最小必要上下文（谁在什么时间做了什么，影响了哪些数据）。
 * 与 AccessLoggerInterceptor 的区别：审计日志是 **业务语义级** 的，
 * 而访问日志是 **HTTP 级** 的。
 *
 * 注意：AuditLogger 只负责构建、脱敏和 append 事件；持久化、不可变约束、
 * retention 与告警必须由业务提供的 AuditStore 和运行环境保证。默认内存 store
 * 仅用于开发/测试，不是 durable 或 immutable store。
 *
 * 用法:
 * ```ts
 * auditLogger.log({
 *   action: 'user.role.assign',
 *   actor: { id: 'admin-1', type: 'user' },
 *   target: { type: 'user', id: 'user-42' },
 *   changes: { roles: { before: ['viewer'], after: ['viewer', 'editor'] } },
 *   reason: '用户晋升为编辑',
 * });
 * ```
 */

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'read'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'permission.grant'
  | 'permission.revoke'
  | 'config.change'
  | 'export'
  | 'import'
  | string; // 允许自定义

export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface AuditActor {
  id: string;
  type: 'user' | 'system' | 'api_key' | 'service' | 'anonymous';
  name?: string;
  ip?: string;
}

export interface AuditTarget {
  type: string; // 'user', 'role', 'config', 'file', ...
  id?: string;
  name?: string;
}

export interface AuditChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AuditEntry {
  /** 审计事件 ID（自动生成） */
  id: string;
  /** 操作类型 */
  action: AuditAction;
  /** 严重级别 */
  severity: AuditSeverity;
  /** 执行者 */
  actor: AuditActor;
  /** 操作目标 */
  target?: AuditTarget;
  /** 数据变更详情 */
  changes?: AuditChange[];
  /** 操作原因/备注 */
  reason?: string;
  /** 操作结果 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
  /** 关联 ID（correlationId） */
  correlationId?: string;
  /** 租户 ID */
  tenantId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

export interface AuditLogInput {
  action: AuditAction;
  actor: AuditActor;
  target?: AuditTarget;
  changes?: AuditChange[] | Record<string, { before: unknown; after: unknown }>;
  reason?: string;
  success?: boolean;
  error?: string;
  severity?: AuditSeverity;
  correlationId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

/** 审计日志存储接口 */
export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  query(options: AuditQueryOptions): Promise<{ entries: AuditEntry[]; total: number }>;
}

export interface AuditQueryOptions {
  action?: AuditAction;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  tenantId?: string;
  severity?: AuditSeverity;
  success?: boolean;
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}

export const AUDIT_STORE = Symbol('AUDIT_STORE');

/** 内存审计存储（开发/测试用） */
export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, this.entries.length - this.maxSize);
    }
  }

  async query(options: AuditQueryOptions): Promise<{ entries: AuditEntry[]; total: number }> {
    let filtered = this.entries;
    if (options.action) filtered = filtered.filter((e) => e.action === options.action);
    if (options.actorId) filtered = filtered.filter((e) => e.actor.id === options.actorId);
    if (options.targetType)
      filtered = filtered.filter((e) => e.target?.type === options.targetType);
    if (options.targetId) filtered = filtered.filter((e) => e.target?.id === options.targetId);
    if (options.tenantId) filtered = filtered.filter((e) => e.tenantId === options.tenantId);
    if (options.severity) filtered = filtered.filter((e) => e.severity === options.severity);
    if (options.success !== undefined) {
      filtered = filtered.filter((e) => e.success === options.success);
    }
    if (options.startTime) filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter((e) => e.timestamp <= options.endTime!);

    const total = filtered.length;
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const start = (page - 1) * pageSize;
    return { entries: filtered.slice(start, start + pageSize), total };
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }
}

@Injectable()
export class AuditLogger {
  private readonly logger = new Logger(AuditLogger.name);
  private store: AuditStore;
  private readonly piiFilter: PiiFilter;

  constructor(store?: AuditStore, piiFilter?: PiiFilter) {
    this.store = store ?? new InMemoryAuditStore();
    this.piiFilter = piiFilter ?? new PiiFilter();
  }

  setStore(store: AuditStore): void {
    this.store = store;
  }

  /**
   * 记录审计事件。
   *
   * 兼容历史调用：存储失败会写入脱敏后的服务日志，但不会阻断业务。
   * 对必须与业务事务共同提交的安全事件，请使用 `logRequired`。
   */
  async log(input: AuditLogInput): Promise<AuditEntry> {
    return this.write(input, false);
  }

  /**
   * 记录必须成功持久化的审计事件。
   *
   * 存储失败时抛出通用错误，使调用方能够回滚同一数据库事务。原始错误只会经过
   * PII 过滤后写入服务日志，不会进入面向客户端的异常消息。
   */
  async logRequired(input: AuditLogInput): Promise<AuditEntry> {
    return this.write(input, true);
  }

  private async write(input: AuditLogInput, required: boolean): Promise<AuditEntry> {
    const changes = this.normalizeChanges(input.changes);

    const entry = this.piiFilter.sanitizeValue({
      id: `audit_${randomUUID()}`,
      action: input.action,
      severity: input.severity ?? this.inferSeverity(input.action),
      actor: input.actor,
      target: input.target,
      changes,
      reason: input.reason,
      success: input.success ?? true,
      error: input.error,
      correlationId: input.correlationId,
      tenantId: input.tenantId,
      timestamp: Date.now(),
      metadata: input.metadata,
    }) as AuditEntry;

    try {
      await this.store.append(entry);
    } catch (err) {
      // 审计日志写入失败不应阻塞业务，但必须记录
      this.logger.error(
        this.piiFilter.sanitize(
          `Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      if (required) {
        throw new Error('Required audit log write failed', {
          cause: err,
        });
      }
    }

    return entry;
  }

  /**
   * 查询审计日志
   */
  async query(options: AuditQueryOptions): Promise<{ entries: AuditEntry[]; total: number }> {
    return this.store.query(options);
  }

  private normalizeChanges(
    changes?: AuditChange[] | Record<string, { before: unknown; after: unknown }>,
  ): AuditChange[] | undefined {
    if (!changes) return undefined;
    if (Array.isArray(changes)) return changes;

    return Object.entries(changes).map(([field, { before, after }]) => ({
      field,
      before,
      after,
    }));
  }

  private inferSeverity(action: AuditAction): AuditSeverity {
    if (action.includes('delete') || action.includes('revoke')) return 'warning';
    if (action.includes('login_failed') || action === 'config.change') return 'warning';
    if (action.includes('permission') || action.includes('role')) return 'warning';
    return 'info';
  }
}
