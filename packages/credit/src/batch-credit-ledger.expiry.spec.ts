import { describe, expect, it, vi } from 'vitest';
import { BatchCreditLedger, compareLotsByExpiry, type BatchCreditLedgerOptions, type CreditLot } from './batch-credit-ledger';

/** Port-level checks of the expiry-first order; PostgreSQL isolation is proved by the template specs. */
function fixture(consumeOrder?: 'fifo' | 'expiry_first') {
  const tx = { id: 'tx' };
  const lots = { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() };
  const models = {
    lots,
    balances: { upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue({ balance: 100 }), update: vi.fn().mockResolvedValue({ balance: 90 }) },
    transactions: { create: vi.fn().mockResolvedValue({ id: 't' }) },
    consumptions: { create: vi.fn().mockResolvedValue({ id: 'c' }) },
    allocations: { createMany: vi.fn() },
  };
  const options: BatchCreditLedgerOptions<typeof tx> = { accountField: 'owner', transactionLotsField: 'lotIds', allocationLotField: 'lotId',
    models: () => models, scanLots: () => lots, transaction: work => work(tx), lockAccount: vi.fn(), prepare: vi.fn().mockResolvedValue({ claimed: true }),
    ...(consumeOrder ? { consumeOrder } : {}) };
  return { models, lots, tx, ledger: new BatchCreditLedger(options) };
}
const lot = (id: string, source: string, remainingAmount: number, expiresAt: Date | null, createdAt?: Date): CreditLot & { createdAt?: Date } =>
  ({ id, source, sourceId: null, remainingAmount, expiresAt, ...(createdAt ? { createdAt } : {}) } as CreditLot & { createdAt?: Date });
const drained = (f: ReturnType<typeof fixture>) => f.lots.update.mock.calls.map(([args]) => args.where.id);
const spend = (f: ReturnType<typeof fixture>, extra: object = {}, amount = 100) =>
  f.ledger.consume(f.tx, { accountId: 'a', amount, transactionData: {}, consumptionData: {}, ...extra });

describe('compareLotsByExpiry tie-breaks', () => {
  const t = new Date('2030-01-01'), c1 = new Date('2026-01-01'), c2 = new Date('2026-01-02');
  it('orders by expiry, never-expiring last, then createdAt, then id', () => {
    const sorted = [lot('z', 's', 1, null, c1), lot('d', 's', 1, t, c2), lot('b', 's', 1, t, c1), lot('a', 's', 1, t, c1), lot('early', 's', 1, new Date('2029-01-01'), c2)]
      .sort(compareLotsByExpiry).map(item => item.id);
    expect(sorted).toEqual(['early', 'a', 'b', 'd', 'z']);
  });
  it('falls back to id when createdAt is missing on either side and accepts ISO strings', () => {
    expect([lot('b', 's', 1, t), lot('a', 's', 1, t, c1)].sort(compareLotsByExpiry).map(item => item.id)).toEqual(['a', 'b']);
    const asString = (id: string, expiresAt: string) => ({ ...lot(id, 's', 1, null), expiresAt: expiresAt as unknown as Date });
    expect([asString('late', '2031-01-01T00:00:00Z'), asString('soon', '2030-01-01T00:00:00Z')].sort(compareLotsByExpiry).map(item => item.id)).toEqual(['soon', 'late']);
  });
  it('is a consistent total order (antisymmetric) for equal keys', () => {
    const a = lot('a', 's', 1, t, c1), b = lot('b', 's', 1, t, c1);
    expect(compareLotsByExpiry(a, b)).toBe(-compareLotsByExpiry(b, a));
    expect(compareLotsByExpiry(a, a)).toBe(0);
  });
});

describe('consume order', () => {
  it('default (fifo) keeps store order and the historical createdAt orderBy even when a later lot expires sooner', async () => {
    const f = fixture();
    f.lots.findMany.mockResolvedValue([lot('old-never', 's', 5, null), lot('new-soon', 's', 5, new Date('2030-01-01'))]);
    await spend(f, {}, 8);
    expect(f.lots.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'asc' } }));
    expect(drained(f)).toEqual(['old-never', 'new-soon']);
  });
  it('explicit fifo equals the default', () => {
    const f = fixture('fifo');
    f.lots.findMany.mockResolvedValue([lot('a', 's', 5, null), lot('b', 's', 5, new Date('2030-01-01'))]);
    return spend(f, {}, 6).then(() => expect(drained(f)).toEqual(['a', 'b']));
  });
  it('expiry_first orders the preferred source group and the remainder group independently', async () => {
    const f = fixture('expiry_first');
    f.lots.findMany.mockImplementation(async (args: { where: { source?: unknown } }) =>
      args.where.source === 'welcome'
        ? [lot('w-never', 'welcome', 2, null), lot('w-soon', 'welcome', 2, new Date('2030-01-01'))]
        : [lot('p-never', 'purchase', 5, null), lot('p-soon', 'purchase', 5, new Date('2030-02-01'))]);
    await spend(f, { preferredSource: 'welcome' }, 8);
    // Preferred (welcome) is insufficient alone (4 < 8), so the rest are drawn after it, each group soonest-expiring first.
    expect(drained(f)).toEqual(['w-soon', 'w-never', 'p-soon']);
  });
  it('a sufficient preferred source is the only group queried', async () => {
    const f = fixture('expiry_first');
    f.lots.findMany.mockResolvedValue([lot('w-never', 'welcome', 9, null), lot('w-soon', 'welcome', 9, new Date('2030-01-01'))]);
    await spend(f, { preferredSource: 'welcome' }, 5);
    expect(f.lots.findMany).toHaveBeenCalledTimes(1);
    expect(drained(f)).toEqual(['w-soon']);
  });
  it('splits a spend across lots in expiry order and records allocations with each lot expiry', async () => {
    const f = fixture('expiry_first'), soon = new Date('2030-01-01');
    f.lots.findMany.mockResolvedValue([lot('never', 's', 10, null), lot('soon', 's', 3, soon)]);
    await spend(f, {}, 5);
    expect(f.lots.update.mock.calls.map(([args]) => [args.where.id, args.data.remainingAmount])).toEqual([['soon', 0], ['never', 8]]);
    expect(f.models.allocations.createMany).toHaveBeenCalledWith({ data: [
      expect.objectContaining({ lotId: 'soon', amount: 3, expiresAt: soon }), expect.objectContaining({ lotId: 'never', amount: 2, expiresAt: null })] });
  });
  it('refuses to partially spend when insufficient, without touching any lot', async () => {
    const f = fixture('expiry_first');
    f.lots.findMany.mockResolvedValue([lot('a', 's', 2, null)]);
    await expect(spend(f, {}, 3)).rejects.toThrow();
    expect(f.lots.update).not.toHaveBeenCalled();
  });
});
