import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { PermissionService, PermissionSyncService } from '@zucker-framework/auth';
import { PermissionsController } from './permissions.controller';

function fixture() {
  const create = vi.fn(async ({ data }) => data), update = vi.fn(async ({ data }) => data);
  const findUnique = vi.fn(async () => ({ id: 'sample:read', name: 'Sample', actions: [] }));
  const model = vi.fn(() => ({ create, update, findUnique }));
  const invalidatePermissionCache = vi.fn();
  const controller = new PermissionsController(
    { invalidatePermissionCache } as unknown as PermissionService,
    {} as PermissionSyncService, { model } as unknown as DatabaseAdapter,
  );
  return { controller, model, create, update, invalidatePermissionCache };
}

describe('permission definition input contract', () => {
  it('persists supported metadata and preserves an unchanged identifier on edit', async () => {
    const f = fixture();
    await f.controller.create({ id: 'sample:read', name: 'Sample', description: 'Display metadata', actions: [{ action: 'read', name: 'Read' }] });
    expect(f.create).toHaveBeenCalledWith({ data: { id: 'sample:read', name: 'Sample', description: 'Display metadata', actions: [{ action: 'read', name: 'Read' }], status: true } });
    await f.controller.update('sample:read', { id: 'sample:read', name: 'Renamed', properties: { color: 'blue' } });
    expect(f.update).toHaveBeenCalledWith({ where: { id: 'sample:read' }, data: { name: 'Renamed', properties: { color: 'blue' } } });
  });

  it('reports a duplicate permission code as 409 instead of a server error', async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(f.controller.create({ id: 'sample:read', name: 'Sample' })).rejects.toBeInstanceOf(ConflictException);
    expect(f.invalidatePermissionCache).not.toHaveBeenCalled();
  });

  it('rejects unsupported fields before invoking persistence', async () => {
    const f = fixture();
    await expect(f.controller.create({ id: 'sample:read', name: 'Sample', unsupported: {} })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.controller.update('sample:read', { name: 'Sample', unsupported: {} })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.model).not.toHaveBeenCalled(); expect(f.invalidatePermissionCache).not.toHaveBeenCalled();
  });

  it('rejects malformed metadata and changed identifiers without writing', async () => {
    const f = fixture();
    for (const body of [null, {}, { id: '', name: 'Sample' }, { id: 'sample:read', name: '' }, { id: 'sample:read', name: 'Sample', status: 'enabled' }])
      await expect(f.controller.create(body)).rejects.toBeInstanceOf(BadRequestException);
    for (const body of [{ id: 'different', name: 'Sample' }, { name: '' }, { actions: 'read' }, { properties: [] }])
      await expect(f.controller.update('sample:read', body)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.model).not.toHaveBeenCalled();
  });
});
