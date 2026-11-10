import { describe, expect, it, vi } from 'vitest';
import { BatchCreditLedger, type BatchCreditModels, type CreditLot } from './batch-credit-ledger';
import { CreditHoldMigrationRequiredError, CreditLotHeldError, type CreditLotHoldAllocation, type CreditLotHoldRecord, type CreditLotHoldStore } from './credit-lot-hold';

/** State-machine/port checks only; template tests prove the actual PostgreSQL transaction contract. */
function fixture() {
  const tx = { id: 'caller-transaction' }, wallet = { balance: 10, frozenBalance: 0 };
  const lot: CreditLot = { id: 'lot', owner: 'a', source: 'issued', sourceId: 'receipt', remainingAmount: 10, expiresAt: new Date('2030-01-01'), isExpired: false };
  const holds = new Map<string, CreditLotHoldRecord>(), allocations = new Map<string, CreditLotHoldAllocation>();
  const journals: Record<string, unknown>[] = [];
  const models = {
    lots: { findMany: vi.fn(async () => [lot]), findFirst: vi.fn(async (args: Record<string, unknown>) => {
      const where = args.where as { id: string; isExpired?: boolean; expiresAt?: { lte: Date } };
      return where.id === lot.id && (!where.expiresAt || (!!lot.expiresAt && lot.expiresAt <= where.expiresAt.lte)) && lot.isExpired !== true ? lot : null;
    }), create: vi.fn(), update: vi.fn(async (args: Record<string, unknown>) => { Object.assign(lot, args.data); return lot; }) },
    balances: { upsert: vi.fn(), findUnique: vi.fn(async () => ({ ...wallet })), update: vi.fn(async (args: Record<string, unknown>) => {
      const data = args.data as Record<string, { increment?: number; decrement?: number }>;
      for (const field of ['balance', 'frozenBalance'] as const) wallet[field] += (data[field]?.increment ?? 0) - (data[field]?.decrement ?? 0);
      return { ...wallet };
    }) },
    transactions: { create: vi.fn(async (args: Record<string, unknown>) => { journals.push(args.data as Record<string, unknown>); return { id: `journal-${journals.length}` }; }) },
    consumptions: { create: vi.fn(async () => ({ id: 'consumption' })) }, allocations: { createMany: vi.fn() },
  } satisfies BatchCreditModels;
  const store: CreditLotHoldStore<typeof tx> = {
    find: async (_tx, id) => holds.get(id) ?? null,
    create: async (token, hold, rows) => { expect(token).toBe(tx); holds.set(hold.id, hold); rows.forEach(row => allocations.set(`${row.holdId}:${row.lotId}`, row)); },
    allocations: async (_tx, id) => [...allocations.values()].filter(row => row.holdId === id),
    activeAllocations: async (_tx, accountId) => [...allocations.values()].filter(row => holds.get(row.holdId)?.accountId === accountId && row.activeAmount > 0),
    updateAllocation: async (token, previous, next) => { expect(token).toBe(tx); const key = `${previous.holdId}:${previous.lotId}`;
      if (allocations.get(key) !== previous) return false; allocations.set(key, next); return true; },
    settle: async (token, id, status, settledAt) => { expect(token).toBe(tx); const current = holds.get(id);
      if (!current || current.status !== 'HELD') return false; holds.set(id, { ...current, status, settledAt }); return true; },
  };
  const lock = vi.fn(async () => {});
  const ledger = new BatchCreditLedger({ accountField: 'owner', transactionLotsField: 'lots', allocationLotField: 'lotId',
    models: token => { expect(token).toBe(tx); return models; }, scanLots: () => models.lots, transaction: work => work(tx),
    lockAccount: lock, prepare: async () => ({ claimed: true }), holds: store });
  const reserve = () => ledger.hold(tx, { id: 'hold', accountId: 'a', amount: 6, lotIds: ['lot'], resourceType: 'refund-request', resourceId: 'request', operationKey: 'reserve', transactionData: { type: 'FREEZE' } }, new Date('2026-01-01'));
  const settle = (type: 'confirm' | 'release', now = new Date('2026-01-01')) => ledger[type === 'confirm' ? 'confirmHold' : 'releaseHold'](tx,
    { id: 'hold', accountId: 'a', operationKey: type, transactionData: { type: type === 'confirm' ? 'REVOKE' : 'UNFREEZE' } }, now);
  return { tx, wallet, lot, journals, store, ledger, lock, models, reserve, settle };
}

