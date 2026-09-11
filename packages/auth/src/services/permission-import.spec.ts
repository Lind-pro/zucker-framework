import { PermissionService } from './permission.service';

describe('permission import persistence', () => {
  it('uses native upsert and retains item-level partial failures', async () => {
    const upsert = vi.fn().mockResolvedValueOnce({ id: 'a' }).mockRejectedValueOnce(new Error('invalid row'));
    const findUnique = vi.fn();
    const service = new PermissionService({ model: () => ({ upsert, findUnique }) } as never);
    const result = await service.importPermissions([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
    expect(result).toMatchObject({ total: 2, success: 1, fail: 1 });
    expect(result.results[1]).toEqual({ id: 'b', success: false, message: 'invalid row' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(2);
  });
  it('does not silently replace an unsupported atomic write with find/create', async () => {
    const create = vi.fn();
    const service = new PermissionService({ model: () => ({ create }) } as never);
    expect(await service.importPermissions([{ id: 'a', name: 'A' }])).toMatchObject({ success: 0, fail: 1 });
    expect(create).not.toHaveBeenCalled();
  });
});
