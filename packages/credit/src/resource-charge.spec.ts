import { describe, expect, it, vi } from 'vitest';
import type { QuotaReservationRecord, QuotaReservationStore } from './quota-reservation';
import { QuotaReservationError } from './quota-reservation';
import { ResourceChargeError, ResourceChargeService, type ResourceChargeInput, type ResourceChargeLookup } from './resource-charge';

interface Row extends QuotaReservationRecord { resourceType: string; resourceId: string }

/** Serialized in-memory transactions with rollback, like the reservation service's own fixture. */
function fixture(options: { capacity?: number } = {}) {
  const tx = Symbol('tx');
  let now = new Date('2026-05-01T00:00:00Z');
  let rows = new Map<string, Row>();
  let used = 0;
  let tail = Promise.resolve();
  let sequence = 0;
  const capacity = options.capacity ?? 10;
  const store: QuotaReservationStore<symbol, Row, ResourceChargeInput> = {
    async transaction(work) {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      const before = new Map([...rows].map(([id, row]) => [id, { ...row }]));
      const usedBefore = used;
      try { return await work(tx); }
      catch (error) { rows = before; used = usedBefore; throw error; }
      finally { unlock(); }
    },
    lock: vi.fn(async () => {}),
    async find(_tx, id) { return rows.get(id) ?? null; },
    assertCapacity: vi.fn(async (_tx, input) => {
      const reserved = [...rows.values()].filter((row) => row.status === 'RESERVED' && row.expiresAt > now)
        .reduce((total, row) => total + row.amount, 0);
      if (used + reserved + input.amount > capacity) throw new Error('capacity exhausted');
    }),
    async insert(_tx, input) {
      const row: Row = { ...input, id: input.id ?? `generated-${++sequence}`, status: 'RESERVED' };
      rows.set(row.id, row);
      return row;
    },
    async transition(_tx, id, from, to, transition) {
      const row = rows.get(id);
      if (!row || row.status !== from || (transition.expiresAfter && row.expiresAt <= transition.expiresAfter)) return false;
      rows.set(id, { ...row, status: to });
      return true;
    },
    charge: vi.fn(async (_tx, row) => { used += row.amount; }),
    async expire(_tx, before) {
      let count = 0;
      for (const [id, row] of rows)
        if (row.status === 'RESERVED' && row.expiresAt < before) { rows.set(id, { ...row, status: 'EXPIRED' }); count++; }
      return count;
    },
  };
  const same = (row: Row, query: Parameters<ResourceChargeLookup<symbol>['findActiveCharge']>[1]) =>
    row.subjectId === query.subjectId && row.counter === query.counter && row.resourceType === query.resourceType
    && row.resourceId === query.resourceId;
  const lookup: ResourceChargeLookup<symbol> = {
    findActiveCharge: vi.fn(async (token, query) => {
      expect(token).toBe(tx);
      const row = [...rows.values()].find((value) => same(value, query) && value.id !== query.exceptReservationId
        && (value.status === 'CONFIRMED' || (value.status === 'RESERVED' && value.expiresAt > query.now)));
      return row ? (row.status as 'CONFIRMED' | 'RESERVED') : null;
    }),
    expireStale: vi.fn(async (token, query) => {
      expect(token).toBe(tx);
      let count = 0;
      for (const [id, row] of rows)
        if (same(row, query) && row.status === 'RESERVED' && row.expiresAt <= query.now) { rows.set(id, { ...row, status: 'EXPIRED' }); count++; }
      return count;
    }),
  };
  // Mirrors the storage key that PostgreSQL enforces: one RESERVED/CONFIRMED row per resource and counter.
  const insert = store.insert;
  store.insert = async (current, input) => {
    if ([...rows.values()].some((row) => same(row, { ...input, now }) && (row.status === 'RESERVED' || row.status === 'CONFIRMED')))
      throw new Error('unique violation');
    return insert(current, input);
  };
  const onReleaseError = vi.fn();
  const onConfirmError = vi.fn();
  const service = new ResourceChargeService(store, lookup, { now: () => now, onReleaseError, onConfirmError });
  const input = (patch: Partial<ResourceChargeInput> = {}): ResourceChargeInput => ({
    subjectId: 'user-1', counter: 'projects', amount: 1, resourceType: 'project', resourceId: 'p-1',
    expiresAt: new Date(now.getTime() + 60_000), ...patch,
  });
  return { service, store, lookup, input, onReleaseError, onConfirmError, tx, rows: () => rows, used: () => used,
    setNow: (value: Date) => { now = value; }, now: () => now };
}

