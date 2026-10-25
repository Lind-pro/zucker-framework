import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  CreditHoldMigrationRequiredError,
  CreditLotHoldError,
  PostgresCreditOperationCoordinator,
} from '@zucker-framework/credit';
import { ApplicationDatabase } from '../database';
import { readRefundCreditBlocks } from './refund-credit-blocks';

export interface CreditPageOptions {
  page: number;
  pageSize: number;
  type?: string;
}
const transactionTypes = new Set([
  'GRANT',
  'CONSUME',
  'REFUND',
  'EXPIRE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'FREEZE',
  'UNFREEZE',
]);
export function creditPageOptions(
  query: Record<string, unknown>,
  allowType: boolean,
): CreditPageOptions {
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', ...(allowType ? ['type'] : [])].includes(key),
    )
  )
    throw new BadRequestException('Unsupported credit query');
  const page = Number(query.page ?? 1),
    pageSize = Number(query.pageSize ?? 20);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (query.type !== undefined &&
      (typeof query.type !== 'string' || !transactionTypes.has(query.type)))
  )
    throw new BadRequestException('Invalid credit pagination or type');
  return { page, pageSize, ...(typeof query.type === 'string' ? { type: query.type } : {}) };
}
function amount(value: number | string | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error('Credit aggregate is outside the supported range');
  return result;
}
interface BalanceRow {
  balance: number;
  frozen: number;
  eligible: number | string | bigint;
  pendingExpiry: number | string | bigint;
  expired: number | string | bigint;
  activeHeld: number | string | bigint;
  dueHeld: number | string | bigint;
  invalidHeld: number | string | bigint;
}
interface JournalRow {
  id: string;
  type: string;
  amount: number;
  balance: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  ledgerIds: string[];
  description: string | null;
  orderId: string | null;
  createdAt: Date;
  metadata: unknown;
  frozenBalanceBefore: number | null;
  frozenBalanceAfter: number | null;
}
interface LotRow {
  id: string;
  source: string;
  sourceId: string | null;
  amount: number;
  remainingAmount: number;
  isExpired: boolean;
  expiresAt: Date | null;
  description: string | null;
  createdAt: Date;
}

export async function readCreditBalance(database: ApplicationDatabase, ownerId: string) {
  return database.transaction(async (tx) => {
    await new PostgresCreditOperationCoordinator().lockAccount(tx, ownerId);
    const now = new Date();
    const result = await tx.query<BalanceRow>(
      `
    SELECT COALESCE(account.balance,0) AS balance, COALESCE(account."frozenBalance",0) AS frozen,
      COALESCE((SELECT SUM("remainingAmount") FROM credit_lots WHERE "userId"=$1 AND NOT "isExpired"
        AND ("expiresAt" IS NULL OR "expiresAt">$2)),0) AS eligible,
      COALESCE((SELECT SUM("remainingAmount") FROM credit_lots WHERE "userId"=$1 AND NOT "isExpired" AND "expiresAt"<=$2),0) AS "pendingExpiry",
      COALESCE((SELECT SUM(allocation."activeAmount") FROM credit_hold_allocations AS allocation JOIN credit_holds AS hold ON hold.id=allocation."holdId"
        WHERE hold."accountId"=$1),0) AS "activeHeld",
      COALESCE((SELECT SUM(allocation."activeAmount") FROM credit_hold_allocations AS allocation JOIN credit_holds AS hold ON hold.id=allocation."holdId"
        JOIN credit_lots AS lot ON lot.id=allocation."creditLotId" WHERE hold."accountId"=$1 AND NOT lot."isExpired" AND lot."expiresAt"<=$2),0) AS "dueHeld",
      COALESCE((SELECT SUM(allocation."activeAmount") FROM credit_hold_allocations AS allocation JOIN credit_holds AS hold ON hold.id=allocation."holdId"
        JOIN credit_lots AS lot ON lot.id=allocation."creditLotId" WHERE hold."accountId"=$1
        AND (lot."isExpired" OR lot."userId"<>hold."accountId" OR hold.status<>'HELD')),0) AS "invalidHeld",
      COALESCE((SELECT SUM(-amount::bigint) FROM credit_transaction WHERE "userId"=$1 AND type='EXPIRE' AND amount<0),0) AS expired
    FROM (SELECT 1) AS singleton LEFT JOIN credit_account AS account ON account."userId"=$1`,
      [ownerId, now],
    );
    const row = result.rows[0],
      eligible = amount(row.eligible),
      pendingExpiry = amount(row.pendingExpiry),
      activeHeld = amount(row.activeHeld),
      dueHeld = amount(row.dueHeld);
    if (row.frozen !== activeHeld) throw new CreditHoldMigrationRequiredError();
    if (
      amount(row.invalidHeld) ||
      row.balance < 0 ||
      row.frozen < 0 ||
      dueHeld > pendingExpiry ||
      dueHeld > row.frozen ||
      row.balance + row.frozen !== eligible + pendingExpiry
    )
      throw new CreditLotHoldError(
        'invariant',
        'Credit account and lot allocations require reconciliation',
      );
    const blocked = await readRefundCreditBlocks(tx, ownerId, now);
    const refundBlocked = amount([...blocked.values()].reduce((sum, value) => sum + value, 0));
    const frozen = row.frozen - dueHeld,
      available = eligible - frozen - refundBlocked;
    if (available < 0)
      throw new CreditLotHoldError('invariant', 'Held credits exceed eligible lot value');
    return {
      available,
      frozen,
      refundBlocked,
      expired: amount(amount(row.expired) + pendingExpiry),
      bookBalance: row.balance,
      bookFrozenBalance: row.frozen,
      pendingExpiry,
      asOf: now,
    };
  });
}

