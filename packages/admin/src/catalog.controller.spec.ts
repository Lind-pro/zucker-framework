// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { DynamicQueryService } from '@zucker-framework/crud';
import { createCatalogAdminController } from './catalog.controller';
function harness() {
  const model = {
    create: vi.fn(async ({ data }) => ({ id: 'record', ...data })),
    update: vi.fn(async ({ data }) => ({ id: 'record', ...data })),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findUnique: vi.fn().mockResolvedValue(null),
  };
  const Controller = createCatalogAdminController({
    path: 'catalog',
    model: 'records',
    resource: { id: 'catalog', name: 'Catalog' },
    createFields: {
      content: { type: 'string', required: true },
      priority: { type: 'number', default: 50 },
    },
    updateFields: { content: { type: 'string' } },
    where: () => ({ active: true }),
    orderBy: { createdAt: 'desc' },
    softDeleteField: 'active',
    createAction: 'create',
  });
  return {
    model,
    controller: new Controller(
      { model: () => model } as unknown as DatabaseAdapter,
      {} as DynamicQueryService,
    ),
  };
}
describe('configured persistent catalog', () => {
  it('uses the shared CRUD service for allowlisted writes and soft deletion', async () => {
    const { model, controller } = harness();
    expect(await controller.create({ content: 'Template', priority: 0 })).toMatchObject({
      priority: 0,
    });
    expect(() => controller.create({ content: 'Template', userId: 'other' })).toThrow();
    await controller.remove('record');
    expect(model.update).toHaveBeenCalledWith({ where: { id: 'record' }, data: { active: false } });
  });
  it('bounds pagination and returns a missing detail as 404', async () => {
    const { model, controller } = harness();
    expect(await controller.list({ page: '2', pageSize: '999' })).toMatchObject({
      page: 2,
      pageSize: 200,
    });
    expect(model.findMany.mock.calls[0][0]).toMatchObject({
      skip: 200,
      take: 200,
      where: { active: true },
    });
    await expect(controller.detail('missing')).rejects.toMatchObject({ status: 404 });
  });
});