describe('transaction-bound credit lot holds', () => {
  it('replays a hold without resourceId when the store maps the absent id to null (L13)', async () => {
    const f = fixture();
    const input = { id: 'hold', accountId: 'a', amount: 6, lotIds: ['lot'], resourceType: 'refund-request', operationKey: 'reserve', transactionData: { type: 'FREEZE' } };
    await f.ledger.hold(f.tx, input, new Date('2026-01-01'));
    const stored = await f.store.find(f.tx, 'hold');
    Object.assign(stored!, { resourceId: null });
    await expect(f.ledger.hold(f.tx, input, new Date('2026-01-01'))).resolves.toMatchObject({ changed: false });
  });
  it('excludes exact held allocations from consumption and only revokes the held remainder', async () => {
    const f = fixture(); expect((await f.reserve()).hold).toMatchObject({ amount: 6, activeAmount: 6 }); expect(f.wallet).toEqual({ balance: 4, frozenBalance: 6 });
    await f.ledger.consume(f.tx, { accountId: 'a', amount: 4, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'operation' } });
    await expect(f.ledger.consume(f.tx, { accountId: 'a', amount: 1, transactionData: {}, consumptionData: {} })).rejects.toMatchObject({ available: 0 });
    expect((await f.settle('confirm')).hold).toMatchObject({ amount: 6, activeAmount: 0, revokedAmount: 6, expiredAmount: 0 });
    expect(f.wallet).toEqual({ balance: 0, frozenBalance: 0 }); expect(f.lot.remainingAmount).toBe(0);
    expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.models.balances.findUnique.mock.invocationCallOrder[0]);
  });
  it('releases once and never applies the opposite terminal decision', async () => {
    const f = fixture(); await f.reserve(); expect((await f.settle('release')).hold.releasedAmount).toBe(6);
    expect(await f.settle('release')).toMatchObject({ changed: false }); expect(f.wallet).toEqual({ balance: 10, frozenBalance: 0 });
    await expect(f.settle('confirm')).rejects.toMatchObject({ reason: 'conflict' }); expect(f.journals).toHaveLength(2);
  });
  it('expires held and free parts together before a late release without resurrecting either', async () => {
    const f = fixture(); await f.reserve(); const result = await f.settle('release', new Date('2031-01-01'));
    expect(result.hold).toMatchObject({ amount: 6, activeAmount: 0, expiredAmount: 6, releasedAmount: 0 });
    expect(f.wallet).toEqual({ balance: 0, frozenBalance: 0 }); expect(f.lot).toMatchObject({ isExpired: true, remainingAmount: 10 });
    expect(f.journals.find(row => row.type === 'EXPIRE')).toMatchObject({ amount: -10, balanceBefore: 4, balanceAfter: 0, frozenBalanceBefore: 6, frozenBalanceAfter: 0 });
  });
  it('rejects unallocated legacy freezing and protects held lots from unrelated revocation', async () => {
    const f = fixture(); f.wallet.balance = 7; f.wallet.frozenBalance = 3;
    await expect(f.reserve()).rejects.toBeInstanceOf(CreditHoldMigrationRequiredError); expect(f.journals).toHaveLength(0);
    f.wallet.balance = 10; f.wallet.frozenBalance = 0; await f.reserve();
    await expect(f.ledger.revokeUnused(f.tx, { accountId: 'a', lotIds: ['lot'], transactionData: {} })).rejects.toBeInstanceOf(CreditLotHeldError);
    expect(f.wallet).toEqual({ balance: 4, frozenBalance: 6 });
  });
});
