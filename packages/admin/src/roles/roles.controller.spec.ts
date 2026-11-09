import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RolesController } from './roles.controller';

describe('RolesController query', () => {
  it('pages roles in the database in a stable order so a picker never skips or repeats a role', async () => {
    const rows = Array.from({ length: 2 }, (_, index) => ({ id: `role-${index + 2}`, name: `Role ${index + 2}` }));
    const model = { findMany: vi.fn().mockResolvedValue(rows), count: vi.fn().mockResolvedValue(5) };
    const database = { model: vi.fn(() => model) };
    const controller = new RolesController({} as never, database as never, {} as never);
    expect(await controller.query({ pageIndex: 1, pageSize: 2, filter: { status: true } })).toEqual({
      data: rows,
      total: 5,
      pageIndex: 1,
      pageSize: 2,
    });
    expect(database.model).toHaveBeenCalledWith('roles');
    expect(model.findMany).toHaveBeenCalledWith({ where: { status: true }, orderBy: [{ id: 'asc' }], skip: 2, take: 2 });
    expect(model.count).toHaveBeenCalledWith({ where: { status: true } });
    await expect(controller.query({ filter: { OR: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.query({ pageSize: 5000 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
