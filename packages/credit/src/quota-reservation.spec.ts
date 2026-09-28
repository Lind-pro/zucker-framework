import { describe, it, expect, vi } from 'vitest';
import {
  QuotaReservationService, type QuotaReservationRecord, type QuotaReservationInput,
  type QuotaReservationStore,
} from './quota-reservation';

interface Record extends QuotaReservationRecord { period: string }
interface Input extends QuotaReservationInput { period: string }
function fixture() {
  const tx = Symbol('synthetic transaction');
  let now = new Date('2026-09-30T23:59:00Z');
  let rows = new Map<string, Record>();
  let charges: { period: string; amount: number }[] = [];
  let tail = Promise.resolve();
  const store: QuotaReservationStore<symbol, Record, Input> = {
    async transaction(work) {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>(resolve => { unlock = resolve; });
      await previous;
      const before = new Map([...rows].map(([id, row]) => [id, { ...row }]));
      const beforeCharges = [...charges];
      try { return await work(tx); }
      catch (error) { rows = before; charges = beforeCharges; throw error; }
      finally { unlock(); }
    },
    lock: vi.fn(async token => { expect(token).toBe(tx); }),
    async find(token, id) { expect(token).toBe(tx); return rows.get(id) ?? null; },
    assertCapacity: vi.fn(async token => { expect(token).toBe(tx); }),
    async insert(token, input) {
      expect(token).toBe(tx);
      const row: Record = { ...input, id: input.id ?? 'generated-id', status: 'RESERVED' };
      rows.set(row.id, row); return row;
    },
    async transition(token, id, from, to, options) {
      expect(token).toBe(tx);
      const row = rows.get(id);
      if (!row || row.status !== from || (options.expiresAfter && row.expiresAt <= options.expiresAfter)) return false;
      rows.set(id, { ...row, status: to }); return true;
    },
    charge: vi.fn(async (token, row) => { expect(token).toBe(tx); charges.push({ period: row.period, amount: row.amount }); }),
    async expire(token, before) {
      expect(token).toBe(tx);
      let count = 0;
      for (const [id, row] of rows) {
        if (row.status === 'RESERVED' && row.expiresAt < before) {
          rows.set(id, { ...row, status: 'EXPIRED' }); count++;
        }
      }
      return count;
    },
  };
  const service = new QuotaReservationService(store, () => now);
  const input: Input = { id: 'job-1', subjectId: 'account', counter: 'reports', amount: 1,
    expiresAt: new Date('2026-10-01T00:10:00Z'), period: '2026-09' };
  return { service, store, input, rows: () => rows, charges: () => charges, setNow: (value: string) => { now = new Date(value); } };
}

describe('durable quota reservations (synthetic transactional port)', () => {
  it('reuses a stable id without reserving twice and rejects different identities', async () => {
    const f = fixture();
    await f.service.reserve(f.input);
    await f.service.reserve(f.input);
    expect(f.store.assertCapacity).toHaveBeenCalledTimes(1);
    for (const changes of [{ subjectId: 'other' }, { counter: 'other' }, { amount: 2 }]) {
      await expect(f.service.reserve({ ...f.input, ...changes })).rejects.toMatchObject({ reason: 'conflict' });
    }
    expect(f.rows().size).toBe(1);
  });

  it('charges the captured period only once under repeated concurrent confirmations', async () => {
    const f = fixture(); await f.service.reserve(f.input);
    f.setNow('2026-10-01T00:01:00Z');
    expect(await Promise.all([f.service.confirm('job-1'), f.service.confirm('job-1')])).toEqual([true, false]);
    expect(f.charges()).toEqual([{ period: '2026-09', amount: 1 }]);
    expect(await f.service.release('job-1')).toBe(false);
    expect((await f.service.reserve(f.input)).status).toBe('CONFIRMED');
  });

  it('rolls back the claimed state when the charge fails, allowing recovery', async () => {
    const f = fixture(); await f.service.reserve(f.input);
    vi.spyOn(f.store, 'charge').mockRejectedValueOnce(new Error('synthetic charge failure'));
    await expect(f.service.confirm('job-1')).rejects.toThrow('synthetic charge failure');
    expect(f.rows().get('job-1')?.status).toBe('RESERVED');
    expect(f.charges()).toEqual([]);
    expect(await f.service.confirm('job-1')).toBe(true);
  });

  it('releases once, cannot confirm released records, and never charges', async () => {
    const f = fixture(); await f.service.reserve(f.input);
    expect(await f.service.release('job-1', 'task failed')).toBe(true);
    expect(await f.service.release('job-1')).toBe(false);
    await expect(f.service.confirm('job-1')).rejects.toMatchObject({ reason: 'inactive' });
    await expect(f.service.reserve(f.input)).rejects.toMatchObject({ reason: 'inactive' });
    expect(f.charges()).toEqual([]);
  });

  it('rejects expired confirmations and expires only pending records', async () => {
    const f = fixture(); await f.service.reserve(f.input);
    await f.service.reserve({ ...f.input, id: 'job-2' }); await f.service.confirm('job-2');
    f.setNow('2026-10-01T00:11:00Z');
    await expect(f.service.confirm('job-1')).rejects.toMatchObject({ reason: 'inactive' });
    expect(await f.service.expire()).toBe(1);
    expect(await f.service.expire()).toBe(0);
    expect(f.rows().get('job-2')?.status).toBe('CONFIRMED');
    expect(f.charges()).toHaveLength(1);
  });

  it('rejects expiry reached while waiting for a reservation lock', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'lock').mockImplementation(async () => { f.setNow('2026-10-01T00:11:00Z'); });
    await expect(f.service.reserve(f.input)).rejects.toMatchObject({ reason: 'inactive' });
    expect(f.rows().size).toBe(0);
  });

  it('refreshes state after locking instead of charging a stale read', async () => {
    const f = fixture(); await f.service.reserve(f.input);
    vi.spyOn(f.store, 'lock').mockImplementation(async () => {
      const row = f.rows().get('job-1')!;
      f.rows().set('job-1', { ...row, status: 'RELEASED' });
    });
    await expect(f.service.confirm('job-1')).rejects.toMatchObject({ reason: 'inactive' });
    expect(f.charges()).toEqual([]);
  });

  it('honors CAS failure when expiry races confirmation', async () => {
    const f = fixture(); await f.service.reserve(f.input);
    vi.spyOn(f.store, 'transition').mockResolvedValueOnce(false);
    await expect(f.service.confirm('job-1')).rejects.toMatchObject({ reason: 'inactive' });
    expect(f.charges()).toEqual([]);
  });

  it('does not create reservations when entitlement/capacity rejects', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'assertCapacity').mockRejectedValueOnce(new Error('synthetic quota exceeded'));
    await expect(f.service.reserve(f.input)).rejects.toThrow('synthetic quota exceeded');
    expect(f.rows().size).toBe(0);
  });

  it('rejects malformed inputs and missing records', async () => {
    const f = fixture();
    for (const amount of [0, -1, 0.5, NaN]) {
      await expect(f.service.reserve({ ...f.input, amount })).rejects.toMatchObject({ reason: 'invalid' });
    }
    await expect(f.service.reserve({ ...f.input, expiresAt: new Date('invalid') })).rejects.toMatchObject({ reason: 'invalid' });
    await expect(f.service.confirm('missing')).rejects.toMatchObject({ reason: 'not_found' });
    await expect(f.service.release('missing')).rejects.toMatchObject({ reason: 'not_found' });
  });
});
