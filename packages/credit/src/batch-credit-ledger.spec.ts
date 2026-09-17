import { BatchCreditLedger } from './batch-credit-ledger';
import type { BatchCreditLedgerOptions } from './batch-credit-ledger';

/** Port-level contracts only; these fakes do not prove database isolation. */
function fixture() {
  const tx = { identity: 'transaction' };
  const models = {
    lots: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    balances: { upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue({ balance: 10 }), update: vi.fn().mockResolvedValue({ balance: 3 }) },
    transactions: { create: vi.fn().mockResolvedValue({ id: 'transaction' }) },
    consumptions: { create: vi.fn().mockResolvedValue({ id: 'consumption' }) },
    allocations: { createMany: vi.fn() },
  };
  const scan = { findMany: vi.fn().mockResolvedValue([]) };
  const lockAccount = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn().mockResolvedValue({ claimed: true });
  const resolveModels = vi.fn().mockReturnValue(models);
  const options: BatchCreditLedgerOptions<typeof tx> = {
    accountField: 'owner', transactionLotsField: 'lotIds', allocationLotField: 'lotId',
    models: resolveModels, scanLots: () => scan, transaction: (work) => work(tx), lockAccount, prepare,
  };
  return { models, scan, tx, lockAccount, prepare, resolveModels, ledger: new BatchCreditLedger(options) };
}

describe('transaction-bound credit lots', () => {
  it('does not touch ledger/balance records when the existing operation receipt was replayed', async () => {
    const f = fixture(); f.prepare.mockResolvedValue({ claimed: false });
    expect(await f.ledger.grant(f.tx, { accountId: 'a', amount: 10, source: 'issued',
      transactionData: { type: 'deposit' }, operation: { idempotencyKey: 'key', accountId: 'a',
        operationType: 'grant', amount: 10, resourceType: 'grant' } })).toBe(false);
    expect(f.resolveModels).not.toHaveBeenCalled();
  });
  it('writes the lot, balance and before/after journal on the supplied transaction', async () => {
    const f = fixture();
    await f.ledger.grant(f.tx, { accountId: 'a', amount: 4, source: 'issued', transactionData: { type: 'deposit' } });
    expect(f.lockAccount).toHaveBeenCalledWith(f.tx, 'a');
    expect(f.resolveModels).toHaveBeenCalledWith(f.tx);
    expect(f.models.lots.create).toHaveBeenCalledWith({ data: expect.objectContaining({ owner: 'a', amount: 4, remainingAmount: 4 }) });
    expect(f.models.transactions.create).toHaveBeenCalledWith({ data: expect.objectContaining({ owner: 'a', amount: 4, balanceBefore: 6, balanceAfter: 10 }) });
  });
  it('never widens allowed sources to satisfy a preference and records FIFO splits', async () => {
    const f = fixture(); const expiry = new Date('2030-01-01');
    f.models.lots.findMany.mockResolvedValue([
      { id: 'l1', source: 'allowed', sourceId: 'origin-1', remainingAmount: 3, expiresAt: expiry },
      { id: 'l2', source: 'allowed', sourceId: 'origin-2', remainingAmount: 7, expiresAt: null },
    ]);
    expect(await f.ledger.consume(f.tx, { accountId: 'a', amount: 7, allowedSources: ['allowed'],
      preferredSource: 'excluded', transactionData: { type: 'consume' }, consumptionData: { resourceType: 'feature' } }))
      .toEqual({ transactionId: 'transaction', consumptionId: 'consumption', consumedSource: 'allowed' });
    expect(f.models.lots.findMany).toHaveBeenCalledTimes(1);
    expect(f.models.lots.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ source: { in: ['allowed'] } }) }));
    expect(f.models.lots.update.mock.calls).toEqual([
      [{ where: { id: 'l1' }, data: { remainingAmount: 0 } }], [{ where: { id: 'l2' }, data: { remainingAmount: 3 } }],
    ]);
    expect(f.models.allocations.createMany).toHaveBeenCalledWith({ data: [
      { consumptionId: 'consumption', lotId: 'l1', source: 'allowed', sourceId: 'origin-1', amount: 3, expiresAt: expiry },
      { consumptionId: 'consumption', lotId: 'l2', source: 'allowed', sourceId: 'origin-2', amount: 4, expiresAt: null },
    ] });
    expect(f.models.transactions.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: -7, balanceBefore: 10, balanceAfter: 3, lotIds: ['l1', 'l2'] }) });
  });
  it('does not partially spend when eligible lots are insufficient', async () => {
    const f = fixture();
    await expect(f.ledger.consume(f.tx, { accountId: 'a', amount: 1,
      transactionData: {}, consumptionData: {} })).rejects.toMatchObject({ required: 1, available: 0 });
    expect(f.models.lots.update).not.toHaveBeenCalled();
    expect(f.models.balances.update).not.toHaveBeenCalled();
  });
  it('expires only the remainder re-read after acquiring the account lock', async () => {
    const f = fixture();
    f.scan.findMany.mockResolvedValue([{ id: 'lot', owner: 'a', remainingAmount: 100 }]);
    f.models.lots.findFirst.mockResolvedValue({ id: 'lot', owner: 'a', remainingAmount: 2 });
    expect(await f.ledger.expire({ type: 'expire' })).toBe(2);
    expect(f.models.balances.update).toHaveBeenCalledWith({ where: { owner: 'a' }, data: { balance: { decrement: 2 } } });
    expect(f.lockAccount.mock.invocationCallOrder[0]).toBeLessThan(f.models.lots.findFirst.mock.invocationCallOrder[0]);
    f.models.lots.findFirst.mockResolvedValue(null);
    f.models.balances.update.mockClear();
    expect(await f.ledger.expire({ type: 'expire' })).toBe(0);
    expect(f.models.balances.update).not.toHaveBeenCalled();
  });
  it('propagates an allocation write failure so the owning transaction can roll back the entire consumption', async () => {
    const f = fixture();
    f.models.lots.findMany.mockResolvedValue([{ id: 'lot', source: 'issued', remainingAmount: 10, sourceId: null, expiresAt: null }]);
    f.models.allocations.createMany.mockRejectedValue(new Error('allocation write failed'));
    await expect(f.ledger.consume(f.tx, { accountId: 'a', amount: 1,
      transactionData: {}, consumptionData: {} })).rejects.toThrow('allocation write failed');
  });
});

