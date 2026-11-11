// @vitest-environment node
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_LOG_RECORD_FIELDS, OPERATION_LOG_RECORD_FIELDS, OPERATION_LOG_STATUSES, listLogRecords, parseLogRecordsQuery, projectLogRecord,
  type LogRecordSource,
} from './log-records';
import { createAccessLogAdminController, createOperationLogAdminController } from './log-management.controller';

const bad = (kind: 'access' | 'operation', query: unknown) => {
  try { parseLogRecordsQuery(kind, query); } catch (error) { expect(error).toBeInstanceOf(BadRequestException); return; }
  throw new Error(`expected 400 for ${JSON.stringify(query)}`);
};

describe('parseLogRecordsQuery', () => {
  it('defaults page 1, pageSize 20 and no filters; null/undefined query is empty', () => {
    expect(parseLogRecordsQuery('access', {})).toEqual({ page: 1, pageSize: 20, filters: {} });
    expect(parseLogRecordsQuery('operation', undefined)).toEqual({ page: 1, pageSize: 20, filters: {} });
    expect(parseLogRecordsQuery('operation', null)).toEqual({ page: 1, pageSize: 20, filters: {} });
  });
  it('maps ownerId and its userId alias to the user filter and trims text', () => {
    expect(parseLogRecordsQuery('access', { ownerId: ' u1 ' }).filters).toEqual({ userId: 'u1' });
    expect(parseLogRecordsQuery('access', { userId: 'u2' }).filters).toEqual({ userId: 'u2' });
    expect(parseLogRecordsQuery('access', { ownerId: 'u1', userId: 'u1' }).filters).toEqual({ userId: 'u1' });
    bad('access', { ownerId: 'u1', userId: 'u2' });
  });
  it('accepts the documented per-kind filters only', () => {
    const access = parseLogRecordsQuery('access', { module: 'm', action: 'a', ip: '192.0.2.1', method: 'get', startDate: '2026-01-01', endDate: '2026-02-01', id: 'x', page: '3', pageSize: '100' });
    expect(access).toMatchObject({ page: 3, pageSize: 100, id: 'x', filters: { module: 'm', action: 'a', ip: '192.0.2.1', method: 'GET',
      startDate: new Date('2026-01-01'), endDate: new Date('2026-02-01') } });
    expect(parseLogRecordsQuery('operation', { status: 'FAILED' }).filters).toEqual({ status: 'FAILED' });
    bad('access', { status: 'SUCCESS' });
    bad('operation', { ip: '192.0.2.1' });
    bad('operation', { method: 'GET' });
  });
  it.each([
    [{ page: '0' }], [{ page: '10001' }], [{ page: '-1' }], [{ page: '1.5' }], [{ page: 'abc' }], [{ page: '1e2' }], [{ page: ' 1' }], [{ page: 0 }],
    [{ pageSize: '0' }], [{ pageSize: '101' }], [{ pageSize: 'x' }], [{ pageSize: Number.NaN }],
    [{ unknown: '1' }], [{ __proto__: null, constructor: 'x' }], [{ startDate: 'nope' }], [{ endDate: '2026-13-45' }],
    [{ startDate: '2026-03-01', endDate: '2026-02-01' }],
    [{ module: 'x'.repeat(101) }], [{ action: 'a\u0000b' }], [{ module: 'a\nb' }], [{ id: 'x'.repeat(192) }], [{ module: 5 }], [{ module: ['a', 'b'] }],
    [{ ownerId: '\u007f' }],
  ])('rejects invalid access query %j with 400', (query) => bad('access', query));
  it('rejects non-object queries and invalid operation status', () => {
    bad('access', 'page=1'); bad('access', ['page']); bad('access', 5);
    bad('operation', { status: 'DONE' }); bad('operation', { status: 'success' });
    for (const status of OPERATION_LOG_STATUSES) expect(parseLogRecordsQuery('operation', { status }).filters.status).toBe(status);
  });
  it('treats empty strings as absent (an empty form field)', () => {
    expect(parseLogRecordsQuery('operation', { module: '', status: '', page: '', startDate: '' })).toEqual({ page: 1, pageSize: 20, filters: {} });
  });
  it('accepts the limits exactly', () => {
    expect(parseLogRecordsQuery('access', { page: '10000', pageSize: '100' })).toMatchObject({ page: 10000, pageSize: 100 });
    expect(parseLogRecordsQuery('access', { page: 1, pageSize: 1 })).toMatchObject({ page: 1, pageSize: 1 });
  });
});

describe('projectLogRecord', () => {
  it('copies only contract fields and nulls missing ones', () => {
    const access = projectLogRecord('access', { id: 'a', userId: 'u', ip: '192.0.2.1', userAgent: 'x', parameters: { secret: 1 }, results: 'r', exception: 'e', requestUrl: '/x' });
    expect(Object.keys(access)).toEqual([...ACCESS_LOG_RECORD_FIELDS]);
    expect(access).toMatchObject({ id: 'a', userId: 'u', requestUrl: '/x', username: null, module: null });
    for (const leaked of ['ip', 'userAgent', 'parameters', 'results', 'exception']) expect(access).not.toHaveProperty(leaked);
    const operation = projectLogRecord('operation', { id: 'o', status: 'SUCCESS', metadata: { token: 't' }, parameters: {}, ip: '192.0.2.1' });
    expect(Object.keys(operation)).toEqual([...OPERATION_LOG_RECORD_FIELDS]);
    for (const leaked of ['metadata', 'parameters', 'ip']) expect(operation).not.toHaveProperty(leaked);
    expect(projectLogRecord('access', null)).toEqual(Object.fromEntries(ACCESS_LOG_RECORD_FIELDS.map(field => [field, null])));
  });
});