/** Read-only account projections over the same canonical lots and journal used by billing. */
@Injectable()
export class CreditsService {
  constructor(@Inject(DATABASE_ADAPTER) readonly database: ApplicationDatabase) {}
  balance(ownerId: string) {
    return readCreditBalance(this.database, ownerId);
  }
  async transactions(ownerId: string, options: CreditPageOptions) {
    const where = { userId: ownerId, ...(options.type ? { type: options.type } : {}) };
    return this.database.transaction(async (tx) => {
      const rows = (await tx
        .model('creditTransaction')
        .findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (options.page - 1) * options.pageSize,
          take: options.pageSize,
          select: {
            id: true,
            type: true,
            amount: true,
            balance: true,
            balanceBefore: true,
            balanceAfter: true,
            ledgerIds: true,
            description: true,
            orderId: true,
            createdAt: true,
            metadata: true,
            frozenBalanceBefore: true,
            frozenBalanceAfter: true,
          },
        })) as JournalRow[];
      const total = await tx.model('creditTransaction').count({ where });
      return {
        data: rows.map((row) => ({
          ...row,
          metadata: undefined,
          references: this.references(row.metadata),
        })),
        total,
        ...options,
      };
    });
  }
  async lots(ownerId: string, options: CreditPageOptions) {
    const where = { userId: ownerId };
    return this.database.transaction(async (tx) => {
      await new PostgresCreditOperationCoordinator().lockAccount(tx, ownerId);
      const now = new Date();
      const allocationCheck = await tx.query<{ frozen: number; held: number | string | bigint }>(
        `
        SELECT COALESCE((SELECT "frozenBalance" FROM credit_account WHERE "userId"=$1),0) AS frozen,
          COALESCE((SELECT SUM(allocation."activeAmount") FROM credit_hold_allocations AS allocation
            JOIN credit_holds AS hold ON hold.id=allocation."holdId" WHERE hold."accountId"=$1),0) AS held`,
        [ownerId],
      );
      if (allocationCheck.rows[0].frozen !== amount(allocationCheck.rows[0].held))
        throw new CreditHoldMigrationRequiredError();
      const rows = (await tx
        .model('creditLots')
        .findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (options.page - 1) * options.pageSize,
          take: options.pageSize,
          select: {
            id: true,
            source: true,
            sourceId: true,
            amount: true,
            remainingAmount: true,
            expiresAt: true,
            description: true,
            isExpired: true,
            createdAt: true,
          },
        })) as LotRow[];
      const total = await tx.model('creditLots').count({ where });
      const held = rows.length
        ? (
            await tx.query<{ lotId: string; amount: number | string | bigint }>(
              `
        SELECT allocation."creditLotId" AS "lotId", SUM(allocation."activeAmount") AS amount FROM credit_hold_allocations AS allocation
        JOIN credit_holds AS hold ON hold.id=allocation."holdId" WHERE hold."accountId"=$1 AND allocation."creditLotId"=ANY($2::text[])
        GROUP BY allocation."creditLotId"`,
              [ownerId, rows.map((row) => row.id)],
            )
          ).rows
        : [];
      const frozenByLot = new Map(held.map((row) => [row.lotId, amount(row.amount)]));
      const blocked = await readRefundCreditBlocks(tx, ownerId, now);
      return {
        data: rows.map((row) => {
          const expired = row.isExpired || (!!row.expiresAt && row.expiresAt <= now);
          const frozenAmount = expired ? 0 : (frozenByLot.get(row.id) ?? 0);
          if (frozenAmount > row.remainingAmount) throw new CreditLotHoldError('invariant');
          const refundBlockedAmount = expired ? 0 : (blocked.get(row.id) ?? 0);
          return {
            ...row,
            status: expired
              ? 'expired'
              : row.remainingAmount === 0
                ? 'consumed'
                : blocked.has(row.id)
                  ? 'refund_pending'
                  : frozenAmount === row.remainingAmount
                    ? 'held'
                    : 'available',
            frozenAmount,
            refundBlockedAmount,
            availableAmount: expired ? 0 : row.remainingAmount - frozenAmount - refundBlockedAmount,
          };
        }),
        total,
        ...options,
      };
    });
  }
  private references(metadata: unknown): Record<string, string> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
    return Object.fromEntries(
      Object.entries(metadata).filter(
        ([key, value]) =>
          [
            'source',
            'sourceId',
            'subscriptionId',
            'reservationId',
            'taskId',
            'resourceType',
            'resourceId',
            'holdId',
            'refundId',
          ].includes(key) && typeof value === 'string',
      ),
    );
  }
}
