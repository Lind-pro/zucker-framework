import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { BusinessException } from '@zucker-framework/core';
import { CreditService, CreditTransactionType } from './credit.service';

/**
 * InMemoryAdapter with PostgreSQL-like row locks: an `updateMany` on `creditAccount` inside a
 * transaction locks the matched rows until the transaction ends, and every read yields to the
 * event loop so unlocked read-modify-write sequences interleave like they do on a real database.
 */
class LockingAdapter {
  readonly inner = new InMemoryAdapter();
  private readonly locks = new Map<string, Promise<void>>();

  model(name: string): ModelOperations {
    return this.wrap(name, undefined);
  }

  async $transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    const held: Array<() => void> = [];
    const tx = { model: (name: string) => this.wrap(name, held), $transaction: this.$transaction.bind(this) };
    try {
      return await fn(tx as unknown as DatabaseAdapter);
    } finally {
      for (const release of held) release();
    }
  }

  private wrap(name: string, held: Array<() => void> | undefined): ModelOperations {
    const ops = this.inner.model(name) as unknown as Record<string, (args: unknown) => Promise<unknown>>;
    const yieldThen = <R>(work: () => Promise<R>) => new Promise<void>(r => setTimeout(r, 1)).then(work);
    return new Proxy(ops, {
      get: (target, prop: string) => {
        const original = target[prop]?.bind(target);
        if (!original) return undefined;
        if (prop === 'updateMany' && name === 'creditAccount' && held) {
          return async (args: { where: { userId: string } }) => {
            const key = args.where.userId;
            while (this.locks.has(key)) await this.locks.get(key);
            let release!: () => void;
            this.locks.set(key, new Promise<void>(r => { release = r; }));
            held.push(() => { this.locks.delete(key); release(); });
            return original(args);
          };
        }
        if (prop.startsWith('find')) return (args: unknown) => yieldThen(() => original(args));
        return original;
      },
    }) as unknown as ModelOperations;
  }
}