describe('listLogRecords', () => {
  const rows = [
    { id: 'a1', userId: 'u1', module: 'm', action: 'read', ip: '192.0.2.1', requestTime: new Date('2026-01-10T00:00:00Z'), parameters: { secret: 1 } },
    { id: 'a2', userId: 'u2', module: 'm', action: 'read', ip: '192.0.2.2', requestTime: new Date('2026-03-10T00:00:00Z') },
  ];
  const source = (overrides: Partial<LogRecordSource> = {}): LogRecordSource & { findAll: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> } => ({
    findAll: vi.fn(async () => ({ data: rows, total: 41 })),
    findOne: vi.fn(async (id: string) => rows.find(row => row.id === id) ?? null),
    ...overrides,
  }) as never;

  it('projects rows, reports the requested page and passes parsed filters to the service', async () => {
    const s = source();
    const page = await listLogRecords('access', s, { ownerId: 'u1', page: '2', pageSize: '5', startDate: '2026-01-01' });
    expect(page).toMatchObject({ total: 41, page: 2, pageSize: 5 });
    expect(page.data[0]).not.toHaveProperty('parameters');
    expect(page.data[0]).toMatchObject({ id: 'a1', userId: 'u1', username: null });
    expect(s.findAll).toHaveBeenCalledWith({ userId: 'u1', startDate: new Date('2026-01-01'), page: 2, pageSize: 5 });
  });
  it('validates synchronously: an invalid query throws before the service is touched', () => {
    const s = source();
    expect(() => listLogRecords('access', s, { bogus: 1 })).toThrow(BadRequestException);
    expect(() => listLogRecords('operation', s, { page: '0' })).toThrow(BadRequestException);
    expect(s.findAll).not.toHaveBeenCalled();
    expect(s.findOne).not.toHaveBeenCalled();
  });
  it('looks up an id directly, applies the other filters to it and returns nothing past page 1', async () => {
    const s = source();
    expect(await listLogRecords('access', s, { id: 'a1' })).toMatchObject({ total: 1, data: [{ id: 'a1' }] });
    expect(await listLogRecords('access', s, { id: 'a1', ownerId: 'u2' })).toMatchObject({ total: 0, data: [] });
    expect(await listLogRecords('access', s, { id: 'a1', startDate: '2026-02-01' })).toMatchObject({ total: 0, data: [] });
    expect(await listLogRecords('access', s, { id: 'a1', endDate: '2026-02-01' })).toMatchObject({ total: 1 });
    expect(await listLogRecords('access', s, { id: 'a1', ip: '192.0.2.2' })).toMatchObject({ total: 0 });
    expect(await listLogRecords('access', s, { id: 'a1', page: '2' })).toMatchObject({ total: 1, data: [], page: 2 });
    expect(await listLogRecords('access', s, { id: 'missing' })).toMatchObject({ total: 0, data: [] });
    expect(s.findAll).not.toHaveBeenCalled();
  });
  it('turns a RangeError from the store into 400 and keeps other failures', async () => {
    await expect(listLogRecords('access', source({ findAll: async () => { throw new RangeError('too large'); } }), {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(listLogRecords('access', source({ findAll: async () => { throw new Error('db down'); } }), {})).rejects.toThrow('db down');
  });
});

describe('admin log controller factories use the contract', () => {
  function controller(kind: 'access' | 'operation') {
    const factory = kind === 'access' ? createAccessLogAdminController : createOperationLogAdminController;
    const Controller = factory({ path: `management/${kind}`, resource: { id: `audit:${kind}`, name: 'Audit' }, auditModule: 'audit' });
    const service = { findAll: vi.fn(async () => ({ data: [{ id: 'r1', userId: 'u', parameters: { secret: 1 }, ip: '192.0.2.1', status: 'SUCCESS' }], total: 1 })), findOne: vi.fn() };
    return { instance: new Controller(service as never) as unknown as { findAll(query: unknown): unknown }, service };
  }
  it.each(['access', 'operation'] as const)('%s list is projected and a bad query is a synchronous 400', async (kind) => {
    const { instance, service } = controller(kind);
    const page = await instance.findAll({ page: '1' }) as { data: Array<Record<string, unknown>> };
    expect(page.data[0]).not.toHaveProperty('parameters');
    expect(page.data[0]).not.toHaveProperty('ip');
    expect(() => instance.findAll({ pageSize: '1000' })).toThrow(BadRequestException);
    expect(() => instance.findAll({ nope: 'x' })).toThrow(BadRequestException);
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });
});
