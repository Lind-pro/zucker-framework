// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PermissionsGuard, type PermissionService } from '@zucker-framework/auth';
import { createPlanAdminController } from './plan.controller';
import { createUserSubscriptionAdminController } from './subscription.controller';
import { createQuotaAdminControllers } from '../credit/quota.controller';
import { createMailLogAdminController } from '../notification/mail-log.controller';
import { mapPortError } from '../port-errors';
import { brandPortError } from '@zucker-framework/fe-types/back-office';

class ReasonError extends Error {
  constructor(readonly reason: string, message = reason, readonly issues?: string[], readonly details?: Record<string, unknown>) {
    super(message);
    brandPortError(this as never);
  }
}

/** The permission each handler requires, observed through the real guard. */
async function required(Controller: Type<unknown>, instance: object, method: string) {
  const seen: string[][] = [];
  const guard = new PermissionsGuard(new Reflector(), {
    hasPermission: vi.fn(async (_id: string, permissions: string[]) => { seen.push(permissions); return true; }),
  } as unknown as PermissionService);
  await guard.canActivate({
    getClass: () => Controller,
    getHandler: () => (instance as Record<string, unknown>)[method],
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'admin' } }) }),
  } as unknown as ExecutionContext);
  return seen.flat();
}

describe('port error mapping', () => {
  it('maps documented reasons and rethrows everything else', () => {
    expect(() => mapPortError(new ReasonError('invalid', 'bad', ['a']))).toThrow(BadRequestException);
    try { mapPortError(new ReasonError('invalid', 'bad', ['a'])); } catch (error) {
      expect((error as BadRequestException).getResponse()).toEqual({ statusCode: 400, message: 'bad', code: 'invalid', reason: 'invalid', issues: ['a'] });
    }
    expect(() => mapPortError(new ReasonError('not_found'))).toThrow(NotFoundException);
    for (const reason of ['conflict', 'referenced', 'pending_payment', 'inactive', 'in_progress'])
      expect(() => mapPortError(new ReasonError(reason))).toThrow(ConflictException);
    try { mapPortError(new ReasonError('pending_payment', 'settle', undefined, { blocking: { kind: 'order', id: 'o1', state: 'pending' } })); } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({ reason: 'pending_payment', details: { blocking: { id: 'o1' } } });
    }
    expect(() => mapPortError(new ReasonError('unavailable'))).toThrow(ServiceUnavailableException);
    // An unknown reason, or a foreign error that merely has a matching `reason`, is not translated.
    const other = new ReasonError('database');
    expect(() => mapPortError(other)).toThrow(other);
    const foreign = Object.assign(new Error('third party'), { reason: 'not_found' });
    expect(() => mapPortError(foreign)).toThrow(foreign);
    expect(() => mapPortError('plain')).toThrow();
  });
});

