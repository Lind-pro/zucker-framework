import { BadRequestException } from '@nestjs/common';
import type { LogQuery, OperationLogStatus } from '@zucker-framework/logging';

/**
 * The one HTTP contract for persisted audit records, shared by every server route that lists them
 * (`createAccessLogAdminController`, `createOperationLogAdminController`, the back-office
 * management host) and by the `@zucker-framework/fe-admin` record pages (`accessLogs`, `operationLogs`).
 *
 * Request — `GET <path>?page&pageSize&…` (query string, every value a string):
 * - `page` 1–10000 (default 1), `pageSize` 1–100 (default 20)
 * - `id` (exact), `ownerId` (= `userId`, the fe-admin filter name; `userId` is accepted as an alias)
 * - `module`, `action`, `startDate`, `endDate` (ISO dates, inclusive range on the record time)
 * - access only: `ip`, `method`; operation only: `status` (`SUCCESS` | `FAILED` | `PENDING`)
 * Any other key, an over-long or control-character value, or an invalid number/date is a 400.
 *
 * Response — `{ data, total, page, pageSize }`, newest first; each row carries only the projected
 * fields below (no parameters, results, user agents, addresses or exception text: those stay on the
 * single-record detail route of the admin factories).
 */
export type LogRecordKind = 'access' | 'operation';

export const ACCESS_LOG_RECORD_FIELDS = [
  'id', 'userId', 'username', 'module', 'action', 'method', 'requestUrl', 'requestTime', 'responseTime',
] as const;
export const OPERATION_LOG_RECORD_FIELDS = [
  'id', 'userId', 'module', 'action', 'status', 'targetId', 'targetType', 'method', 'path', 'duration', 'createdAt',
] as const;
export const OPERATION_LOG_STATUSES: readonly OperationLogStatus[] = ['SUCCESS', 'FAILED', 'PENDING'];
export const LOG_RECORD_MAX_PAGE = 10_000;
export const LOG_RECORD_MAX_PAGE_SIZE = 100;

export type AccessLogRecordField = (typeof ACCESS_LOG_RECORD_FIELDS)[number];
export type OperationLogRecordField = (typeof OPERATION_LOG_RECORD_FIELDS)[number];
export interface LogRecordsPage<T = Record<string, unknown>> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
/** Parsed request; `filters` is ready for `AccessLogService.findAll` / `OperationLogService.findAll`. */
export interface LogRecordsQuery {
  page: number;
  pageSize: number;
  id?: string;
  filters: Omit<LogQuery, 'page' | 'pageSize'>;
}

const COMMON_KEYS = ['page', 'pageSize', 'id', 'ownerId', 'userId', 'module', 'action', 'startDate', 'endDate'];
const KIND_KEYS: Record<LogRecordKind, string[]> = { access: ['ip', 'method'], operation: ['status'] };

function text(name: string, value: unknown, limit: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value))
    throw new BadRequestException(`Invalid log filter: ${name}`);
  return value.trim();
}
function integer(name: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new BadRequestException(`${name}: Expected a positive integer (at most ${max})`);
  return number;
}
function date(name: string, value: unknown): Date | undefined {
  const raw = text(name, value, 40);
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException(`Invalid date: ${name}`);
  return parsed;
}

