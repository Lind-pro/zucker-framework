import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { BusinessException, ValidationException } from '@zucker-framework/core';
import { CreditService, CreditTransactionType } from './credit.service';

describe('CreditService', () => {
  let db: InMemoryAdapter;
  let service: CreditService;

  beforeEach(() => {
    db = new InMemoryAdapter();
    // Instantiate directly — no NestJS DI needed for unit tests.
    // The second constructor arg (TopicEventBus) is @Optional(), so undefined is fine.
    service = new CreditService(db as any, undefined);
  });

  // ---------------------------------------------------------------------------
  // grant
  // ---------------------------------------------------------------------------
  describe('grant', () => {
    it('should increase balance and create a GRANT transaction', async () => {
      await service.grant('user-1', 100, '签到奖励');

      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(100);

      const result = await service.query('user-1');
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].type).toBe(CreditTransactionType.GRANT);
      expect(result.transactions[0].amount).toBe(100);
      expect(result.transactions[0].balance).toBe(100);
    });

    it('should accumulate balance on multiple grants', async () => {
      await service.grant('user-1', 50, '第一次');
      await service.grant('user-1', 30, '第二次');

      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(80);

      const result = await service.query('user-1');
      expect(result.transactions).toHaveLength(2);
    });

    it('should reject non-positive amount', async () => {
      await expect(service.grant('user-1', 0, 'bad')).rejects.toThrow(ValidationException);
      await expect(service.grant('user-1', -10, 'bad')).rejects.toThrow(ValidationException);
    });

    it('should reject empty userId', async () => {
      await expect(service.grant('', 100, 'bad')).rejects.toThrow(ValidationException);
    });

    it('should reject expireAt in the past', async () => {
      const past = new Date(Date.now() - 10_000);
      await expect(service.grant('user-1', 100, 'expired', past)).rejects.toThrow(ValidationException);
    });
  });

  // ---------------------------------------------------------------------------
  // consume
  // ---------------------------------------------------------------------------
  describe('consume', () => {
    beforeEach(async () => {
      await service.grant('user-1', 200, '初始充值');
    });

    it('should decrease balance and create a CONSUME transaction', async () => {
      await service.consume('user-1', 80, '购买商品');

      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(120);

      const result = await service.query('user-1');
      const consumeTx = result.transactions.find(
        (t) => t.type === CreditTransactionType.CONSUME,
      );
      expect(consumeTx).toBeDefined();
      expect(consumeTx!.amount).toBe(-80);
      expect(consumeTx!.balance).toBe(120);
    });

    it('should throw BusinessException when balance is insufficient', async () => {
      await expect(service.consume('user-1', 999, '超额消费')).rejects.toThrow(
        BusinessException,
      );

      // Balance should remain unchanged
      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(200);
    });

    it('should throw when consuming from a non-existent account', async () => {
      await expect(service.consume('no-such-user', 10, 'fail')).rejects.toThrow(
        BusinessException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getBalance
  // ---------------------------------------------------------------------------
  describe('getBalance', () => {
    it('should return zero for a user with no account', async () => {
      const { balance, frozenBalance } = await service.getBalance('ghost');
      expect(balance).toBe(0);
      expect(frozenBalance).toBe(0);
    });

    it('should return correct balance after operations', async () => {
      await service.grant('user-1', 500, '充值');
      await service.consume('user-1', 150, '消费');

      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(350);
    });
  });

  // ---------------------------------------------------------------------------
  // getTransactions (via query)
  // ---------------------------------------------------------------------------
  describe('getTransactions (query)', () => {
    beforeEach(async () => {
      await service.grant('user-1', 100, '充值');
      await service.consume('user-1', 30, '消费');
      await service.grant('user-1', 50, '奖励');
    });

    it('should return all transactions for a user', async () => {
      const result = await service.query('user-1');
      expect(result.transactions).toHaveLength(3);
      expect(result.balance).toBe(120);
    });

    it('should filter transactions by type', async () => {
      const result = await service.query('user-1', {
        type: CreditTransactionType.GRANT,
      });
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions.every((t) => t.type === CreditTransactionType.GRANT)).toBe(true);
    });

    it('should paginate results', async () => {
      const page1 = await service.query('user-1', { page: 1, pageSize: 2 });
      expect(page1.transactions).toHaveLength(2);
      expect(page1.total).toBe(3);
      expect(page1.totalPages).toBe(2);

      const page2 = await service.query('user-1', { page: 2, pageSize: 2 });
      expect(page2.transactions).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // transfer
  // ---------------------------------------------------------------------------
  describe('transfer', () => {
    beforeEach(async () => {
      await service.grant('alice', 300, '充值');
      await service.grant('bob', 100, '充值');
    });

    it('should transfer credits between two accounts', async () => {
      const result = await service.transfer('alice', 'bob', 120, '转账');

      expect(result.fromBalance).toBe(180);
      expect(result.toBalance).toBe(220);

      const alice = await service.getBalance('alice');
      expect(alice.balance).toBe(180);

      const bob = await service.getBalance('bob');
      expect(bob.balance).toBe(220);
    });

    it('should create TRANSFER_OUT and TRANSFER_IN transactions', async () => {
      await service.transfer('alice', 'bob', 50);

      const aliceTxs = await service.query('alice');
      const outTx = aliceTxs.transactions.find(
        (t) => t.type === CreditTransactionType.TRANSFER_OUT,
      );
      expect(outTx).toBeDefined();
      expect(outTx!.amount).toBe(-50);

      const bobTxs = await service.query('bob');
      const inTx = bobTxs.transactions.find(
        (t) => t.type === CreditTransactionType.TRANSFER_IN,
      );
      expect(inTx).toBeDefined();
      expect(inTx!.amount).toBe(50);
    });

    it('should throw when sender has insufficient balance', async () => {
      await expect(service.transfer('alice', 'bob', 999)).rejects.toThrow(
        BusinessException,
      );

      // Balances unchanged
      const alice = await service.getBalance('alice');
      expect(alice.balance).toBe(300);
    });

    it('should throw when transferring to self', async () => {
      await expect(service.transfer('alice', 'alice', 10)).rejects.toThrow(
        ValidationException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // freeze / unfreeze
  // ---------------------------------------------------------------------------
  describe('freeze / unfreeze', () => {
    beforeEach(async () => {
      await service.grant('user-1', 500, '充值');
    });

    it('should freeze credits: balance decreases, frozenBalance increases', async () => {
      const result = await service.freeze('user-1', 200, '冻结');

      expect(result.balance).toBe(300);
      expect(result.frozenBalance).toBe(200);

      const bal = await service.getBalance('user-1');
      expect(bal.balance).toBe(300);
      expect(bal.frozenBalance).toBe(200);
    });

    it('should create a FREEZE transaction', async () => {
      await service.freeze('user-1', 100);

      const result = await service.query('user-1');
      const freezeTx = result.transactions.find(
        (t) => t.type === CreditTransactionType.FREEZE,
      );
      expect(freezeTx).toBeDefined();
      expect(freezeTx!.amount).toBe(-100);
    });

    it('should throw when freezing more than available balance', async () => {
      await expect(service.freeze('user-1', 999)).rejects.toThrow(BusinessException);
    });

    it('should unfreeze credits: balance increases, frozenBalance decreases', async () => {
      await service.freeze('user-1', 200);
      const result = await service.unfreeze('user-1', 120);

      expect(result.balance).toBe(420);
      expect(result.frozenBalance).toBe(80);
    });

    it('should create an UNFREEZE transaction', async () => {
      await service.freeze('user-1', 200);
      await service.unfreeze('user-1', 50);

      const result = await service.query('user-1');
      const unfreezeTx = result.transactions.find(
        (t) => t.type === CreditTransactionType.UNFREEZE,
      );
      expect(unfreezeTx).toBeDefined();
      expect(unfreezeTx!.amount).toBe(50);
    });

    it('should throw when unfreezing more than frozen balance', async () => {
      await service.freeze('user-1', 100);
      await expect(service.unfreeze('user-1', 200)).rejects.toThrow(BusinessException);
    });
  });

  // ---------------------------------------------------------------------------
  // checkExpired
  // ---------------------------------------------------------------------------
  describe('checkExpired', () => {
    it('should deduct expired grants from balance', async () => {
      const past = new Date(Date.now() + 50); // will be past by the time we check
      await service.grant('user-1', 100, '会过期的积分', past);

      // Wait briefly so the expireAt is in the past
      await new Promise((r) => setTimeout(r, 100));

      const count = await service.checkExpired();
      expect(count).toBe(1);

      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(0);
    });

    it('should create an EXPIRE transaction', async () => {
      const past = new Date(Date.now() + 50);
      await service.grant('user-1', 80, '过期积分', past);

      await new Promise((r) => setTimeout(r, 100));
      await service.checkExpired();

      const result = await service.query('user-1');
      const expireTx = result.transactions.find(
        (t) => t.type === CreditTransactionType.EXPIRE,
      );
      expect(expireTx).toBeDefined();
      expect(expireTx!.amount).toBe(-80);
    });

    it('should mark the original GRANT transaction as expired', async () => {
      const past = new Date(Date.now() + 50);
      await service.grant('user-1', 60, '过期积分', past);

      await new Promise((r) => setTimeout(r, 100));
      await service.checkExpired();

      // Query the raw GRANT transaction
      const grants = (await db.model('creditTransaction').findMany({
        where: { userId: 'user-1', type: CreditTransactionType.GRANT },
      })) as Array<{ expired: boolean }>;
      expect(grants).toHaveLength(1);
      expect(grants[0].expired).toBe(true);
    });

    it('should not deduct from non-expired grants', async () => {
      const future = new Date(Date.now() + 3_600_000); // 1 hour from now
      await service.grant('user-1', 100, '不会过期', future);

      const count = await service.checkExpired();
      expect(count).toBe(0);

      const { balance } = await service.getBalance('user-1');
      expect(balance).toBe(100);
    });

    it('should only deduct up to current balance (partial expiry)', async () => {
      const past = new Date(Date.now() + 50);
      await service.grant('user-1', 200, '会过期', past);
      await service.consume('user-1', 150, '先消费一部分');

      await new Promise((r) => setTimeout(r, 100));
      const count = await service.checkExpired();
      expect(count).toBe(1);

      const { balance } = await service.getBalance('user-1');
      // Had 50 left, expired grant was 200 but only 50 available
      expect(balance).toBe(0);
    });

    it('should return 0 when there are no expired transactions', async () => {
      await service.grant('user-1', 100, '永不过期');
      const count = await service.checkExpired();
      expect(count).toBe(0);
    });
  });
});
