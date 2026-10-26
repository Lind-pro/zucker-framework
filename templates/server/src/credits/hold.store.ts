import { CreditLotHoldError } from '@zucker-framework/credit';
import type { CreditLotHoldAllocation, CreditLotHoldRecord, CreditLotHoldStore } from '@zucker-framework/credit';
import type { ApplicationTransaction } from '../database';

interface HoldRow extends Omit<CreditLotHoldRecord, 'resourceId' | 'settledAt'> { resourceId: string | null; settledAt: Date | null }
interface AllocationRow extends Omit<CreditLotHoldAllocation, 'lotId' | 'expiredAt'> { creditLotId: string; expiredAt: Date | null; holdStatus?: string; lotOwner?: string; holdOwner?: string }
function allocation(row: AllocationRow): CreditLotHoldAllocation {
  if (row.holdStatus !== undefined && row.holdStatus !== 'HELD') throw new CreditLotHoldError('invariant', 'A settled credit hold still has active allocations');
  if (row.lotOwner !== undefined && row.lotOwner !== row.holdOwner) throw new CreditLotHoldError('invariant', 'Credit hold allocation ownership differs from its lot');
  return { holdId: row.holdId, lotId: row.creditLotId, amount: row.amount, activeAmount: row.activeAmount,
    expiredAmount: row.expiredAmount, revokedAmount: row.revokedAmount, releasedAmount: row.releasedAmount, expiredAt: row.expiredAt ?? undefined };
}
const data = (row: CreditLotHoldAllocation) => ({ holdId: row.holdId, creditLotId: row.lotId, amount: row.amount,
  activeAmount: row.activeAmount, expiredAmount: row.expiredAmount, revokedAmount: row.revokedAmount,
  releasedAmount: row.releasedAmount, expiredAt: row.expiredAt ?? null });

/** Consumer-owned persistence only; state/allocation accounting stays in BatchCreditLedger. */
export function createCreditHoldStore(): CreditLotHoldStore<ApplicationTransaction> {
  return {
    find: async (tx, id) => {
      const row = await tx.model('creditHolds').findUnique({ where: { id } }) as HoldRow | null;
      return row ? { ...row, resourceId: row.resourceId ?? undefined, settledAt: row.settledAt ?? undefined } : null;
    },
    create: async (tx, hold, allocations) => {
      await tx.model('creditHolds').create({ data: { ...hold, selectedLotIds: [...hold.selectedLotIds] } });
      await tx.model('creditHoldAllocations').createMany({ data: allocations.map(data) });
    },
    allocations: async (tx, holdId) => (await tx.model('creditHoldAllocations').findMany({ where: { holdId }, orderBy: { creditLotId: 'asc' } }) as AllocationRow[]).map(allocation),
    activeAllocations: async (tx, accountId) => (await tx.query<AllocationRow>(`
      SELECT allocation.*, hold.status AS "holdStatus", hold."accountId" AS "holdOwner", lot."userId" AS "lotOwner" FROM credit_hold_allocations AS allocation
      JOIN credit_holds AS hold ON hold.id=allocation."holdId"
      JOIN credit_lots AS lot ON lot.id=allocation."creditLotId"
      WHERE hold."accountId"=$1 AND allocation."activeAmount">0`, [accountId])).rows.map(allocation),
    updateAllocation: async (tx, previous, next) => {
      const fields = data(next);
      return (await tx.model('creditHoldAllocations').updateMany({ where: data(previous), data: {
        activeAmount: fields.activeAmount, expiredAmount: fields.expiredAmount, revokedAmount: fields.revokedAmount,
        releasedAmount: fields.releasedAmount, expiredAt: fields.expiredAt,
      } })).count === 1;
    },
    settle: async (tx, id, status, at) => (await tx.model('creditHolds').updateMany({ where: { id, status: 'HELD' }, data: { status, settledAt: at } })).count === 1,
  };
}