describe('CreditService concurrency, idempotency and expiry (H1/H2)', () => {
  let db: LockingAdapter;
  let service: CreditService;

  beforeEach(() => {
    db = new LockingAdapter();
    service = new CreditService(db as unknown as DatabaseAdapter, undefined);
  });

  it('two concurrent consumes cannot both spend the same balance', async () => {
    await service.grant('u1', 100, 'top-up');
    const results = await Promise.allSettled([
      service.consume('u1', 100, 'a'),
      service.consume('u1', 100, 'b'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BusinessException);
    expect((await service.getBalance('u1')).balance).toBe(0);
  });

  it('a grant concurrent with a consume is not lost', async () => {
    await service.grant('u1', 100, 'top-up');
    await Promise.all([service.consume('u1', 40, 'spend'), service.grant('u1', 25, 'bonus')]);
    expect((await service.getBalance('u1')).balance).toBe(85);
  });

  it('concurrent opposite transfers keep the total and do not deadlock', async () => {
    await service.grant('a', 100, 'x');
    await service.grant('b', 100, 'x');
    await Promise.all([service.transfer('a', 'b', 30), service.transfer('b', 'a', 50)]);
    const a = (await service.getBalance('a')).balance;
    const b = (await service.getBalance('b')).balance;
    expect(a + b).toBe(200);
    expect(a).toBe(120);
  });

  it('idempotency key makes a retried grant a no-op and rejects reuse with other parameters', async () => {
    await service.grant('u1', 50, 'order-1', undefined, { idempotencyKey: 'order-1' });
    await service.grant('u1', 50, 'order-1', undefined, { idempotencyKey: 'order-1' });
    expect((await service.getBalance('u1')).balance).toBe(50);
    await expect(service.grant('u1', 60, 'order-1', undefined, { idempotencyKey: 'order-1' }))
      .rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' });
    await Promise.all([
      service.consume('u1', 20, 'spend', 'o', { idempotencyKey: 'spend-1' }),
      service.consume('u1', 20, 'spend', 'o', { idempotencyKey: 'spend-1' }),
    ]);
    expect((await service.getBalance('u1')).balance).toBe(30);
  });

  it('a failing event bus does not fail a committed mutation', async () => {
    const bus = { publish: vi.fn().mockRejectedValue(new Error('bus down')) };
    const withBus = new CreditService(db as unknown as DatabaseAdapter, bus);
    await expect(withBus.grant('u1', 10, 'x')).resolves.toBeUndefined();
    await expect(withBus.freeze('u1', 5)).resolves.toEqual({ balance: 5, frozenBalance: 5 });
    expect((await withBus.getBalance('u1')).balance).toBe(5);
    expect(bus.publish).toHaveBeenCalledTimes(2);
  });

  describe('checkExpired', () => {
    async function expireNow(grantDescription: string, agoMs = 1000): Promise<void> {
      const rows = (await db.inner.model('creditTransaction').findMany({
        where: { description: grantDescription },
      })) as Array<{ id: string }>;
      await db.inner.model('creditTransaction').update({
        where: { id: rows[0].id },
        data: { expireAt: new Date(Date.now() - agoMs) },
      });
    }

    it('does not remove non-expiring credits when the expiring grant was already spent', async () => {
      await service.grant('u1', 100, 'promo', new Date(Date.now() + 60_000));
      await service.grant('u1', 100, 'paid top-up');
      await service.consume('u1', 100, 'spend');
      await expireNow('promo');

      expect(await service.checkExpired()).toBe(0);
      expect((await service.getBalance('u1')).balance).toBe(100);
    });

    it('removes only the unspent remainder of the expiring grant', async () => {
      await service.grant('u1', 100, 'paid top-up');
      await service.grant('u1', 100, 'promo', new Date(Date.now() + 60_000));
      await service.consume('u1', 30, 'spend');
      await expireNow('promo');

      expect(await service.checkExpired()).toBe(1);
      expect((await service.getBalance('u1')).balance).toBe(100);
      const expire = (await db.inner.model('creditTransaction').findMany({
        where: { type: CreditTransactionType.EXPIRE },
      })) as Array<{ amount: number }>;
      expect(expire.map(row => row.amount)).toEqual([-70]);
    });

    it('spends the earliest-expiring grant first across several grants', async () => {
      await service.grant('u1', 50, 'late', new Date(Date.now() + 120_000));
      await service.grant('u1', 50, 'early', new Date(Date.now() + 60_000));
      await service.consume('u1', 60, 'spend'); // early 50 + late 10
      await expireNow('early', 5000); // keeps early < late
      expect(await service.checkExpired()).toBe(0);
      expect((await service.getBalance('u1')).balance).toBe(40);
      await expireNow('late');
      expect(await service.checkExpired()).toBe(1);
      expect((await service.getBalance('u1')).balance).toBe(0);
    });

    it('two concurrent sweeps expire a grant once', async () => {
      await service.grant('u1', 100, 'paid top-up');
      await service.grant('u1', 100, 'promo', new Date(Date.now() + 60_000));
      await expireNow('promo');

      const counts = await Promise.all([service.checkExpired(), service.checkExpired()]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      expect((await service.getBalance('u1')).balance).toBe(100);
    });

    it('a grant whose account is missing is marked and does not block later grants', async () => {
      const past = new Date(Date.now() - 1000);
      for (let i = 0; i < 3; i++) {
        await db.inner.model('creditTransaction').create({
          data: { userId: `ghost-${i}`, type: CreditTransactionType.GRANT, amount: 10, balance: 10,
            description: 'orphan', expireAt: past, expired: false, createdAt: past },
        });
      }
      await service.grant('u1', 10, 'promo', new Date(Date.now() + 60_000));
      await expireNow('promo');
      expect(await service.checkExpired()).toBe(1);
      expect((await service.getBalance('u1')).balance).toBe(0);
      const pending = await db.inner.model('creditTransaction').count({ where: { expired: false, type: 'GRANT' } });
      expect(pending).toBe(0);
    });
  });
});
