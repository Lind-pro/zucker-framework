import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, BusinessException, ValidationException } from '@zucker/core';

import { DATABASE_ADAPTER } from '@zucker/crud';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker/event */
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

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {}

  async grant(userId: string, amount: number, description: string, expireAt?: Date): Promise<void> {
    this.validateAmount(amount);
    this.validateUserId(userId);

    if (expireAt !== undefined && expireAt.getTime() <= Date.now()) {
      throw new ValidationException(
        { expireAt: ['过期时间必须晚于当前时间'] },
        '过期时间必须晚于当前时间',
      );
    }

    // NOTE: 并发安全依赖于数据库事务隔离级别。
    // PostgreSQL 默认 READ_COMMITTED 可能导致 READ-MODIFY-WRITE 竞态。
    // 生产环境建议：1) 使用 SERIALIZABLE 隔离级别，或 2) 使用 SELECT FOR UPDATE。
    // InMemoryAdapter 为单线程，无此问题。
    const newBalance = await this.db.$transaction(async (tx: DatabaseAdapter) => {
      const account = await this.ensureAccount(tx, userId);
      const bal = account.balance + amount;

      await tx.model('creditAccount').update({
        where: { id: account.id },
        data: { balance: bal },
      });

      await tx.model('creditTransaction').create({
        data: {
          userId,
          type: CreditTransactionType.GRANT,
          amount,
          balance: bal,
          description,
          expireAt: expireAt ?? null,
          expired: false,
        },
      });

      return bal;
    });

    await this.emitCreditEvent('granted', CREDIT_EVENT_TOPICS.GRANTED, userId, amount, newBalance, description);
    this.logger.log(`积分发放: userId=${userId}, amount=${amount}`);
  }

  async consume(userId: string, amount: number, description: string, orderId?: string): Promise<void> {
    this.validateAmount(amount);
    this.validateUserId(userId);

    // NOTE: 并发安全依赖于数据库事务隔离级别。
    // PostgreSQL 默认 READ_COMMITTED 可能导致 READ-MODIFY-WRITE 竞态。
    // 生产环境建议：1) 使用 SERIALIZABLE 隔离级别，或 2) 使用 SELECT FOR UPDATE。
    // InMemoryAdapter 为单线程，无此问题。
    const newBalance = await this.db.$transaction(async (tx: DatabaseAdapter) => {
      const account = await this.ensureAccount(tx, userId);

      if (account.balance < amount) {
        throw new BusinessException(
          `积分余额不足 (当前: ${account.balance}, 需要: ${amount})`,
          'INSUFFICIENT_CREDIT',
          400,
        );
      }

      const bal = account.balance - amount;

      await tx.model('creditAccount').update({
        where: { id: account.id },
        data: { balance: bal },
      });

      await tx.model('creditTransaction').create({
        data: {
          userId,
          type: CreditTransactionType.CONSUME,
          amount: -amount,
          balance: bal,
          description,
          orderId: orderId ?? null,
        },
      });

      return bal;
    });

    await this.emitCreditEvent('consumed', CREDIT_EVENT_TOPICS.CONSUMED, userId, amount, newBalance, description, orderId);
    this.logger.log(`积分消费: userId=${userId}, amount=${amount}`);
  }

  async refund(userId: string, amount: number, description: string, orderId?: string): Promise<void> {
    this.validateAmount(amount);
    this.validateUserId(userId);

    const newBalance = await this.db.$transaction(async (tx: DatabaseAdapter) => {
      const account = await this.ensureAccount(tx, userId);
      const bal = account.balance + amount;

      await tx.model('creditAccount').update({
        where: { id: account.id },
        data: { balance: bal },
      });

      await tx.model('creditTransaction').create({
        data: {
          userId,
          type: CreditTransactionType.REFUND,
          amount,
          balance: bal,
          description,
          orderId: orderId ?? null,
        },
      });

      return bal;
    });

    await this.emitCreditEvent('refunded', CREDIT_EVENT_TOPICS.REFUNDED, userId, amount, newBalance, description, orderId);
    this.logger.log(`积分退还: userId=${userId}, amount=${amount}`);
  }

  /** Query balance and paginated transaction history */
  async query(userId: string, options: CreditQueryOptions = {}): Promise<CreditQueryResult> {
    this.validateUserId(userId);

    const {
      page = 1,
      pageSize = 20,
      type,
      startDate,
      endDate,
    } = options;

    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));

    const account = await this.db.model('creditAccount').findUnique({
      where: { userId },
    }) as CreditAccount | null;

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
    const {
      page = 1,
      pageSize = 20,
      type,
      startDate,
      endDate,
      userId,
    } = options;

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

    const account = await this.db.model('creditAccount').findUnique({
      where: { userId },
    }) as CreditAccount | null;

    return {
      balance: account?.balance ?? 0,
      frozenBalance: account?.frozenBalance ?? 0,
    };
  }

  /**
   * 转账 — 从一个用户转移积分到另一个用户
   * 对标 hsweb CreditService.transfer
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
      throw new ValidationException(
        { userId: ['不能向自己转账'] },
        '不能向自己转账',
      );
    }

    // NOTE: 并发安全依赖于数据库事务隔离级别。
    // PostgreSQL 默认 READ_COMMITTED 可能导致 READ-MODIFY-WRITE 竞态。
    // 生产环境建议：1) 使用 SERIALIZABLE 隔离级别，或 2) 使用 SELECT FOR UPDATE。
    // InMemoryAdapter 为单线程，无此问题。
    const result = await this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      const fromAccount = await this.ensureAccount(dbTx, fromUserId);
      const toAccount = await this.ensureAccount(dbTx, toUserId);

      if (fromAccount.balance < amount) {
        throw new BusinessException(
          `积分余额不足 (当前: ${fromAccount.balance}, 需要: ${amount})`,
          'INSUFFICIENT_CREDIT',
          400,
        );
      }

      const fromBalance = fromAccount.balance - amount;
      const toBalance = toAccount.balance + amount;

      await dbTx.model('creditAccount').update({
        where: { id: fromAccount.id },
        data: { balance: fromBalance },
      });
      await dbTx.model('creditAccount').update({
        where: { id: toAccount.id },
        data: { balance: toBalance },
      });

      await dbTx.model('creditTransaction').create({
        data: {
          userId: fromUserId,
          type: CreditTransactionType.TRANSFER_OUT,
          amount: -amount,
          balance: fromBalance,
          description: `${description} → ${toUserId}`,
        },
      });
      await dbTx.model('creditTransaction').create({
        data: {
          userId: toUserId,
          type: CreditTransactionType.TRANSFER_IN,
          amount,
          balance: toBalance,
          description: `${description} ← ${fromUserId}`,
        },
      });

      return { fromBalance, toBalance };
    });

    await this.emitCreditEvent('transferred', CREDIT_EVENT_TOPICS.TRANSFERRED, fromUserId, amount, result.fromBalance, `${description} → ${toUserId}`);
    this.logger.log(`积分转账: from=${fromUserId}, to=${toUserId}, amount=${amount}`);
    return result;
  }

  /**
   * 冻结积分 — 从可用余额转入冻结余额
   * 对标 hsweb CreditService.freeze
   */
  async freeze(
    userId: string,
    amount: number,
    description = '积分冻结',
  ): Promise<{ balance: number; frozenBalance: number }> {
    this.validateUserId(userId);
    this.validateAmount(amount);

    // NOTE: 并发安全依赖于数据库事务隔离级别。
    // PostgreSQL 默认 READ_COMMITTED 可能导致 READ-MODIFY-WRITE 竞态。
    // 生产环境建议：1) 使用 SERIALIZABLE 隔离级别，或 2) 使用 SELECT FOR UPDATE。
    // InMemoryAdapter 为单线程，无此问题。
    return this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      const account = await this.ensureAccount(dbTx, userId);

      if (account.balance < amount) {
        throw new BusinessException(
          `可用余额不足 (当前: ${account.balance}, 需冻结: ${amount})`,
          'INSUFFICIENT_CREDIT',
          400,
        );
      }

      const balance = account.balance - amount;
      const frozenBalance = account.frozenBalance + amount;

      await dbTx.model('creditAccount').update({
        where: { id: account.id },
        data: { balance, frozenBalance },
      });

      await dbTx.model('creditTransaction').create({
        data: {
          userId,
          type: CreditTransactionType.FREEZE,
          amount: -amount,
          balance,
          description,
        },
      });

      await this.emitCreditEvent('frozen', CREDIT_EVENT_TOPICS.FROZEN, userId, amount, balance, description);

      return { balance, frozenBalance };
    });
  }

  /**
   * 解冻积分 — 从冻结余额转回可用余额
   * 对标 hsweb CreditService.unfreeze
   */
  async unfreeze(
    userId: string,
    amount: number,
    description = '积分解冻',
  ): Promise<{ balance: number; frozenBalance: number }> {
    this.validateUserId(userId);
    this.validateAmount(amount);

    // NOTE: 并发安全依赖于数据库事务隔离级别。
    // PostgreSQL 默认 READ_COMMITTED 可能导致 READ-MODIFY-WRITE 竞态。
    // 生产环境建议：1) 使用 SERIALIZABLE 隔离级别，或 2) 使用 SELECT FOR UPDATE。
    // InMemoryAdapter 为单线程，无此问题。
    return this.db.$transaction(async (dbTx: DatabaseAdapter) => {
      const account = await this.ensureAccount(dbTx, userId);

      if (account.frozenBalance < amount) {
        throw new BusinessException(
          `冻结余额不足 (当前: ${account.frozenBalance}, 需解冻: ${amount})`,
          'INSUFFICIENT_FROZEN_CREDIT',
          400,
        );
      }

      const balance = account.balance + amount;
      const frozenBalance = account.frozenBalance - amount;

      await dbTx.model('creditAccount').update({
        where: { id: account.id },
        data: { balance, frozenBalance },
      });

      await dbTx.model('creditTransaction').create({
        data: {
          userId,
          type: CreditTransactionType.UNFREEZE,
          amount,
          balance,
          description,
        },
      });

      await this.emitCreditEvent('unfrozen', CREDIT_EVENT_TOPICS.UNFROZEN, userId, amount, balance, description);

      return { balance, frozenBalance };
    });
  }

  async checkExpired(): Promise<number> {
    const now = new Date();
    const expiredTransactions = await this.db.model('creditTransaction').findMany({
      where: {
        type: CreditTransactionType.GRANT,
        expireAt: { lte: now },
        expired: false,
      },
      take: EXPIRE_BATCH_SIZE,
      orderBy: { expireAt: 'asc' },
    }) as CreditTransactionRecord[];

    let count = 0;
    for (const tx of expiredTransactions) {
      try {
        await this.db.$transaction(async (dbTx: DatabaseAdapter) => {
          if (!Number.isFinite(tx.amount) || tx.amount <= 0) {
            this.logger.warn(`Invalid GRANT amount: txId=${tx.id}, amount=${tx.amount}`);
            await dbTx.model('creditTransaction').update({
              where: { id: tx.id },
              data: { expired: true },
            });
            return;
          }

          const account = await dbTx.model('creditAccount').findUnique({
            where: { userId: tx.userId },
          }) as CreditAccount | null;
          if (!account) return;

          const deduction = Math.min(tx.amount, account.balance);
          if (deduction <= 0) {
            // Mark as expired even if nothing to deduct
            await dbTx.model('creditTransaction').update({
              where: { id: tx.id },
              data: { expired: true },
            });
            return;
          }

          const newBalance = account.balance - deduction;
          await dbTx.model('creditAccount').update({
            where: { id: account.id },
            data: { balance: newBalance },
          });

          await dbTx.model('creditTransaction').create({
            data: {
              userId: tx.userId,
              type: CreditTransactionType.EXPIRE,
              amount: -deduction,
              balance: newBalance,
              description: `积分过期扣除 (原交易: ${tx.id})`,
            },
          });

          await dbTx.model('creditTransaction').update({
            where: { id: tx.id },
            data: { expired: true },
          });

          count++;

          await this.emitCreditEvent(
            'expired',
            CREDIT_EVENT_TOPICS.EXPIRED,
            tx.userId,
            deduction,
            newBalance,
            `积分过期扣除 (原交易: ${tx.id})`,
          );
        });
      } catch (error) {
        this.logger.error(
          `过期积分处理失败: txId=${tx.id}, userId=${tx.userId}, error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (count > 0) {
      this.logger.log(`过期积分处理完成: ${count} 笔`);
    }
    return count;
  }

  /**
   * 积分兑换 — 消费积分兑换奖品/服务
   * 对标 hsweb CreditService.exchange
   */
  async exchange(
    userId: string,
    amount: number,
    exchangeType: string,
    description: string,
    orderId?: string,
  ): Promise<void> {
    return this.consume(userId, amount, `[${exchangeType}] ${description}`, orderId);
  }

  /**
   * 批量查询多个用户的余额
   * 对标 hsweb CreditService.getBalances
   */
  async getBalances(userIds: string[]): Promise<Map<string, { balance: number; frozenBalance: number }>> {
    const result = new Map<string, { balance: number; frozenBalance: number }>();
    if (userIds.length === 0) return result;

    const accounts = await this.db.model('creditAccount').findMany({
      where: { userId: { in: userIds } },
    }) as CreditAccount[];

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
      throw new ValidationException(
        { userId: ['用户ID不能为空'] },
        '用户ID不能为空',
      );
    }
  }

  private async emitCreditEvent(
    type: CreditEventPayload['type'],
    topic: string,
    userId: string,
    amount: number,
    balance: number,
    description: string,
    orderId?: string,
  ): Promise<void> {
    if (!this.topicEventBus) return;
    const payload: CreditEventPayload = {
      type,
      userId,
      amount,
      balance,
      description,
      orderId,
      timestamp: new Date(),
    };
    await this.topicEventBus.publish(topic, payload);
  }

  private async ensureAccount(tx: DatabaseAdapter, userId: string): Promise<CreditAccount> {
    let account = await tx.model('creditAccount').findUnique({
      where: { userId },
    }) as CreditAccount | null;

    if (!account) {
      account = await tx.model('creditAccount').create({
        data: { userId, balance: 0, frozenBalance: 0 },
      }) as CreditAccount;
    }

    return account;
  }
}
