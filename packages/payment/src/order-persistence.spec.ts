import { DatabaseOrderPersistence } from './order-persistence';
import type { ModelOperations } from '@zucker-framework/core';

describe('database order persistence', () => {
  it('claims with one conditional update and forces the requested order identity', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const store = new DatabaseOrderPersistence({ updateMany } as unknown as ModelOperations);
    expect(
      await store.compareAndSet(
        'owned',
        { id: 'other', status: 'PENDING', userId: 'owner' },
        { status: 'PAID' },
      ),
    ).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'owned', status: 'PENDING', userId: 'owner' },
      data: { status: 'PAID' },
    });
    expect(await store.compareAndSet('owned', { status: 'PENDING' }, { status: 'PAID' })).toBe(
      false,
    );
  });
  it('preserves native money/date objects and uses only the supplied transaction model', async () => {
    const amount = { toString: () => '12.34' };
    const data = { amount, createdAt: new Date(), status: 'PENDING' };
    const create = vi.fn().mockResolvedValue(data);
    const store = new DatabaseOrderPersistence({ create } as unknown as ModelOperations);
    expect(await store.create({ data })).toBe(data);
    expect(create).toHaveBeenCalledWith({ data });
    expect(vi.mocked(create).mock.calls[0][0].data.amount).toBe(amount);
  });
});
