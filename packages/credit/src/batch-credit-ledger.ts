import type { ModelOperations } from '@zucker-framework/core';
import type { CreditOperationInput } from './postgres-credit-operation-coordinator';
import { CreditHoldMigrationRequiredError, CreditLotHeldError, CreditLotHoldError } from './credit-lot-hold';
import type { CreateCreditLotHold, CreditLotHold, CreditLotHoldAllocation, CreditLotHoldRecord, CreditLotHoldResult,
  CreditLotHoldStore, SettleCreditLotHold } from './credit-lot-hold';

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
    findUnique(args: Record<string, unknown>): Promise<{ balance: number; frozenBalance?: number } | null>;
    update(args: Record<string, unknown>): Promise<{ balance: number; frozenBalance?: number }>;
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
  /** Opt-in persistent wallet holds. Existing callers without this port retain their behavior. */
  holds?: CreditLotHoldStore<Tx>;
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

  /** Reserve an exact integer amount from selected owned lots. The caller owns the transaction. */
  async hold(tx: Tx, input: CreateCreditLotHold, now?: Date): Promise<CreditLotHoldResult> {
    const requestedAt = now === undefined ? undefined : this.holdTime(now);
    const command = { ...input, transactionData: { ...input.transactionData }, lotIds: [...new Set(input.lotIds)].sort() };
    this.holdIdentifier(command.id); this.holdIdentifier(command.accountId); this.holdIdentifier(command.operationKey, 200);
    this.holdIdentifier(command.resourceType, 64); if (command.resourceId !== undefined) this.holdIdentifier(command.resourceId);
    this.amount(command.amount); command.lotIds.forEach(id => this.holdIdentifier(id));
    if (!command.lotIds.length) throw new CreditLotHoldError('invalid');
    const store = this.holdStore();
    await this.options.lockAccount(tx, command.accountId);
    const at = requestedAt ?? new Date();
    const existing = await store.find(tx, command.id);
    if (existing && (existing.accountId !== command.accountId || existing.amount !== command.amount
      || existing.resourceType !== command.resourceType || (existing.resourceId ?? undefined) !== command.resourceId
      || JSON.stringify([...existing.selectedLotIds].sort()) !== JSON.stringify(command.lotIds)))
      throw new CreditLotHoldError('conflict');
    const prepared = await this.holdReceipt(tx, command, 'CREATE', command.amount);
    if (existing) return { hold: await this.holdView(tx, existing), changed: false };
    if (!prepared.claimed) throw new CreditLotHoldError('invariant', 'Credit hold receipt has no matching hold');
    const models = this.options.models(tx), wallet = await this.holdWallet(tx, command.accountId, models);
    const selected = await models.lots.findMany({ where: { ...this.account(command.accountId), id: { in: command.lotIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (selected.length !== command.lotIds.length) throw new CreditLotHoldError('not_found');
    const lots = selected.filter(lot => !lot.isExpired && lot.remainingAmount > 0 && (!lot.expiresAt || lot.expiresAt > at));
    const available = lots.reduce((sum, lot) => sum + this.unheld(lot, wallet.allocations), 0);
    if (available < command.amount) throw new BatchCreditInsufficientError(command.amount, available);
    if (wallet.balance < command.amount) throw new CreditLotHoldError('invariant', 'Credit account and lots disagree');
    let remaining = command.amount;
    const allocations: CreditLotHoldAllocation[] = [];
    for (const lot of lots) {
      const allocated = Math.min(remaining, this.unheld(lot, wallet.allocations));
      if (allocated) allocations.push({ holdId: command.id, lotId: lot.id, amount: allocated, activeAmount: allocated,
        expiredAmount: 0, revokedAmount: 0, releasedAmount: 0 });
      remaining -= allocated; if (!remaining) break;
    }
    const hold: CreditLotHoldRecord = { id: command.id, accountId: command.accountId, amount: command.amount, status: 'HELD',
      resourceType: command.resourceType, resourceId: command.resourceId, selectedLotIds: command.lotIds, createdAt: at };
    await store.create(tx, hold, allocations);
    const balance = await models.balances.update({ where: this.account(command.accountId), data: {
      balance: { decrement: command.amount }, frozenBalance: { increment: command.amount } } });
    await models.transactions.create({ data: { ...command.transactionData, ...this.account(command.accountId), amount: -command.amount,
      balanceBefore: wallet.balance, balanceAfter: balance.balance, frozenBalanceBefore: wallet.frozenBalance,
      frozenBalanceAfter: balance.frozenBalance, [this.options.transactionLotsField]: allocations.map(allocation => allocation.lotId) } });
    return { hold: await this.holdView(tx, hold), changed: true };
  }

  confirmHold(tx: Tx, input: SettleCreditLotHold, now?: Date): Promise<CreditLotHoldResult> {
    return this.settleHold(tx, input, 'CONFIRMED', now);
  }
  releaseHold(tx: Tx, input: SettleCreditLotHold, now?: Date): Promise<CreditLotHoldResult> {
    return this.settleHold(tx, input, 'RELEASED', now);
  }

  private async settleHold(tx: Tx, input: SettleCreditLotHold, status: 'CONFIRMED' | 'RELEASED', now?: Date): Promise<CreditLotHoldResult> {
    const requestedAt = now === undefined ? undefined : this.holdTime(now);
    const command = { ...input, transactionData: { ...input.transactionData },
      expiryTransactionData: { ...(input.expiryTransactionData ?? { type: 'EXPIRE' }) } };
    this.holdIdentifier(command.id); this.holdIdentifier(command.accountId); this.holdIdentifier(command.operationKey, 200);
    const store = this.holdStore();
    await this.options.lockAccount(tx, command.accountId);
    const at = requestedAt ?? new Date();
    const hold = await store.find(tx, command.id);
    if (!hold || hold.accountId !== command.accountId) throw new CreditLotHoldError('not_found');
    if (hold.status !== 'HELD' && hold.status !== status) throw new CreditLotHoldError('conflict');
    const prepared = await this.holdReceipt(tx, command, status === 'CONFIRMED' ? 'CONFIRM' : 'RELEASE', hold.amount);
    if (hold.status === status) return { hold: await this.holdView(tx, hold), changed: false };
    if (!prepared.claimed) throw new CreditLotHoldError('invariant', 'Credit hold settlement receipt is incomplete');
    const initial = await this.holdView(tx, hold);
    // A late decision must expire due source lots before it can release or revoke their remaining hold.
    await this.expireInTransaction(tx, { accountId: command.accountId, lotIds: initial.allocations.map(allocation => allocation.lotId),
      transactionData: command.expiryTransactionData }, at);
    const current = await this.holdView(tx, hold), models = this.options.models(tx);
    const wallet = await this.holdWallet(tx, command.accountId, models);
    for (const allocation of current.allocations) {
      if (!allocation.activeAmount) continue;
      const lot = await models.lots.findFirst({ where: { id: allocation.lotId, ...this.account(command.accountId), isExpired: false } });
      if (!lot || lot.remainingAmount < allocation.activeAmount || (lot.expiresAt && lot.expiresAt <= at))
        throw new CreditLotHoldError('invariant', 'Credit hold source lot is unavailable');
      if (status === 'CONFIRMED') await models.lots.update({ where: { id: lot.id },
        data: { remainingAmount: lot.remainingAmount - allocation.activeAmount } });
      await this.updateHoldAllocation(tx, allocation, { ...allocation, activeAmount: 0,
        revokedAmount: allocation.revokedAmount + (status === 'CONFIRMED' ? allocation.activeAmount : 0),
        releasedAmount: allocation.releasedAmount + (status === 'RELEASED' ? allocation.activeAmount : 0) });
    }
    if (wallet.frozenBalance < current.activeAmount) throw new CreditLotHoldError('invariant');
    const balance = await models.balances.update({ where: this.account(command.accountId), data: {
      ...(status === 'RELEASED' ? { balance: { increment: current.activeAmount } } : {}),
      frozenBalance: { decrement: current.activeAmount } } });
    if (!await store.settle(tx, command.id, status, at)) throw new CreditLotHoldError('conflict');
    await models.transactions.create({ data: { ...command.transactionData, ...this.account(command.accountId),
      amount: (status === 'RELEASED' ? 1 : -1) * current.activeAmount,
      balanceBefore: wallet.balance, balanceAfter: balance.balance, frozenBalanceBefore: wallet.frozenBalance,
      frozenBalanceAfter: balance.frozenBalance, [this.options.transactionLotsField]: current.allocations.map(allocation => allocation.lotId) } });
    return { hold: await this.holdView(tx, { ...hold, status, settledAt: at }), changed: true };
  }

  private holdStore(): CreditLotHoldStore<Tx> {
    if (!this.options.holds) throw new CreditLotHoldError('unsupported'); return this.options.holds;
  }
  private holdIdentifier(value: string, maximum = 191): void {
    if (typeof value !== 'string' || !value || value.trim() !== value || value.length > maximum) throw new CreditLotHoldError('invalid');
  }
  private holdTime(now: Date): Date {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new CreditLotHoldError('invalid'); return new Date(now);
  }
  private allocationValid(allocation: CreditLotHoldAllocation): void {
    const values = [allocation.amount, allocation.activeAmount, allocation.expiredAmount, allocation.revokedAmount, allocation.releasedAmount];
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || allocation.amount <= 0
      || allocation.amount !== allocation.activeAmount + allocation.expiredAmount + allocation.revokedAmount + allocation.releasedAmount
      || (allocation.expiredAmount > 0 && (!allocation.expiredAt || !Number.isFinite(allocation.expiredAt.getTime()))))
      throw new CreditLotHoldError('invariant', 'Credit hold allocation does not conserve its original amount');
  }
  private async updateHoldAllocation(tx: Tx, previous: CreditLotHoldAllocation, next: CreditLotHoldAllocation): Promise<void> {
    this.allocationValid(previous); this.allocationValid(next);
    if (!await this.holdStore().updateAllocation(tx, previous, next)) throw new CreditLotHoldError('conflict');
  }
  private async holdView(tx: Tx, record: CreditLotHoldRecord): Promise<CreditLotHold> {
    const allocations = [...await this.holdStore().allocations(tx, record.id)];
    allocations.forEach(allocation => this.allocationValid(allocation));
    const total = (field: 'amount' | 'activeAmount' | 'expiredAmount' | 'revokedAmount' | 'releasedAmount') => allocations.reduce((sum, allocation) => sum + allocation[field], 0);
    if (allocations.some(allocation => allocation.holdId !== record.id) || total('amount') !== record.amount
      || (record.status !== 'HELD' && total('activeAmount') !== 0)) throw new CreditLotHoldError('invariant');
    return { ...record, selectedLotIds: [...record.selectedLotIds], allocations,
      activeAmount: total('activeAmount'), expiredAmount: total('expiredAmount'), revokedAmount: total('revokedAmount'), releasedAmount: total('releasedAmount') };
  }
  private async holdWallet(tx: Tx, accountId: string, models: BatchCreditModels<Source>, allowMissing = false) {
    const account = await models.balances.findUnique({ where: this.account(accountId) });
    const allocations = [...await this.holdStore().activeAllocations(tx, accountId)];
    allocations.forEach(allocation => this.allocationValid(allocation));
    const frozen = allocations.reduce((sum, allocation) => sum + allocation.activeAmount, 0);
    if (!account && !allowMissing) throw new CreditLotHoldError('invariant', 'Credit account is unavailable');
    const balance = account?.balance ?? 0, frozenBalance = account ? account.frozenBalance : 0;
    if (!Number.isSafeInteger(frozenBalance) || frozenBalance !== frozen || allocations.some(allocation => allocation.activeAmount <= 0))
      throw new CreditHoldMigrationRequiredError();
    if (!Number.isSafeInteger(balance) || balance < 0 || frozen < 0 || balance + frozen > 2_147_483_647)
      throw new CreditLotHoldError('invariant', 'Credit wallet is outside the supported non-negative range');
    return { balance, frozenBalance: frozen, allocations };
  }
  private unheld(lot: CreditLot<Source>, allocations?: readonly CreditLotHoldAllocation[]): number {
    const held = allocations?.filter(allocation => allocation.lotId === lot.id).reduce((sum, allocation) => sum + allocation.activeAmount, 0) ?? 0;
    if (held > lot.remainingAmount) throw new CreditLotHoldError('invariant', 'Credit lot has more held value than its remainder');
    return lot.remainingAmount - held;
  }
  private holdReceipt(tx: Tx, input: { id: string; accountId: string; operationKey: string }, action: 'CREATE' | 'CONFIRM' | 'RELEASE', amount: number) {
    return this.options.prepare(tx, { idempotencyKey: input.operationKey, accountId: input.accountId,
      operationType: `CREDIT_HOLD_${action}`, amount, resourceType: 'credit-hold', resourceId: input.id });
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
    if (this.options.holds) {
      const wallet = await this.holdWallet(tx, input.accountId, models, true);
      if (wallet.balance + wallet.frozenBalance + input.amount > 2_147_483_647)
        throw new CreditLotHoldError('invariant', 'Credit wallet exceeds the supported integer range');
    }
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
    const wallet = this.options.holds ? await this.holdWallet(tx, input.accountId, models) : undefined;
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
    if (!preferred || lots.reduce((sum, lot) => sum + this.unheld(lot, wallet?.allocations), 0) < input.amount) {
      const others = await models.lots.findMany({ where: {
        ...where,
        ...(preferred ? { source: { ...(input.allowedSources ? { in: input.allowedSources } : {}), not: preferred } } : {}),
      }, orderBy: { createdAt: 'asc' } });
      lots = [...lots, ...others];
    }
    const available = lots.reduce((sum, lot) => sum + this.unheld(lot, wallet?.allocations), 0);
    if (available < input.amount) throw new BatchCreditInsufficientError(input.amount, available);
    if (wallet && wallet.balance < input.amount) throw new CreditLotHoldError('invariant', 'Credit account and lots disagree');
    let remaining = input.amount;
    const lotIds: string[] = [];
    const allocations: Record<string, unknown>[] = [];
    let consumedSource: Source | null = null;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, this.unheld(lot, wallet?.allocations));
      if (!amount) continue;
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
      balanceAfter: balance.balance, [this.options.transactionLotsField]: lotIds,
      ...(wallet ? { frozenBalanceBefore: wallet.frozenBalance, frozenBalanceAfter: balance.frozenBalance } : {}) } });
    const consumption = await models.consumptions.create({ data: { ...input.consumptionData,
      ...account, amount: input.amount, transactionId: transaction.id } });
    await models.allocations.createMany({ data: allocations.map((allocation) => ({ ...allocation, consumptionId: consumption.id })) });
    return { transactionId: transaction.id, consumptionId: consumption.id, consumedSource };
  }

  /** Revoke only unspent, unexpired lots selected by the caller, on the caller's transaction. */
  async revokeUnused(tx: Tx, input: {
    accountId: string;
    lotIds: readonly string[];
    transactionData: Record<string, unknown>;
  }): Promise<number> {
    if (!input.lotIds.length) return 0;
    await this.options.lockAccount(tx, input.accountId);
    const models = this.options.models(tx);
    const account = this.account(input.accountId);
    const wallet = this.options.holds ? await this.holdWallet(tx, input.accountId, models) : undefined;
    const lots = await models.lots.findMany({ where: {
      ...account, id: { in: [...input.lotIds] }, isExpired: false, remainingAmount: { gt: 0 },
    } });
    const amount = lots.reduce((sum, lot) => sum + lot.remainingAmount, 0);
    if (!amount) return 0;
    if (wallet?.allocations.some(allocation => lots.some(lot => lot.id === allocation.lotId))) throw new CreditLotHeldError();
    if (wallet && wallet.balance < amount) throw new CreditLotHoldError('invariant', 'Credit account and lots disagree');
    for (const lot of lots) {
      await models.lots.update({ where: { id: lot.id }, data: { remainingAmount: 0, isExpired: true } });
    }
    const balance = await models.balances.update({ where: account, data: { balance: { decrement: amount } } });
    await models.transactions.create({ data: { ...input.transactionData, ...account,
      amount: -amount, balanceBefore: balance.balance + amount, balanceAfter: balance.balance,
      [this.options.transactionLotsField]: lots.map(lot => lot.id),
      ...(wallet ? { frozenBalanceBefore: wallet.frozenBalance, frozenBalanceAfter: balance.frozenBalance } : {}),
    } });
    return amount;
  }

  /** Expire selected owned lots inside the caller's transaction, including any task lease fence. */
  async expireInTransaction(tx: Tx, input: {
    accountId: string;
    lotIds: readonly string[];
    transactionData: Record<string, unknown>;
  }, now = new Date()): Promise<number> {
    if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid credit expiry time');
    const command = { accountId: input.accountId, lotIds: [...input.lotIds], transactionData: { ...input.transactionData } };
    const at = new Date(now);
    if (!command.lotIds.length) return 0;
    await this.options.lockAccount(tx, command.accountId);
    const models = this.options.models(tx), account = this.account(command.accountId);
    const wallet = this.options.holds ? await this.holdWallet(tx, command.accountId, models) : undefined;
    let total = 0;
    for (const id of new Set(command.lotIds)) {
      // Selection precedes the transaction in maintenance scans; recheck it under the common account lock.
      const lot = await models.lots.findFirst({ where: { id, ...account,
        isExpired: false, remainingAmount: { gt: 0 }, expiresAt: { lte: at } } });
      if (!lot) continue;
      const held = wallet?.allocations.filter(allocation => allocation.lotId === lot.id) ?? [];
      const frozen = held.reduce((sum, allocation) => sum + allocation.activeAmount, 0);
      const free = lot.remainingAmount - frozen;
      if (free < 0 || (wallet && (wallet.balance < free || wallet.frozenBalance < frozen)))
        throw new CreditLotHoldError('invariant', 'Credit expiry exceeds the accounted remainder');
      for (const allocation of held) await this.updateHoldAllocation(tx, allocation, { ...allocation,
        activeAmount: 0, expiredAmount: allocation.expiredAmount + allocation.activeAmount, expiredAt: at });
      await models.lots.update({ where: { id: lot.id }, data: { isExpired: true } });
      const balance = await models.balances.update({ where: account, data: { balance: { decrement: free },
        ...(wallet ? { frozenBalance: { decrement: frozen } } : {}) } });
      await models.transactions.create({ data: { ...command.transactionData, ...account,
        amount: -lot.remainingAmount, balanceBefore: balance.balance + free,
        balanceAfter: balance.balance, [this.options.transactionLotsField]: [lot.id],
        ...(wallet ? { frozenBalanceBefore: wallet.frozenBalance, frozenBalanceAfter: balance.frozenBalance } : {}) } });
      if (wallet) { wallet.balance -= free; wallet.frozenBalance -= frozen; }
      total += lot.remainingAmount;
    }
    return total;
  }

  /**
   * Expire every due lot. The scan is paged by lot id, and each lot runs in its own transaction:
   * a lot whose account fails (for example a hold that needs migration) does not stop the sweep
   * for later accounts. Failures are collected and thrown together as an `AggregateError` after
   * every other lot was processed.
   */
  async expire(transactionData: Record<string, unknown>, now = new Date()): Promise<number> {
    if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid credit expiry time');
    const expired = { isExpired: false, remainingAmount: { gt: 0 }, expiresAt: { lte: now } };
    const pageSize = 500;
    const errors: unknown[] = [];
    let total = 0;
    let after: string | undefined;
    for (;;) {
      const candidates = await this.options.scanLots().findMany({
        where: after === undefined ? expired : { ...expired, id: { gt: after } },
        orderBy: [{ id: 'asc' }],
        take: pageSize,
      });
      for (const candidate of candidates) {
        try {
          const accountId = candidate[this.options.accountField];
          if (typeof accountId !== 'string' || !accountId) throw new Error(`Credit lot ${candidate.id} has no account identity`);
          total += await this.options.transaction(tx => this.expireInTransaction(tx,
            { accountId, lotIds: [candidate.id], transactionData }, now));
        } catch (error) {
          errors.push(error);
        }
      }
      if (candidates.length < pageSize) break;
      after = candidates[candidates.length - 1].id;
    }
    if (errors.length) throw new AggregateError(errors, `${errors.length} credit lot(s) failed to expire; ${total} credits expired`);
    return total;
  }

}
