import { describe, expect, it } from 'vitest';
import { withActiveRecordWhere } from '../index';
import { InMemoryAdapter } from '../in-memory-adapter';

describe('public active-record fence', () => {
  it('preserves unique keys, ownership, version and conflicting filters without mutating input', async () => {
    const db = new InMemoryAdapter();
    const deletedAt = new Date(10);
    const where = Object.freeze({ id: 'deleted', ownerId: 'u1', updatedAt: new Date(1), deletedAt: { not: null }, AND: [{ name: 'same' }] });
    await db.model('items').create({ data: { ...where, deletedAt, name: 'same' } });
    const scoped = withActiveRecordWhere(where);
    expect(scoped.id).toBe('deleted');
    expect(scoped.AND).toEqual([where, { deletedAt: null }]);
    expect(await db.model('items').findMany({ where: scoped })).toEqual([]);
    expect(where.deletedAt).toEqual({ not: null });
  });
});
