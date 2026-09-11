import { describe, expect, it, vi } from 'vitest';
import { BaseService } from './base.service';
import type { HttpClient } from './http-client';

describe('client CRUD contracts', () => {
  it('maps filters, date ranges and pagination to the shared query transport', async () => {
    const get = vi.fn(async (_url: string) => ({ data: [{ id: 'item' }], total: 1 }));
    const service = new BaseService({
      httpClient: { get } as unknown as HttpClient,
      apiPath: '/records',
      operatorMap: { name: 'like' },
    });
    await expect(
      service.getAll({
        current: 2,
        pageSize: 5,
        name: 'sample',
        createTimeStart: '2026-01-01',
        createTimeEnd: '2026-02-01',
      }),
    ).resolves.toEqual({ data: [{ id: 'item' }], total: 1, success: true });
    const url = new URL(get.mock.calls[0][0], 'https://example.test');
    expect(url.searchParams.get('page')).toBe('2');
    expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({
      name$like: 'sample',
      createTime$between: ['2026-01-01', '2026-02-01'],
    });
  });
  it('removes configured read-only fields without mutating the input and preserves PATCH routing', async () => {
    const patch = vi.fn(async () => ({ id: 'item', name: 'new' }));
    const service = new BaseService<{ id: string; name: string; createdAt: string }>({
      httpClient: { patch } as unknown as HttpClient,
      apiPath: '/records',
      readOnlyFields: ['createdAt'],
    });
    const input = { id: 'item', name: 'new', createdAt: '2026-01-01' };
    await service.update(input);
    expect(patch).toHaveBeenCalledWith('/records/item', { id: 'item', name: 'new' });
    expect(input.createdAt).toBe('2026-01-01');
  });
});