describe('ResourceChargeService', () => {
  it('charges the first successful use and makes later uses of the resource free', async () => {
    const f = fixture();
    const work = vi.fn(async (charge) => charge.free);
    expect(await f.service.run(f.input({ id: 'run-1' }), work)).toBe(false);
    expect(f.used()).toBe(1);
    expect(f.rows().get('run-1')?.status).toBe('CONFIRMED');
    expect(await f.service.run(f.input({ id: 'run-2' }), work)).toBe(true);
    expect(await f.service.isCharged({ subjectId: 'user-1', counter: 'projects', resourceType: 'project', resourceId: 'p-1' })).toBe(true);
    expect(f.used()).toBe(1);
    expect(f.rows().has('run-2')).toBe(false);
    // Another resource is charged separately.
    await f.service.run(f.input({ id: 'run-3', resourceId: 'p-2' }), work);
    expect(f.used()).toBe(2);
  });

  it('rejects a second use while the first is reserved, and charges again after a release', async () => {
    const f = fixture();
    const first = await f.service.begin(f.input({ id: 'a' }));
    expect(first.free).toBe(false);
    // Not free: if the first use failed and released, this use would otherwise never be charged.
    const second = f.service.begin(f.input({ id: 'b' }));
    await expect(second).rejects.toBeInstanceOf(ResourceChargeError);
    await expect(second).rejects.toMatchObject({ reason: 'in_progress' });
    expect(f.rows().has('b')).toBe(false);
    expect(await f.service.fail(first, 'failed')).toBe(true);
    expect(f.rows().get('a')?.status).toBe('RELEASED');
    expect(await f.service.isCharged({ subjectId: 'user-1', counter: 'projects', resourceType: 'project', resourceId: 'p-1' })).toBe(false);
    const retry = await f.service.begin(f.input({ id: 'c' }));
    expect(retry.free).toBe(false);
    expect(await f.service.complete(retry)).toBe(true);
    expect(f.used()).toBe(1);
  });

  it('expires an unswept stale reservation of the resource before charging it again', async () => {
    const f = fixture();
    await f.service.begin(f.input({ id: 'a' }));
    f.setNow(new Date(f.now().getTime() + 120_000));
    // Without expireStale the storage key would still be occupied and the insert would fail.
    const next = await f.service.begin(f.input({ id: 'b', expiresAt: new Date(f.now().getTime() + 60_000) }));
    expect(next.free).toBe(false);
    expect(f.rows().get('a')?.status).toBe('EXPIRED');
    expect(f.lookup.expireStale).toHaveBeenCalledWith(f.tx, expect.objectContaining({ counter: 'projects', resourceId: 'p-1' }));
  });

  it('charges one resource once per counter, not once overall', async () => {
    const f = fixture();
    expect(await f.service.run(f.input({ id: 'project' }), async (charge) => charge.free)).toBe(false);
    // The same project on another counter (for example exports) is charged on that counter.
    expect(await f.service.run(f.input({ id: 'export', counter: 'exports' }), async (charge) => charge.free)).toBe(false);
    expect(await f.service.run(f.input({ id: 'export-2', counter: 'exports' }), async (charge) => charge.free)).toBe(true);
    expect(f.used()).toBe(2);
  });

  it('rejects a reused reservation ID that names another resource', async () => {
    const f = fixture();
    const first = await f.service.begin(f.input({ id: 'shared' }));
    await f.service.complete(first);
    await expect(f.service.begin(f.input({ id: 'shared', resourceId: 'p-2' }))).rejects.toMatchObject({ reason: 'conflict' });
  });

  it('returns the work result when confirmation fails after the work succeeded', async () => {
    const f = fixture();
    const result = await f.service.run(f.input({ id: 'late' }), async () => {
      // The work outlives the reservation TTL; the resource exists but cannot be charged now.
      f.setNow(new Date(f.now().getTime() + 120_000));
      return 'created';
    });
    expect(result).toBe('created');
    expect(f.onConfirmError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'inactive' }), 'late');
    expect(f.used()).toBe(0);
  });

  it('joins a caller transaction instead of opening one', async () => {
    const f = fixture();
    const open = vi.spyOn(f.store, 'transaction');
    expect(await f.service.run(f.input({ id: 'joined' }), async (charge) => charge.free, { tx: f.tx })).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(f.rows().get('joined')?.status).toBe('CONFIRMED');
    expect(await f.service.isCharged({ subjectId: 'user-1', counter: 'projects', resourceType: 'project', resourceId: 'p-1' }, { tx: f.tx })).toBe(true);
  });

  it('retries with the same reservation id reuse it, and a confirmed id stays free', async () => {
    const f = fixture();
    const first = await f.service.begin(f.input({ id: 'stable' }));
    const again = await f.service.begin(f.input({ id: 'stable' }));
    expect(again.reservation?.id).toBe('stable');
    expect(f.lookup.findActiveCharge).toHaveBeenCalledTimes(1); // existing ID short-circuits before capacity
    await f.service.complete(first);
    expect(await f.service.begin(f.input({ id: 'stable' }))).toEqual({ reservation: null, free: true });
    expect(f.used()).toBe(1);
  });

  it('releases on failure, rethrows the work error and reports release failures', async () => {
    const f = fixture();
    await expect(f.service.run(f.input({ id: 'x' }), async () => { throw new Error('model failed'); })).rejects.toThrow('model failed');
    expect(f.rows().get('x')?.status).toBe('RELEASED');
    expect(f.used()).toBe(0);

    const broken = fixture();
    broken.store.transition = vi.fn(async () => { throw new Error('db down'); });
    await expect(broken.service.run(broken.input({ id: 'y' }), async () => { throw new Error('work'); })).rejects.toThrow('work');
    expect(broken.onReleaseError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), 'y');
  });

  it('free uses neither confirm nor release', async () => {
    const f = fixture();
    expect(await f.service.complete({ reservation: null, free: true })).toBe(false);
    expect(await f.service.fail({ reservation: null, free: true })).toBe(false);
    expect(f.store.charge).not.toHaveBeenCalled();
  });

  it('propagates capacity and validation failures without writing', async () => {
    const f = fixture({ capacity: 0 });
    await expect(f.service.begin(f.input({ id: 'z' }))).rejects.toThrow('capacity exhausted');
    expect(f.rows().size).toBe(0);
    await expect(f.service.begin(f.input({ resourceId: ' ' }))).rejects.toThrow('resourceId');
    await expect(f.service.begin(f.input({ resourceType: undefined as unknown as string }))).rejects.toThrow('resourceType');
    await expect(f.service.begin(f.input({ amount: 0 }))).rejects.toBeInstanceOf(QuotaReservationError);
  });

  it('serializes concurrent first uses so one resource is charged once', async () => {
    const f = fixture();
    const results = await Promise.allSettled(['a', 'b', 'c'].map((id) => f.service.run(f.input({ id }), async (charge) => charge.free)));
    const charged = results.filter((result) => result.status === 'fulfilled' && result.value === false);
    expect(charged).toHaveLength(1);
    // The others were either free (after the confirmation) or told to retry (while it was reserved).
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ reason: 'in_progress' });
    expect(f.used()).toBe(1);
  });

  it('propagates lookup failures and rolls back', async () => {
    const f = fixture();
    f.lookup.findActiveCharge = vi.fn(async () => { throw new Error('lookup failed'); });
    await expect(f.service.begin(f.input({ id: 'q' }))).rejects.toThrow('lookup failed');
    expect(f.rows().size).toBe(0);
  });
});