/** Validates an untrusted query object against the log record contract. */
export function parseLogRecordsQuery(kind: LogRecordKind, query: unknown): LogRecordsQuery {
  if (query === undefined || query === null) query = {};
  if (typeof query !== 'object' || Array.isArray(query)) throw new BadRequestException('Invalid log query');
  const source = query as Record<string, unknown>;
  const allowed = [...COMMON_KEYS, ...KIND_KEYS[kind]];
  const unknown = Object.keys(source).find((key) => !allowed.includes(key));
  if (unknown) throw new BadRequestException(`Unsupported log filter: ${unknown}`);
  const ownerId = text('ownerId', source.ownerId, 191);
  const userId = text('userId', source.userId, 191);
  if (ownerId && userId && ownerId !== userId) throw new BadRequestException('ownerId and userId disagree');
  const status = text('status', source.status, 16);
  if (status !== undefined && !OPERATION_LOG_STATUSES.includes(status as OperationLogStatus))
    throw new BadRequestException('Invalid operation status');
  const method = text('method', source.method, 16);
  const startDate = date('startDate', source.startDate);
  const endDate = date('endDate', source.endDate);
  if (startDate && endDate && startDate > endDate) throw new BadRequestException('startDate must not exceed endDate');
  const filters: LogRecordsQuery['filters'] = {
    ...(ownerId ?? userId ? { userId: ownerId ?? userId } : {}),
    ...optional('module', text('module', source.module, 100)),
    ...optional('action', text('action', source.action, 100)),
    ...optional('ip', kind === 'access' ? text('ip', source.ip, 64) : undefined),
    ...optional('method', kind === 'access' && method ? method.toUpperCase() : undefined),
    ...optional('status', status as OperationLogStatus | undefined),
    ...optional('startDate', startDate),
    ...optional('endDate', endDate),
  };
  return {
    page: integer('page', source.page, 1, LOG_RECORD_MAX_PAGE),
    pageSize: integer('pageSize', source.pageSize, 20, LOG_RECORD_MAX_PAGE_SIZE),
    ...optional('id', text('id', source.id, 191)),
    filters,
  };
}
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Copies only the contract fields of one stored record (missing fields become `null`). */
export function projectLogRecord(kind: LogRecordKind, row: unknown): Record<string, unknown> {
  const source = (row ?? {}) as Record<string, unknown>;
  const fields = kind === 'access' ? ACCESS_LOG_RECORD_FIELDS : OPERATION_LOG_RECORD_FIELDS;
  return Object.fromEntries(fields.map((field) => [field, source[field] ?? null]));
}

/** The subset of `AccessLogService` / `OperationLogService` the contract needs. */
export interface LogRecordSource {
  findAll(params: LogQuery): Promise<{ data: unknown[]; total: number; page?: number; pageSize?: number }>;
  findOne(id: string): Promise<unknown>;
}

function matches(kind: LogRecordKind, row: Record<string, unknown>, filters: LogRecordsQuery['filters']): boolean {
  const time = row[kind === 'access' ? 'requestTime' : 'createdAt'];
  const at = time instanceof Date ? time : typeof time === 'string' ? new Date(time) : null;
  for (const key of ['userId', 'module', 'action', 'ip', 'method', 'status'] as const) {
    const expected = filters[key];
    if (expected !== undefined && row[key] !== expected) return false;
  }
  if (filters.startDate && (!at || at < filters.startDate)) return false;
  if (filters.endDate && (!at || at > filters.endDate)) return false;
  return true;
}

/**
 * Runs one contract request against a persisted log service and returns the projected page.
 * Validation is synchronous (an invalid query throws before storage is touched).
 */
export function listLogRecords(kind: LogRecordKind, source: LogRecordSource, query: unknown): Promise<LogRecordsPage> {
  return runLogRecords(kind, source, parseLogRecordsQuery(kind, query));
}
async function runLogRecords(kind: LogRecordKind, source: LogRecordSource, parsed: LogRecordsQuery): Promise<LogRecordsPage> {
  if (parsed.id !== undefined) {
    // An id names at most one record; the other filters still have to match it.
    const row = (await source.findOne(parsed.id)) as Record<string, unknown> | null;
    const hit = row && matches(kind, row, parsed.filters) ? [projectLogRecord(kind, row)] : [];
    return { data: parsed.page === 1 ? hit : [], total: hit.length, page: parsed.page, pageSize: parsed.pageSize };
  }
  let result: Awaited<ReturnType<LogRecordSource['findAll']>>;
  try {
    result = await source.findAll({ ...parsed.filters, page: parsed.page, pageSize: parsed.pageSize });
  } catch (error) {
    if (error instanceof RangeError) throw new BadRequestException(error.message);
    throw error;
  }
  return {
    data: result.data.map((row) => projectLogRecord(kind, row)),
    total: result.total,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}
