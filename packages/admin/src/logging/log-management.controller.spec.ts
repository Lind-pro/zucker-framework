import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard, type PermissionService } from '@zucker-framework/auth';
import {
  createAccessLogAdminController,
  createOperationLogAdminController,
} from './log-management.controller';

type Methods = {
  findAll(query: unknown): unknown;
  batchDelete(body: unknown): unknown;
  cleanOldLogs(body: unknown): unknown;
  findOne(id: string): unknown;
  statistics(module: string): unknown;
  timeline?: (ip: string, days?: string) => unknown;
};
function setup(kind: 'access' | 'operation') {
  const factory =
    kind === 'access' ? createAccessLogAdminController : createOperationLogAdminController;
  const Controller = factory({
    path: `management/${kind}`,
    resource: { id: `audit:${kind}`, name: 'Audit records' },
    auditModule: 'audit-management',
  });
  const service = {
    findAll: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 }),
    findOne: vi.fn(),
    batchDelete: vi.fn(),
    cleanOldLogs: vi.fn(),
    getModuleStatistics: vi.fn(),
    getIpTimeline: vi.fn(),
  };
  const controller = new Controller(service) as Methods;
  return { Controller, service, controller };
}

describe('persistent log management controllers', () => {
  it('binds host routes and delegates typed filters to the configured database log service', async () => {
    const { Controller, controller, service } = setup('access');
    expect(Reflect.getMetadata(PATH_METADATA, Controller)).toBe('management/access');
    await controller.findAll({
      module: 'orders',
      userId: 'user',
      ip: '192.0.2.5',
      startDate: '2026-01-01',
      page: '2',
      pageSize: '30',
    });
    expect(service.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'orders',
        userId: 'user',
        ip: '192.0.2.5',
        startDate: new Date('2026-01-01'),
        page: 2,
        pageSize: 30,
      }),
    );
    controller.timeline?.('192.0.2.5', '4');
    expect(service.getIpTimeline).toHaveBeenCalledWith('192.0.2.5', 4);
    expect(setup('operation').controller.timeline).toBeUndefined();
  });

  it('retains query/delete permission boundaries on inherited controller methods', async () => {
    const { Controller, controller } = setup('access');
    const hasPermission = vi.fn(async (_id: string, permissions: string[]) =>
      permissions.every((p) => p === 'audit:access:query'),
    );
    const guard = new PermissionsGuard(new Reflector(), {
      hasPermission,
    } as unknown as PermissionService);
    function context(method: keyof Methods, signedIn = true): ExecutionContext {
      return {
        getClass: () => Controller,
        getHandler: () => controller[method],
        switchToHttp: () => ({
          getRequest: () => ({ user: signedIn ? { id: 'reader', username: 'reader' } : undefined }),
        }),
      } as unknown as ExecutionContext;
    }
    expect(await guard.canActivate(context('findAll', false))).toBe(false);
    expect(await guard.canActivate(context('findAll'))).toBe(true);
    expect(await guard.canActivate(context('batchDelete'))).toBe(false);
    expect(hasPermission).toHaveBeenLastCalledWith('reader', ['audit:access:delete']);
  });

  it('rejects invalid paging, dates, bulk IDs and retention before calling storage', () => {
    const { controller, service } = setup('operation');
    expect(() => controller.findAll({ page: '-1' })).toThrow('positive integer');
    expect(() => controller.findAll({ startDate: 'not-a-date' })).toThrow('Invalid date');
    expect(() => controller.findAll({ status: 'UNKNOWN' })).toThrow('Invalid operation status');
    expect(() => controller.batchDelete({ ids: [] })).toThrow('log IDs');
    expect(() => controller.batchDelete({ ids: Array(1001).fill('id') })).toThrow('log IDs');
    expect(() => controller.cleanOldLogs({ daysToKeep: -1 })).toThrow('positive integer');
    expect(service.findAll).not.toHaveBeenCalled();
    expect(service.batchDelete).not.toHaveBeenCalled();
    expect(service.cleanOldLogs).not.toHaveBeenCalled();
    controller.batchDelete({ ids: ['one', 'two'] });
    controller.cleanOldLogs({});
    expect(service.batchDelete).toHaveBeenCalledWith(['one', 'two']);
    expect(service.cleanOldLogs).toHaveBeenCalledWith(90);
  });
});
