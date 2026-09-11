import type { ModelOperations } from '@zucker-framework/core';
import type { CreditOperationInput } from './postgres-credit-operation-coordinator';

export interface CreditLot<Source extends string = string> {
  id: string;
  source: Source;
  sourceId: string | null;
  remainingAmount: number;
  expiresAt: Date | null;
  [field: string]: unknown;
}
export interface BatchCreditModels<Source extends string = string> {
  lots: Pick<ModelOperations<CreditLot<Source>>, 'findMany' | 'create' | 'update'> & {
    findFirst(args: Record<string, unknown>): Promise<CreditLot<Source> | null>;
  };
  balances: {
    upsert(args: Record<string, unknown>): Promise<unknown>;
    findUnique(args: Record<string, unknown>): Promise<{ balance: number } | null>;
    update(args: Record<string, unknown>): Promise<{ balance: number }>;
  };
  transactions: Pick<ModelOperations<{ id: string }>, 'create'>;
  consumptions: Pick<ModelOperations<{ id: string }>, 'create'>;
  allocations: Pick<ModelOperations, 'createMany'>;
}
export interface BatchCreditLedgerOptions<Tx, Source extends string = string> {
  models(tx: Tx): BatchCreditModels<Source>;
  scanLots(): Pick<BatchCreditModels<Source>['lots'], 'findMany'>;
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Existing coordinator; must acquire the same account lock for every ledger mutation. */
  lockAccount(tx: Tx, accountId: string): Promise<void>;
  prepare(tx: Tx, operation: CreditOperationInput): Promise<{ claimed: boolean }>;
  accountField: string;
  transactionLotsField: string;
  allocationLotField: string;
}
export interface CreditLotGrant<Source extends string = string> {
  accountId: string;
  amount: number;
  source: Source;
  sourceId?: string;
  expiresAt?: Date;
  description?: string;
  operation?: CreditOperationInput;
  /** Consumer supplies transaction type, resource metadata, description and order reference. */
  transactionData: Record<string, unknown>;
}
export interface CreditLotConsumption<Source extends string = string> {
  accountId: string;
  amount: number;
  preferredSource?: Source;
  allowedSources?: readonly Source[];
  transactionData: Record<string, unknown>;
  consumptionData: Record<string, unknown>;
}
export class BatchCreditAmountError extends Error {
  constructor() { super('Credit amount must be a positive 32-bit integer'); this.name = 'BatchCreditAmountError'; }
}
export class BatchCreditInsufficientError extends Error {
  constructor(readonly required: number, readonly available: number) {
    super('Insufficient eligible credit lots'); this.name = 'BatchCreditInsufficientError';
  }
}

