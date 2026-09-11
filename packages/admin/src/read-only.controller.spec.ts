import { describe, expect, it, vi } from 'vitest';
import { createReadOnlyAdminController } from './read-only.controller';

describe('read-only admin records', () => {
  function setup() {
    const model = {
      findMany: vi.fn().mockResolvedValue([{ id: 'one' }]),
      count: vi.fn().mockResolvedValue(301),
      findUnique: vi.fn(),
    };
    const database = { model: vi.fn(() => model) };
    const Controller = createReadOnlyAdminController({
      path: 'records',
      model: 'entries',
      resource: { id: 'records', name: 'Records' },
      filters: ['userId', 'state'],
      enumFilters: { state: ['pending', 'done'] },
      orderBy: { updatedAt: 'desc' },
    });
    const controller = new Controller(database) as {
      findAll(query: Record<string, unknown>): Promise<unknown>;
      findOne(id: string): unknown;
    };
    return { Controller, controller, database, model };
  }
  it('uses database paging and only explicitly allowed equality filters', async () => {
    const { controller, model, database } = setup();
    expect(
      await controller.findAll({
        userId: 'reader',
        state: 'pending',
        page: '2',
        pageSize: '300',
        password: 'hidden',
        model: 'users',
      }),
    ).toEqual({ data: [{ id: 'one' }], total: 301, page: 2, pageSize: 100 });
    expect(database.model).toHaveBeenCalledWith('entries');
    expect(model.findMany).toHaveBeenCalledWith({
      where: { userId: 'reader', state: 'pending' },
      skip: 100,
      take: 100,
      orderBy: { updatedAt: 'desc' },
    });
  });
  it('does not forward operator objects or invalid enum values', async () => {
    const { controller, model } = setup();
    await expect(controller.findAll({ userId: { not: 'reader' } })).rejects.toThrow(
      'Invalid userId',
    );
    await expect(controller.findAll({ state: 'unknown' })).rejects.toThrow('Invalid state');
    await expect(controller.findAll({ page: ['1', '2'] })).rejects.toThrow('Invalid page');
    await expect(controller.findAll({ filters: '{invalid' })).rejects.toThrow('Invalid filters');
    await expect(
      controller.findAll({ filters: JSON.stringify({ userId$ne: 'reader' }) }),
    ).rejects.toThrow('equality');
    expect(model.findMany).not.toHaveBeenCalled();
  });
  it('accepts the Framework frontend equality-filter encoding and record ID lookup', async () => {
    const { controller, model } = setup();
    await controller.findAll({
      filters: JSON.stringify({ userId$eq: 'reader', id$eq: 'one' }),
      page: '2',
      pageSize: '10',
    });
    expect(model.findMany).toHaveBeenCalledWith({
      where: { id: 'one', userId: 'reader' },
      skip: 10,
      take: 10,
      orderBy: { updatedAt: 'desc' },
    });
  });
  it('provides record lookup without any write methods', () => {
    const { controller, model, Controller } = setup();
    controller.findOne('one');
    expect(model.findUnique).toHaveBeenCalledWith({ where: { id: 'one' } });
    expect(Object.getOwnPropertyNames(Controller.prototype)).toEqual([
      'constructor',
      'findAll',
      'findOne',
    ]);
  });
});
