import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, BusinessException, ValidationException } from '@zucker-framework/core';

const DATABASE_ADAPTER = 'DATABASE_ADAPTER';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker-framework/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

/**
 * TopicEventBus topics for credit operations.
 * Uses `/` delimiter to match DefaultTopicEventBus conventions.
 * Subscribers can use wildcards: `system/credit/**`
 */
export const CREDIT_EVENT_TOPICS = {
  GRANTED: 'system/credit/granted',
  CONSUMED: 'system/credit/consumed',
  REFUNDED: 'system/credit/refunded',
  EXPIRED: 'system/credit/expired',
  TRANSFERRED: 'system/credit/transferred',
  FROZEN: 'system/credit/frozen',
  UNFROZEN: 'system/credit/unfrozen',
} as const;

export interface CreditEventPayload {
  type: 'granted' | 'consumed' | 'refunded' | 'expired' | 'transferred' | 'frozen' | 'unfrozen';
  userId: string;
  amount: number;
  balance: number;
  description: string;
  orderId?: string;
  timestamp: Date;
}

export enum CreditTransactionType {
  GRANT = 'GRANT',
  CONSUME = 'CONSUME',
  REFUND = 'REFUND',
  EXPIRE = 'EXPIRE',
  TRANSFER_OUT = 'TRANSFER_OUT',
  TRANSFER_IN = 'TRANSFER_IN',
  FREEZE = 'FREEZE',
  UNFREEZE = 'UNFREEZE',
}

/** Options for querying credit transactions with pagination */
export interface CreditQueryOptions {
  /** Page number (1-based), defaults to 1 */
  page?: number;
  /** Page size, defaults to 20 */
  pageSize?: number;
  /** Filter by transaction type */
  type?: CreditTransactionType;
  /** Start date for filtering */
  startDate?: Date;
  /** End date for filtering */
  endDate?: Date;
}

/** Result of a credit query with pagination metadata */
export interface CreditQueryResult {
  balance: number;
  frozenBalance: number;
  transactions: CreditTransactionRecord[];
  total: number;
  page: number;
  pageSize: number;
  /** 总页数 — 对齐 PaginatedResult<T>.totalPages */
  totalPages: number;
}

/** A typed credit transaction record */
export interface CreditTransactionRecord {
  id: string;
  userId: string;
  type: CreditTransactionType;
  amount: number;
  balance: number;
  description: string;
  expireAt: Date | null;
  orderId: string | null;
  expired: boolean;
  createdAt: Date;
}

/** Internal model representing a credit account row */
interface CreditAccount {
  id: string;
  userId: string;
  balance: number;
  frozenBalance: number;
}

/** Maximum number of expired transactions to process per batch */
const EXPIRE_BATCH_SIZE = 100;
/** Upper bound of batches one `checkExpired()` call walks, so a single run stays bounded. */
const EXPIRE_MAX_BATCHES = 20;

/** Model that stores idempotency receipts (shared with `PostgresCreditOperationCoordinator`). */
const RECEIPT_MODEL = 'creditOperationReceipts';

/** Optional per-call settings for balance mutations. */
export interface CreditOperationOptions {
  /**
   * Caller-chosen key that makes the call idempotent. A retry with the same key and the same
   * parameters is a no-op; a reuse with different parameters is rejected with HTTP 409
   * (`CREDIT_IDEMPOTENCY_CONFLICT`). Requires a `creditOperationReceipts` model
   * (`credit_operation_receipts` table, see `assets/credit-runtime.prisma`). Max 200 characters.
   */
  idempotencyKey?: string;
}

interface ReceiptRow {
  idempotencyKey: string;
  accountId: string;
  operationType: string;
  amount: number;
  resourceType?: string | null;
  resourceId?: string | null;
}

/** Receipts store `amount` in a 32-bit integer column (`assets/credit-runtime.prisma`). */
const MAX_RECEIPT_AMOUNT = 2_147_483_647;
const RECEIPT_RESOURCE_TYPE = 'credit-service';

interface PendingEvent {
  type: CreditEventPayload['type'];
  topic: string;
  userId: string;
  amount: number;
  balance: number;
  description: string;
  orderId?: string;
}

/** Lot used when replaying a ledger to find the unspent part of an expiring grant. */
interface ReplayLot {
  id: string;
  remaining: number;
  /** null = never expires; consumed after every expiring lot. */
  expireAt: number | null;
  order: number;
}