/** Transaction-bound lot accounting. Product source/type enums and eligibility stay with the caller. */
export class BatchCreditLedger<Tx, Source extends string = string> {
  constructor(private readonly options: BatchCreditLedgerOptions<Tx, Source>) {}
  private account(accountId: string) { return { [this.options.accountField]: accountId }; }
  private amount(value: number) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new BatchCreditAmountError();
  }

  async grant(tx: Tx, input: CreditLotGrant<Source>): Promise<boolean> {
    this.amount(input.amount);
    if (input.operation) {
      if (input.operation.accountId !== input.accountId || input.operation.amount !== input.amount)
        throw new Error('Credit operation receipt does not match its grant');
      if (!(await this.options.prepare(tx, input.operation)).claimed) return false;
    } else {
      await this.options.lockAccount(tx, input.accountId);
    }
    const models = this.options.models(tx);
    const account = this.account(input.accountId);
    await models.lots.create({ data: { ...account, source: input.source, sourceId: input.sourceId,
      amount: input.amount, remainingAmount: input.amount, expiresAt: input.expiresAt, description: input.description } });
    await models.balances.upsert({ where: account,
      update: { balance: { increment: input.amount } }, create: { ...account, balance: input.amount } });
    const balance = await models.balances.findUnique({ where: account });
    if (!balance) throw new Error('Credit balance missing after grant');
    await models.transactions.create({ data: { ...input.transactionData, ...account,
      amount: input.amount, balanceBefore: balance.balance - input.amount, balanceAfter: balance.balance } });
    return true;
  }

  async consume(tx: Tx, input: CreditLotConsumption<Source>): Promise<{
    transactionId: string; consumptionId: string; consumedSource: Source | null;
  }> {
    this.amount(input.amount);
    await this.options.lockAccount(tx, input.accountId);
    const models = this.options.models(tx);
    const account = this.account(input.accountId);
    const where = { ...account, remainingAmount: { gt: 0 }, isExpired: false,
      ...(input.allowedSources ? { source: { in: input.allowedSources } } : {}),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    // Preference may order eligible lots; it must never widen the eligibility set.
    const preferred = input.preferredSource &&
      (!input.allowedSources || input.allowedSources.includes(input.preferredSource))
      ? input.preferredSource : undefined;
    let lots = preferred ? await models.lots.findMany({
      where: { ...where, source: preferred }, orderBy: { createdAt: 'asc' },
    }) : [];
    if (!preferred || lots.reduce((sum, lot) => sum + lot.remainingAmount, 0) < input.amount) {
      const others = await models.lots.findMany({ where: {
        ...where,
        ...(preferred ? { source: { ...(input.allowedSources ? { in: input.allowedSources } : {}), not: preferred } } : {}),
      }, orderBy: { createdAt: 'asc' } });
      lots = [...lots, ...others];
    }
    const available = lots.reduce((sum, lot) => sum + lot.remainingAmount, 0);
    if (available < input.amount) throw new BatchCreditInsufficientError(input.amount, available);
    let remaining = input.amount;
    const lotIds: string[] = [];
    const allocations: Record<string, unknown>[] = [];
    let consumedSource: Source | null = null;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, lot.remainingAmount);
      await models.lots.update({ where: { id: lot.id }, data: { remainingAmount: lot.remainingAmount - amount } });
      consumedSource ??= lot.source;
      lotIds.push(lot.id);
      allocations.push({ [this.options.allocationLotField]: lot.id, source: lot.source,
        sourceId: lot.sourceId, amount, expiresAt: lot.expiresAt });
      remaining -= amount;
    }
    const balance = await models.balances.update({ where: account, data: { balance: { decrement: input.amount } } });
    const transaction = await models.transactions.create({ data: { ...input.transactionData, ...account,
      amount: -input.amount, balanceBefore: balance.balance + input.amount,
      balanceAfter: balance.balance, [this.options.transactionLotsField]: lotIds } });
    const consumption = await models.consumptions.create({ data: { ...input.consumptionData,
      ...account, amount: input.amount, transactionId: transaction.id } });
    await models.allocations.createMany({ data: allocations.map((allocation) => ({ ...allocation, consumptionId: consumption.id })) });
    return { transactionId: transaction.id, consumptionId: consumption.id, consumedSource };
  }

  async expire(transactionData: Record<string, unknown>, now = new Date()): Promise<number> {
    const expired = { isExpired: false, remainingAmount: { gt: 0 }, expiresAt: { lt: now } };
    const candidates = await this.options.scanLots().findMany({ where: expired });
    let total = 0;
    for (const candidate of candidates) {
      const accountId = candidate[this.options.accountField];
      if (typeof accountId !== 'string' || !accountId) throw new Error('Credit lot has no account identity');
      total += await this.options.transaction(async (tx) => {
        await this.options.lockAccount(tx, accountId);
        const models = this.options.models(tx);
        const account = this.account(accountId);
        // The scan is only a candidate list; concurrent consumption/expiry can change the remaining amount.
        const lot = await models.lots.findFirst({ where: { id: candidate.id, ...account, ...expired } });
        if (!lot) return 0;
        await models.lots.update({ where: { id: lot.id }, data: { isExpired: true } });
        const balance = await models.balances.update({ where: account, data: { balance: { decrement: lot.remainingAmount } } });
        await models.transactions.create({ data: { ...transactionData, ...account,
          amount: -lot.remainingAmount, balanceBefore: balance.balance + lot.remainingAmount,
          balanceAfter: balance.balance, [this.options.transactionLotsField]: [lot.id] } });
        return lot.remainingAmount;
      });
    }
    return total;
  }
}