describe('plan admin controller', () => {
  const PLANS = Symbol('PLANS');
  function setup() {
    const Controller = createPlanAdminController({ service: PLANS });
    const service = {
      list: vi.fn().mockResolvedValue([{ id: 'p1' }]),
      findById: vi.fn().mockRejectedValue(new ReasonError('not_found', 'Plan not found')),
      create: vi.fn().mockRejectedValue(new ReasonError('conflict', 'Plan slug already exists')),
      update: vi.fn().mockResolvedValue({ id: 'p1', name: 'x' }),
      setStatus: vi.fn().mockResolvedValue({ id: 'p1', status: true }),
      delete: vi.fn().mockRejectedValueOnce(new ReasonError('referenced', 'Plan is referenced')).mockResolvedValue(undefined),
    };
    return { Controller, service, controller: new Controller(service) };
  }
  it('uses the RFC path and permission codes', async () => {
    const { Controller, controller } = setup();
    expect(Reflect.getMetadata(PATH_METADATA, Controller)).toBe('management/plans');
    expect(await required(Controller, controller, 'list')).toEqual(['plans:query']);
    expect(await required(Controller, controller, 'detail')).toEqual(['plans:query']);
    expect(await required(Controller, controller, 'create')).toEqual(['plans:add']);
    expect(await required(Controller, controller, 'update')).toEqual(['plans:update']);
    expect(await required(Controller, controller, 'setStatus')).toEqual(['plans:update']);
    expect(await required(Controller, controller, 'remove')).toEqual(['plans:delete']);
  });
  it('delegates to the port and maps its rejections', async () => {
    const { controller, service } = setup();
    expect(await controller.list()).toEqual([{ id: 'p1' }]);
    await expect(controller.detail('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.create({ slug: 'basic' })).rejects.toBeInstanceOf(ConflictException);
    expect(await controller.update('p1', { name: 'x' })).toEqual({ id: 'p1', name: 'x' });
    expect(service.update).toHaveBeenCalledWith('p1', { name: 'x' });
    expect(await controller.setStatus('p1', { status: true })).toEqual({ id: 'p1', status: true });
    expect(service.setStatus).toHaveBeenCalledWith('p1', true);
    expect(() => controller.setStatus('p1', { status: true, name: 'x' })).toThrow(BadRequestException);
    expect(() => controller.setStatus('p1', null)).toThrow(BadRequestException);
    await expect(controller.remove('p1')).rejects.toBeInstanceOf(ConflictException);
    expect(await controller.remove('p1')).toEqual({ deleted: true });
  });
  it('accepts host paths and permission names', async () => {
    const Controller = createPlanAdminController({ service: Symbol('X'), path: 'admin/plans', permissions: { query: 'plan:list' } });
    const controller = new Controller({} as never);
    expect(Reflect.getMetadata(PATH_METADATA, Controller)).toBe('admin/plans');
    expect(await required(Controller, controller, 'list')).toEqual(['plan:list']);
    expect(await required(Controller, controller, 'remove')).toEqual(['plans:delete']);
  });
});

describe('user subscription admin controller', () => {
  function setup() {
    const Controller = createUserSubscriptionAdminController({ service: Symbol('SUBS') });
    const service = {
      list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 }),
      detail: vi.fn().mockResolvedValue(null),
      assign: vi.fn().mockResolvedValue({ planId: 'p1' }),
      cancel: vi.fn().mockRejectedValue(new ReasonError('pending_payment', 'settle first')),
    };
    return { Controller, service, controller: new Controller(service) };
  }
  it('uses the RFC path and permission codes', async () => {
    const { Controller, controller } = setup();
    expect(Reflect.getMetadata(PATH_METADATA, Controller)).toBe('management/subscriptions');
    expect(await required(Controller, controller, 'list')).toEqual(['subscriptions:query']);
    expect(await required(Controller, controller, 'detail')).toEqual(['subscriptions:query']);
    expect(await required(Controller, controller, 'assign')).toEqual(['subscriptions:update']);
    expect(await required(Controller, controller, 'cancel')).toEqual(['subscriptions:update']);
  });
  it('bounds list filters and paging', async () => {
    const { controller, service } = setup();
    await controller.list({ page: '2', pageSize: '500', userId: 'u1', status: 'ACTIVE', active: 'active', planSlug: 'pro', ignored: 'x' });
    expect(service.list).toHaveBeenCalledWith({ page: 2, pageSize: 100, userId: 'u1', status: 'ACTIVE', activity: 'active', planSlug: 'pro' });
    expect(() => controller.list({ status: 'PAUSED' })).toThrow('Invalid status');
    expect(() => controller.list({ active: 'yes' })).toThrow('Invalid active filter');
    expect(() => controller.list({ userId: { not: 'x' } })).toThrow('Invalid userId');
    expect(() => controller.list({ page: '0' })).toThrow('Invalid page');
  });
  it('returns 404 for users without a subscription', async () => {
    const { controller, service } = setup();
    await expect(controller.detail('u1')).rejects.toBeInstanceOf(NotFoundException);
    service.detail.mockResolvedValue({ userId: 'u1', features: {}, quotas: {} });
    expect(await controller.detail('u1')).toEqual({ userId: 'u1', features: {}, quotas: {} });
  });
  it('validates assignment input and passes the acting administrator', async () => {
    const { controller, service } = setup();
    await controller.assign({ user: { id: 'admin' } }, 'u1', { planSlug: 'pro', billingCycle: 'YEARLY', startDate: '2026-01-01T00:00:00Z' });
    expect(service.assign).toHaveBeenCalledWith('u1', { planSlug: 'pro', billingCycle: 'YEARLY', status: 'ACTIVE',
      startDate: new Date('2026-01-01T00:00:00Z') }, 'admin');
    await controller.assign({}, 'u1', { planSlug: 'pro', billingCycle: 'LIFETIME', status: 'EXPIRED', endDate: null });
    expect(service.assign).toHaveBeenLastCalledWith('u1', { planSlug: 'pro', billingCycle: 'LIFETIME', status: 'EXPIRED', endDate: null }, undefined);
    await controller.assign({}, 'u1', { planSlug: 'pro', billingCycle: 'ONE_TIME', endDate: '2026-02-01T00:00:00Z' });
    expect(service.assign).toHaveBeenLastCalledWith('u1', expect.objectContaining({ billingCycle: 'ONE_TIME' }), undefined);
    const bad = (body: unknown) => () => controller.assign({}, 'u1', body);
    expect(bad(null)).toThrow('Invalid subscription');
    expect(bad({ planSlug: 'pro', billingCycle: 'MONTHLY', planId: 'x' })).toThrow('Unsupported field: planId');
    expect(bad({ billingCycle: 'MONTHLY' })).toThrow('planSlug is required');
    expect(bad({ planSlug: 'pro', billingCycle: 'WEEKLY' })).toThrow('Invalid billingCycle');
    expect(bad({ planSlug: 'pro', billingCycle: 'MONTHLY', status: 'PAUSED' })).toThrow('Invalid status');
    expect(bad({ planSlug: 'pro', billingCycle: 'MONTHLY', startDate: 'soon' })).toThrow('Invalid startDate');
    expect(bad({ planSlug: 'pro', billingCycle: 'MONTHLY', startDate: null })).toThrow('Invalid startDate');
    expect(bad({ planSlug: 'pro', billingCycle: 'MONTHLY', endDate: 5 })).toThrow('Invalid endDate');
    expect(() => controller.assign({}, '../etc', { planSlug: 'pro', billingCycle: 'MONTHLY' })).toThrow('Invalid userId');
  });
  it('maps the pending-payment guard to a conflict', async () => {
    const { controller, service } = setup();
    await expect(controller.cancel({ user: { id: 'admin' } }, 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(service.cancel).toHaveBeenCalledWith('u1', 'admin');
  });
});

describe('quota admin controllers', () => {
  function setup() {
    const model = {
      findMany: vi.fn().mockResolvedValue([{ id: 'r1', subjectId: 'u1', counter: 'c', status: 'RESERVED', policyVersion: 'internal' }]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(null),
    };
    const database = { model: vi.fn(() => model) };
    const port = { confirm: vi.fn().mockResolvedValue(true), release: vi.fn().mockRejectedValue(new ReasonError('not_found')) };
    const { usage: Usage, reservations: Reservations } = createQuotaAdminControllers({ reservations: Symbol('Q') });
    return { model, database, port, Usage, Reservations,
      usage: new Usage(database as never), reservations: new Reservations(database as never, port) };
  }
  it('uses RFC paths and permissions', async () => {
    const { Usage, Reservations, usage, reservations } = setup();
    expect(Reflect.getMetadata(PATH_METADATA, Usage)).toBe('management/quota-usage');
    expect(Reflect.getMetadata(PATH_METADATA, Reservations)).toBe('management/quota-reservations');
    expect(await required(Usage, usage, 'list')).toEqual(['quota:query']);
    expect(await required(Reservations, reservations, 'list')).toEqual(['quota:query']);
    expect(await required(Reservations, reservations, 'detail')).toEqual(['quota:query']);
    expect(await required(Reservations, reservations, 'release')).toEqual(['quota:update']);
    expect(await required(Reservations, reservations, 'confirm')).toEqual(['quota:update']);
  });
  it('projects fields and maps filters to model columns', async () => {
    const { reservations, usage, model, database } = setup();
    const page = await reservations.list({ userId: 'u1', status: 'RESERVED', resourceType: 'project' });
    expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { subjectId: 'u1', status: 'RESERVED', resourceType: 'project' },
      select: expect.not.objectContaining({ policyVersion: true }),
    }));
    expect(JSON.stringify(page)).not.toContain('internal');
    expect((page as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({ id: 'r1', userId: 'u1', status: 'RESERVED', reason: null });
    await expect(reservations.list({ status: 'DONE' })).rejects.toThrow('Invalid status');
    await expect(reservations.list({ policyVersion: 'x', filters: '{"policyVersion$eq":"x"}' })).rejects.toThrow('equality');
    await usage.list({ userId: 'u1', counter: 'c', period: '2026-01' });
    expect(model.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { subjectId: 'u1', counter: 'c', period: '2026-01' } }));
    expect(database.model).toHaveBeenCalledWith('quotaUsage');
    await expect(reservations.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('transitions through the reservation port and maps its errors', async () => {
    const { reservations, port } = setup();
    expect(await reservations.confirm('r1')).toEqual({ id: 'r1', changed: true });
    await expect(reservations.release('r1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(port.release).toHaveBeenCalledWith('r1', 'released-by-administrator');
    port.release.mockResolvedValue(false);
    expect(await reservations.release('r1', { reason: 'support' })).toEqual({ id: 'r1', changed: false });
    expect(port.release).toHaveBeenLastCalledWith('r1', 'support');
    await expect(reservations.release('r1', { reason: 5 })).rejects.toThrow('Invalid reason');
  });
});

describe('mail log admin controller', () => {
  it('filters through MailHistoryService and omits metadata', async () => {
    const Controller = createMailLogAdminController();
    const history = { list: vi.fn().mockResolvedValue({ data: [{ id: 'm', recipient: 'a@x.io', status: 'failed',
      metadata: { idempotencyKey: 'secret' } }], total: 1, page: 1, pageSize: 20, totalPages: 1 }) };
    const controller = new Controller(history as never);
    expect(Reflect.getMetadata(PATH_METADATA, Controller)).toBe('management/email-logs');
    expect(await required(Controller, controller, 'list')).toEqual(['mail:query']);
    const page = await controller.list({ to: 'a@x', status: 'failed', template: 'welcome', pageSize: '1000' }) as { data: object[] };
    expect(history.list).toHaveBeenCalledWith({ recipient: 'a@x', status: 'failed', template: 'welcome', userId: undefined, page: 1, pageSize: 100 });
    expect(JSON.stringify(page)).not.toContain('secret');
    expect(page.data[0]).toMatchObject({ id: 'm', recipient: 'a@x.io', subject: null });
    await expect(controller.list({ status: 'queued' })).rejects.toThrow('Invalid status');
    await expect(controller.list({ to: ['a'] })).rejects.toThrow('Invalid to');
  });
});