/**
 * Generic credit wallet over `creditAccount` / `creditTransaction`.
 *
 * Concurrency: every balance mutation first takes a row lock on the account (a same-value
 * `updateMany`, which PostgreSQL holds until commit) and only then reads the balance, so
 * concurrent calls for the same account are serialized under READ COMMITTED. Transfers lock both
 * accounts in user-id order to avoid deadlocks. Events are published after commit; a failing
 * event bus is logged and never changes the result of a committed mutation.
 *
 * Lot-level bookkeeping (holds, per-lot expiry, revocation) lives in `BatchCreditLedger`; this
 * service derives the unspent part of an expiring grant by replaying the account ledger
 * (earliest-expiring credits are spent first).
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {}

  async grant(
    userId: string,
    amount: number,
    description: string,
    expireAt?: Date,
    options: CreditOperationOptions = {},
  ): Promise<void> {
    this.validateAmount(amount);
    this.validateUserId(userId);

    if (expireAt !== undefined && expireAt.getTime() <= Date.now()) {
      throw new ValidationException(
        { expireAt: ['过期时间必须晚于当前时间'] },
        '过期时间必须晚于当前时间',
      );
    }

    const event = await this.mutate(userId, 'credit.grant', amount, undefined, options, async (tx, account) => {
      const bal = account.balance + amount;
      await this.writeAccount(tx, account, { balance: bal });
      await this.appendTransaction(tx, {
        userId,
        type: CreditTransactionType.GRANT,
        amount,
        balance: bal,
        description,
        expireAt: expireAt ?? null,
        expired: false,
      });
      return { type: 'granted', topic: CREDIT_EVENT_TOPICS.GRANTED, userId, amount, balance: bal, description };
    });

    await this.publishAll(event ? [event] : []);
    if (event) this.logger.log(`积分发放: userId=${userId}, amount=${amount}`);
  }

  async consume(
    userId: string,
    amount: number,
    description: string,
    orderId?: string,
    options: CreditOperationOptions = {},
  ): Promise<void> {
    this.validateAmount(amount);
    this.validateUserId(userId);

    const event = await this.mutate(userId, 'credit.consume', amount, orderId, options, async (tx, account) => {
      if (account.balance < amount) {
        throw new BusinessException(
          `积分余额不足 (当前: ${account.balance}, 需要: ${amount})`,
          'INSUFFICIENT_CREDIT',
          400,
        );
      }
      const bal = account.balance - amount;
      await this.writeAccount(tx, account, { balance: bal });
      await this.appendTransaction(tx, {
        userId,
        type: CreditTransactionType.CONSUME,
        amount: -amount,
        balance: bal,
        description,
        orderId: orderId ?? null,
      });
      return { type: 'consumed', topic: CREDIT_EVENT_TOPICS.CONSUMED, userId, amount, balance: bal, description, orderId };
    });

    await this.publishAll(event ? [event] : []);
    if (event) this.logger.log(`积分消费: userId=${userId}, amount=${amount}`);
  }

  async refund(
    userId: string,
    amount: number,
    description: string,
    orderId?: string,
    options: CreditOperationOptions = {},
  ): Promise<void> {
    this.validateAmount(amount);
    this.validateUserId(userId);

    const event = await this.mutate(userId, 'credit.refund', amount, orderId, options, async (tx, account) => {
      const bal = account.balance + amount;
      await this.writeAccount(tx, account, { balance: bal });
      await this.appendTransaction(tx, {
        userId,
        type: CreditTransactionType.REFUND,
        amount,
        balance: bal,
        description,
        orderId: orderId ?? null,
      });
      return { type: 'refunded', topic: CREDIT_EVENT_TOPICS.REFUNDED, userId, amount, balance: bal, description, orderId };
    });

    await this.publishAll(event ? [event] : []);
    if (event) this.logger.log(`积分退还: userId=${userId}, amount=${amount}`);
  }

  /** Query balance and paginated transaction history */
  async query(userId: string, options: CreditQueryOptions = {}): Promise<CreditQueryResult> {
    this.validateUserId(userId);

    const { page = 1, pageSize = 20, type, startDate, endDate } = options;

    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));

    const account = (await this.db.model('creditAccount').findUnique({
      where: { userId },
    })) as CreditAccount | null;

    const where: Record<string, unknown> = { userId };
    if (type) where.type = type;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Record<string, unknown>).gte = startDate;
      if (endDate) (where.createdAt as Record<string, unknown>).lte = endDate;
    }

    const [transactions, total] = await Promise.all([
      this.db.model('creditTransaction').findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
      }) as Promise<CreditTransactionRecord[]>,
      this.db.model('creditTransaction').count({ where }),
    ]);

    return {
      balance: account?.balance ?? 0,
      frozenBalance: account?.frozenBalance ?? 0,
      transactions,
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.ceil(total / safePageSize),
    };
  }

  /**
   * Query paginated transaction history across all users (admin use).
   * Supports optional filters: userId, type, startDate, endDate.
   */
  async queryAll(options: CreditQueryOptions & { userId?: string } = {}): Promise<{
    transactions: CreditTransactionRecord[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page = 1, pageSize = 20, type, startDate, endDate, userId } = options;

    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    if (type) where.type = type;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Record<string, unknown>).gte = startDate;
      if (endDate) (where.createdAt as Record<string, unknown>).lte = endDate;
    }

    const [transactions, total] = await Promise.all([
      this.db.model('creditTransaction').findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
      }) as Promise<CreditTransactionRecord[]>,
      this.db.model('creditTransaction').count({ where }),
    ]);

    return {
      transactions,
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.ceil(total / safePageSize),
    };
  }

  /**
   * Count transactions across all users (admin use).
   * Supports optional userId filter.
   */
  async countAll(filter?: { userId?: string }): Promise<number> {
    const where: Record<string, unknown> = {};
    if (filter?.userId) where.userId = filter.userId;
    return this.db.model('creditTransaction').count({ where });
  }

  /** Get only the balance for a user (lightweight query) */
  async getBalance(userId: string): Promise<{ balance: number; frozenBalance: number }> {
    this.validateUserId(userId);

    const account = (await this.db.model('creditAccount').findUnique({
      where: { userId },
    })) as CreditAccount | null;

    return {
      balance: account?.balance ?? 0,
      frozenBalance: account?.frozenBalance ?? 0,
    };
  }

  /**
   * 转账 — 从一个用户转移积分到另一个用户
   */
  async transfer(
    fromUserId: string,
    toUserId: string,
    amount: number,
    description = '积分转账',
  ): Promise<{ fromBalance: number; toBalance: number }> {
    this.validateUserId(fromUserId);
    this.validateUserId(toUserId);
    this.validateAmount(amount);

    if (fromUserId === toUserId) {
      throw new ValidationException({ userId: ['不能向自己转账'] }, '不能向自己转账');
    }

    await this.ensureAccount(fromUserId);
    await this.ensureAccount(toUserId);

    const result = await this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      // Lock both rows in a stable order so opposite transfers cannot deadlock, and read only after
      // both locks are held: under REPEATABLE READ (MySQL) the first read fixes the snapshot, so
      // reading A before waiting for B's lock would see a stale B.
      for (const userId of [fromUserId, toUserId].sort()) {
        await this.lockAccountRow(dbTx, userId);
      }
      const fromAccount = await this.readLockedAccount(dbTx, fromUserId);
      const toAccount = await this.readLockedAccount(dbTx, toUserId);

      if (fromAccount.balance < amount) {
        throw new BusinessException(
          `积分余额不足 (当前: ${fromAccount.balance}, 需要: ${amount})`,
          'INSUFFICIENT_CREDIT',
          400,
        );
      }

      const fromBalance = fromAccount.balance - amount;
      const toBalance = toAccount.balance + amount;

      await this.writeAccount(dbTx, fromAccount, { balance: fromBalance });
      await this.writeAccount(dbTx, toAccount, { balance: toBalance });

      await this.appendTransaction(dbTx, {
        userId: fromUserId,
        type: CreditTransactionType.TRANSFER_OUT,
        amount: -amount,
        balance: fromBalance,
        description: `${description} → ${toUserId}`,
      });
      await this.appendTransaction(dbTx, {
        userId: toUserId,
        type: CreditTransactionType.TRANSFER_IN,
        amount,
        balance: toBalance,
        description: `${description} ← ${fromUserId}`,
      });

      return { fromBalance, toBalance };
    });

    await this.publishAll([{
      type: 'transferred',
      topic: CREDIT_EVENT_TOPICS.TRANSFERRED,
      userId: fromUserId,
      amount,
      balance: result.fromBalance,
      description: `${description} → ${toUserId}`,
    }]);
    this.logger.log(`积分转账: from=${fromUserId}, to=${toUserId}, amount=${amount}`);
    return result;
  }

  /**
   * 冻结积分 — 从可用余额转入冻结余额
   */
  async freeze(
    userId: string,
    amount: number,
    description = '积分冻结',
  ): Promise<{ balance: number; frozenBalance: number }> {
    this.validateUserId(userId);
    this.validateAmount(amount);

    await this.ensureAccount(userId);
    const result = await this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      const account = await this.lockAccount(dbTx, userId);

      if (account.balance < amount) {
        throw new BusinessException(
          `可用余额不足 (当前: ${account.balance}, 需冻结: ${amount})`,
          'INSUFFICIENT_CREDIT',
          400,
        );
      }

      const balance = account.balance - amount;
      const frozenBalance = account.frozenBalance + amount;

      await this.writeAccount(dbTx, account, { balance, frozenBalance });
      await this.appendTransaction(dbTx, {
        userId,
        type: CreditTransactionType.FREEZE,
        amount: -amount,
        balance,
        description,
      });

      return { balance, frozenBalance };
    });

    await this.publishAll([{
      type: 'frozen', topic: CREDIT_EVENT_TOPICS.FROZEN, userId, amount, balance: result.balance, description,
    }]);
    return result;
  }

  /**
   * 解冻积分 — 从冻结余额转回可用余额
   */
  async unfreeze(
    userId: string,
    amount: number,
    description = '积分解冻',
  ): Promise<{ balance: number; frozenBalance: number }> {
    this.validateUserId(userId);
    this.validateAmount(amount);

    await this.ensureAccount(userId);
    const result = await this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      const account = await this.lockAccount(dbTx, userId);

      if (account.frozenBalance < amount) {
        throw new BusinessException(
          `冻结余额不足 (当前: ${account.frozenBalance}, 需解冻: ${amount})`,
          'INSUFFICIENT_FROZEN_CREDIT',
          400,
        );
      }

      const balance = account.balance + amount;
      const frozenBalance = account.frozenBalance - amount;

      await this.writeAccount(dbTx, account, { balance, frozenBalance });
      await this.appendTransaction(dbTx, {
        userId,
        type: CreditTransactionType.UNFREEZE,
        amount,
        balance,
        description,
      });

      return { balance, frozenBalance };
    });

    await this.publishAll([{
      type: 'unfrozen', topic: CREDIT_EVENT_TOPICS.UNFROZEN, userId, amount, balance: result.balance, description,
    }]);
    return result;
  }

  /**
   * Expire due grants. Only the unspent remainder of each grant is removed: the account ledger is
   * replayed with earliest-expiring credits spent first, so credits that never expire (paid
   * top-ups, refunds, transfers, unfreezes) are never taken by an expiry. Due grants are grouped
   * per account: one transaction per account takes the account lock, claims each grant with a
   * conditional `expired: false -> true` update (so concurrent runs cannot expire it twice) and
   * replays the ledger once for all of them. An account that fails is logged and its grants are
   * skipped for the rest of this run; it does not block other accounts.
   *
   * @returns number of grants that actually removed credits in this run
   */
  async checkExpired(): Promise<number> {
    const now = new Date();
    const failed: string[] = [];
    const events: PendingEvent[] = [];
    let count = 0;

    for (let batch = 0; batch < EXPIRE_MAX_BATCHES; batch++) {
      const where: Record<string, unknown> = {
        type: CreditTransactionType.GRANT,
        expireAt: { lte: now },
        expired: false,
      };
      if (failed.length) where.id = { notIn: [...failed] };
      const candidates = (await this.db.model('creditTransaction').findMany({
        where,
        take: EXPIRE_BATCH_SIZE,
        orderBy: [{ expireAt: 'asc' }, { id: 'asc' }],
      })) as CreditTransactionRecord[];
      if (!candidates.length) break;

      const byAccount = new Map<string, CreditTransactionRecord[]>();
      for (const grant of candidates) {
        const grants = byAccount.get(grant.userId) ?? [];
        grants.push(grant);
        byAccount.set(grant.userId, grants);
      }
      for (const [userId, grants] of byAccount) {
        try {
          const expired = await this.expireAccountGrants(userId, grants);
          events.push(...expired);
          count += expired.length;
        } catch (error) {
          failed.push(...grants.map(grant => grant.id));
          this.logger.error(
            `过期积分处理失败: userId=${userId}, txIds=${grants.map(grant => grant.id).join(',')}, error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (candidates.length < EXPIRE_BATCH_SIZE) break;
    }

    await this.publishAll(events);
    if (count > 0) {
      this.logger.log(`过期积分处理完成: ${count} 笔`);
    }
    return count;
  }

  /** Expire one account's due grants in one transaction with a single ledger replay. */
  private async expireAccountGrants(userId: string, grants: CreditTransactionRecord[]): Promise<PendingEvent[]> {
    const existing = (await this.db.model('creditAccount').findUnique({
      where: { userId },
    })) as CreditAccount | null;

    return this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      const account = existing ? await this.lockAccount(dbTx, userId) : null;
      const claimedGrants: CreditTransactionRecord[] = [];
      for (const grant of grants) {
        // Claim the grant; a concurrent run that already expired it makes this a no-op.
        const claimed = await dbTx.model('creditTransaction').updateMany({
          where: { id: grant.id, expired: false },
          data: { expired: true },
        });
        if (claimed.count !== 1) continue;
        if (!Number.isFinite(grant.amount) || grant.amount <= 0) {
          this.logger.warn(`Invalid GRANT amount: txId=${grant.id}, amount=${grant.amount}`);
          continue;
        }
        claimedGrants.push(grant);
      }
      if (!account || !claimedGrants.length) return [];

      // One replay serves every claimed grant: an EXPIRE row never takes more than its own lot's
      // remainder, so expiring one grant does not change another grant's unspent part.
      const remainders = await this.unspentRemainders(dbTx, userId);
      const events: PendingEvent[] = [];
      let balance = account.balance;
      for (const grant of claimedGrants) {
        const remaining = remainders.get(grant.id) ?? 0;
        if (remaining <= 0) continue;
        const description = `积分过期扣除 (原交易: ${grant.id})`;
        const deduction = Math.max(0, Math.min(remaining, balance));
        balance -= deduction;
        // A zero-amount row is still written when an unspent remainder could not be deducted
        // (e.g. it is frozen), so later replays retire this grant at this point.
        await this.appendTransaction(dbTx, {
          userId,
          type: CreditTransactionType.EXPIRE,
          amount: deduction ? -deduction : 0,
          balance,
          description,
          // The expired grant id; lets later replays attribute this deduction to its lot.
          orderId: grant.id,
        });
        if (deduction > 0) {
          events.push({ type: 'expired', topic: CREDIT_EVENT_TOPICS.EXPIRED, userId, amount: deduction, balance, description });
        }
      }
      if (balance !== account.balance) await this.writeAccount(dbTx, account, { balance });
      return events;
    });
  }

  /**
   * Replay the account ledger and return the unspent part of every credit lot, by transaction id.
   * Debits are taken from the earliest-expiring credit first (never-expiring credits last);
   * EXPIRE rows are charged to the grant they reference.
   */
  private async unspentRemainders(dbTx: DatabaseAdapter, userId: string): Promise<Map<string, number>> {
    const rows = (await dbTx.model('creditTransaction').findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })) as CreditTransactionRecord[];

    const expireRef = (row: CreditTransactionRecord): string | undefined =>
      row.orderId ?? /原交易: ([^)]+)\)/.exec(row.description ?? '')?.[1];
    const lots = new Map<string, ReplayLot>();
    let debt = 0;
    let order = 0;
    const drain = (amount: number): number => {
      let left = amount;
      const ordered = [...lots.values()]
        .filter(lot => lot.remaining > 0)
        .sort((a, b) => (a.expireAt ?? Infinity) - (b.expireAt ?? Infinity) || a.order - b.order);
      for (const lot of ordered) {
        if (left <= 0) break;
        const take = Math.min(lot.remaining, left);
        lot.remaining -= take;
        left -= take;
      }
      return left;
    };

    for (const row of rows) {
      const amount = Number(row.amount);
      if (!Number.isFinite(amount)) continue;
      if (amount === 0 && row.type !== CreditTransactionType.EXPIRE) continue;
      if (row.type === CreditTransactionType.EXPIRE) {
        const lotId = expireRef(row);
        const lot = lotId ? lots.get(lotId) : undefined;
        let left = Math.abs(amount);
        if (lot) {
          left -= Math.min(lot.remaining, left);
          lot.remaining = 0;
        }
        if (left > 0) debt += drain(left);
        continue;
      }
      if (amount > 0) {
        let credit = amount;
        if (debt > 0) {
          const paid = Math.min(debt, credit);
          debt -= paid;
          credit -= paid;
        }
        const expireAt = row.type === CreditTransactionType.GRANT && row.expireAt
          ? new Date(row.expireAt).getTime()
          : null;
        lots.set(row.id, { id: row.id, remaining: credit, expireAt, order: order++ });
        continue;
      }
      debt += drain(-amount);
    }

    return new Map([...lots].map(([id, lot]) => [id, Math.max(0, lot.remaining)]));
  }

  /**
   * 积分兑换 — 消费积分兑换奖品/服务
   */
  async exchange(
    userId: string,
    amount: number,
    exchangeType: string,
    description: string,
    orderId?: string,
    options: CreditOperationOptions = {},
  ): Promise<void> {
    return this.consume(userId, amount, `[${exchangeType}] ${description}`, orderId, options);
  }

  /**
   * 批量查询多个用户的余额
   */
  async getBalances(
    userIds: string[],
  ): Promise<Map<string, { balance: number; frozenBalance: number }>> {
    const result = new Map<string, { balance: number; frozenBalance: number }>();
    if (userIds.length === 0) return result;

    const accounts = (await this.db.model('creditAccount').findMany({
      where: { userId: { in: userIds } },
    })) as CreditAccount[];

    for (const account of accounts) {
      result.set(account.userId, {
        balance: account.balance,
        frozenBalance: account.frozenBalance,
      });
    }

    // 未创建账户的用户返回 0
    for (const userId of userIds) {
      if (!result.has(userId)) {
        result.set(userId, { balance: 0, frozenBalance: 0 });
      }
    }

    return result;
  }

  /**
   * Run one single-account mutation under the account lock, with optional idempotency.
   * Returns the event to publish after commit, or null for an idempotent replay.
   */
  private async mutate(
    userId: string,
    operationType: string,
    amount: number,
    resourceId: string | undefined,
    options: CreditOperationOptions,
    apply: (tx: DatabaseAdapter, account: CreditAccount) => Promise<PendingEvent>,
  ): Promise<PendingEvent | null> {
    const idempotencyKey = this.validateIdempotencyKey(options.idempotencyKey);
    if (idempotencyKey && (!Number.isSafeInteger(amount) || amount > MAX_RECEIPT_AMOUNT)) {
      throw new ValidationException(
        { amount: [`With an idempotency key the amount must be an integer from 1 to ${MAX_RECEIPT_AMOUNT}`] },
        'Invalid credit amount for an idempotent operation',
      );
    }
    const expected = { accountId: userId, operationType, amount, resourceId: resourceId ?? null };
    await this.ensureAccount(userId);
    try {
      return await this.db.$transaction(async (tx: DatabaseAdapter) => {
        const account = await this.lockAccount(tx, userId);
        if (idempotencyKey) {
          // The account lock serializes retries of the same key for the same account.
          const existing = (await tx.model(RECEIPT_MODEL).findUnique({
            where: { idempotencyKey },
          })) as ReceiptRow | null;
          if (existing) return this.replayReceipt(idempotencyKey, existing, expected);
          await tx.model(RECEIPT_MODEL).create({
            data: {
              idempotencyKey,
              ...expected,
              resourceType: RECEIPT_RESOURCE_TYPE,
              createdAt: new Date(),
            },
          });
        }
        return apply(tx, account);
      });
    } catch (error) {
      // The same key used concurrently on another account is not serialized by the account lock:
      // the losing insert fails on the unique key (and aborts the PostgreSQL transaction). The
      // committed receipt decides between replay and 409 instead of a raw database error.
      if (!idempotencyKey || error instanceof BusinessException || error instanceof ValidationException) throw error;
      const committed = (await this.db.model(RECEIPT_MODEL).findUnique({
        where: { idempotencyKey },
      }).catch(() => null)) as ReceiptRow | null;
      if (!committed) throw error;
      return this.replayReceipt(idempotencyKey, committed, expected);
    }
  }

  /** A stored receipt: same parameters replay as a no-op (null), anything else is a 409. */
  private replayReceipt(
    idempotencyKey: string,
    existing: ReceiptRow,
    expected: { accountId: string; operationType: string; amount: number; resourceId: string | null },
  ): null {
    if (existing.accountId !== expected.accountId || existing.operationType !== expected.operationType
      || Number(existing.amount) !== expected.amount
      || (existing.resourceType != null && existing.resourceType !== RECEIPT_RESOURCE_TYPE)
      || (existing.resourceId ?? null) !== expected.resourceId) {
      throw new BusinessException(
        `Credit operation key ${idempotencyKey} was reused with different parameters`,
        'CREDIT_IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return null;
  }

  /**
   * Take the account row lock (same-value update; PostgreSQL keeps the row lock until commit)
   * and read the balance after it, so the read sees every previously committed mutation.
   */
  private async lockAccount(tx: DatabaseAdapter, userId: string): Promise<CreditAccount> {
    await this.lockAccountRow(tx, userId);
    return this.readLockedAccount(tx, userId);
  }

  private async lockAccountRow(tx: DatabaseAdapter, userId: string): Promise<void> {
    const locked = await tx.model('creditAccount').updateMany({
      where: { userId },
      data: { userId },
    });
    if (!locked.count) {
      throw new BusinessException(`Credit account for ${userId} not found`, 'CREDIT_ACCOUNT_NOT_FOUND', 404);
    }
  }

  private async readLockedAccount(tx: DatabaseAdapter, userId: string): Promise<CreditAccount> {
    const account = (await tx.model('creditAccount').findUnique({ where: { userId } })) as CreditAccount | null;
    if (!account) {
      throw new BusinessException(`Credit account for ${userId} not found`, 'CREDIT_ACCOUNT_NOT_FOUND', 404);
    }
    return account;
  }

  private async writeAccount(
    tx: DatabaseAdapter,
    account: CreditAccount,
    data: Partial<Pick<CreditAccount, 'balance' | 'frozenBalance'>>,
  ): Promise<void> {
    await tx.model('creditAccount').update({ where: { id: account.id }, data });
  }

  private async appendTransaction(tx: DatabaseAdapter, data: Record<string, unknown>): Promise<void> {
    // Explicit timestamp: ledger replay (expiry) orders by createdAt.
    await tx.model('creditTransaction').create({ data: { createdAt: new Date(), ...data } });
  }

  /** Validate that the amount is a positive finite number */
  private validateAmount(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationException(
        { amount: [`积分金额无效: ${amount} (必须为正数)`] },
        `积分金额无效: ${amount} (必须为正数)`,
      );
    }
  }

  /** Validate that userId is a non-empty string */
  private validateUserId(userId: string): void {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new ValidationException({ userId: ['用户ID不能为空'] }, '用户ID不能为空');
    }
  }

  private validateIdempotencyKey(key: unknown): string | undefined {
    if (key === undefined || key === null) return undefined;
    if (typeof key !== 'string' || !key.trim() || key.length > 200) {
      throw new ValidationException(
        { idempotencyKey: ['Must be a non-empty string of at most 200 characters'] },
        'Invalid idempotency key',
      );
    }
    return key;
  }

  /** Publish after commit. A failing bus is logged; it never changes a committed result. */
  private async publishAll(events: PendingEvent[]): Promise<void> {
    if (!this.topicEventBus) return;
    for (const event of events) {
      const payload: CreditEventPayload = {
        type: event.type,
        userId: event.userId,
        amount: event.amount,
        balance: event.balance,
        description: event.description,
        orderId: event.orderId,
        timestamp: new Date(),
      };
      try {
        await this.topicEventBus.publish(event.topic, payload);
      } catch (error) {
        this.logger.error(
          `Credit event publish failed after commit: topic=${event.topic}, userId=${event.userId}, error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Create the account outside the mutation transaction; a concurrent creator wins harmlessly. */
  private async ensureAccount(userId: string): Promise<void> {
    const model = this.db.model('creditAccount');
    if (await model.findUnique({ where: { userId } })) return;
    try {
      await model.create({ data: { userId, balance: 0, frozenBalance: 0 } });
    } catch (error) {
      // Unique conflict from a concurrent creator: the account exists now.
      if (await model.findUnique({ where: { userId } })) return;
      throw error;
    }
  }
}