it('revokes only selected owned unused lots, journals once, and never creates consumption allocations', async () => {
  const f = fixture();
  f.models.lots.findMany.mockResolvedValueOnce([{ id: 'lot', source: 'issued', sourceId: 'purchase', remainingAmount: 3, expiresAt: null }]).mockResolvedValueOnce([]);
  f.models.balances.update.mockResolvedValue({ balance: 7 });
  const request = { accountId: 'a', lotIds: ['lot'], transactionData: { type: 'revoke' } };
  expect(await f.ledger.revokeUnused(f.tx, request)).toBe(3);
  expect(await f.ledger.revokeUnused(f.tx, request)).toBe(0);
  expect(f.models.lots.findMany).toHaveBeenCalledWith({ where: { owner: 'a', id: { in: ['lot'] }, isExpired: false, remainingAmount: { gt: 0 } } });
  expect(f.lockAccount.mock.invocationCallOrder[0]).toBeLessThan(f.models.lots.findMany.mock.invocationCallOrder[0]);
  expect(f.models.lots.update).toHaveBeenCalledWith({ where: { id: 'lot' }, data: { remainingAmount: 0, isExpired: true } });
  expect(f.models.transactions.create).toHaveBeenCalledTimes(1);
  expect(f.models.transactions.create).toHaveBeenCalledWith({ data: { type: 'revoke', owner: 'a', amount: -3, balanceBefore: 10, balanceAfter: 7, lotIds: ['lot'] } });
  expect(f.models.allocations.createMany).not.toHaveBeenCalled();
});
