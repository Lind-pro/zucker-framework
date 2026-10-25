import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  BatchCreditInsufficientError,
  PostgresCreditOperationCoordinator,
  type CreateCreditLotHold,
} from '@zucker-framework/credit';
import { ApplicationDatabase } from '../src/database';
import { createCreditLedger } from '../src/billing/ledger';
import { CreditsService, readCreditBalance } from '../src/credits/credits.service';
import { RefundCreditBlockedError } from '../src/credits/refund-credit-blocks';

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const schema = `zucker_refund_blocks_${randomUUID().replaceAll('-', '')}`;
run('consumer refund source eligibility on actual PostgreSQL', () => {
  let database: ApplicationDatabase, pool: Pool;
  const coordinator = new PostgresCreditOperationCoordinator();
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/cnipa_dev') throw new Error('Requires approved development database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true })
        .filter((row) => row.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(
          readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace(
            'CREATE SCHEMA IF NOT EXISTS "public";',
            '',
          ),
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    url.searchParams.set('schema', schema);
    database = new ApplicationDatabase(url.href);
  });
  afterAll(async () => {
    try {
      await database?.onModuleDestroy();
    } finally {
      if (pool) {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    }
  });
  async function grant(ownerId: string, sourceId: string, amount: number) {
    await database.transaction((tx) =>
      createCreditLedger(database).grant(tx, {
        accountId: ownerId,
        source: 'purchase',
        sourceId,
        amount,
        transactionData: { type: 'GRANT' },
      }),
    );
    return (
      (await database
        .model('creditLots')
        .findMany({ where: { userId: ownerId, sourceId }, select: { id: true } })) as Array<{
        id: string;
      }>
    )[0].id;
  }
  async function fixture() {
    const ownerId = randomUUID(),
      orderId = randomUUID(),
      targetId = randomUUID(),
      sourceId = `charge-${orderId}`;
    await database
      .model('users')
      .create({
        data: {
          id: ownerId,
          username: `blocks_${ownerId.replaceAll('-', '')}`,
          name: 'Synthetic refund owner',
          typeId: 'member',
          status: true,
        },
      });
    await database
      .model('billingOrders')
      .create({
        data: {
          id: orderId,
          ownerId,
          offerId: 'synthetic',
          providerId: 'stripe',
          accountScope: 'synthetic-blocks',
          offer: {
            description: 'Synthetic refund source',
            money: { amount: '10.00', currency: 'USD' },
          },
          successUrl: 'https://example.invalid/success',
          cancelUrl: 'https://example.invalid/cancel',
          createKey: `create-${orderId}`,
          captureKey: `capture-${orderId}`,
          creationState: 'created',
          captureState: 'confirmed',
          state: 'paid',
          paymentKind: 'payment-intent',
          paymentId: `payment-${orderId}`,
        },
      });
    const lotId = await grant(ownerId, orderId, 100);
    await database
      .model('billingRefundPayments')
      .create({
        data: {
          id: targetId,
          ownerId,
          orderId,
          providerId: 'stripe',
          accountScope: 'synthetic-blocks',
          paymentKind: 'payment-intent',
          paymentId: `payment-${orderId}`,
          sourceKind: 'charge',
          sourceId,
          title: 'Synthetic refund source',
          paidMoney: { amount: '10.00', currency: 'USD' },
          paidMinor: '1000',
          minorScale: 2,
          totalCredits: 100,
          grantRecorded: true,
          grantSource: 'purchase',
          grantSourceId: orderId,
          observedAt: new Date(),
        },
      });
    return { ownerId, orderId, targetId, sourceId, lotId };
  }
  async function blocked(f: Awaited<ReturnType<typeof fixture>>, aggregate = false) {
    await database.transaction(async (tx) => {
      await coordinator.lockAccount(tx, f.ownerId);
      if (aggregate)
        await tx
          .model('billingRefundPayments')
          .update({
            where: { id: f.targetId },
            data: { refundedMinor: '1000', revision: { increment: 1 } },
          });
      else
        await tx
          .model('billingRefundEvents')
          .create({
            data: {
              providerId: 'stripe',
              accountScope: 'synthetic-blocks',
              eventId: randomUUID(),
              sourceKind: 'charge',
              sourceId: f.sourceId,
              refundId: `receipt-${f.targetId}`,
              targetId: f.targetId,
              evidence: {
                state: 'succeeded',
                source: { kind: 'charge', id: f.sourceId },
                refundId: `receipt-${f.targetId}`,
                money: { amount: '10.00', currency: 'USD' },
              },
            },
          });
    });
  }
  function intent(
    ownerId: string,
    lotId: string,
    amount = 30,
    resourceType = 'synthetic-work',
  ): CreateCreditLotHold {
    const id = randomUUID();
    return {
      id,
      accountId: ownerId,
      lotIds: [lotId],
      amount,
      resourceType,
      resourceId: id,
      operationKey: `hold:${id}`,
      transactionData: { type: 'FREEZE' },
    };
  }
  const consume = (ownerId: string, amount: number, refundSettlement = false) =>
    database.transaction((tx) =>
      createCreditLedger(database, { refundSettlement }).consume(tx, {
        accountId: ownerId,
        amount,
        preferredSource: 'purchase',
        allowedSources: ['purchase'],
        transactionData: { type: 'CONSUME' },
        consumptionData: { resourceType: 'synthetic-work' },
      }),
    );
  const reserve = (input: CreateCreditLotHold, refundSettlement = false) =>
    database.transaction((tx) =>
      createCreditLedger(database, { refundSettlement }).hold(tx, input),
    );
  const settle = (input: CreateCreditLotHold, confirm: boolean, refundSettlement = false) =>
    database.transaction((tx) =>
      createCreditLedger(database, { refundSettlement })[confirm ? 'confirmHold' : 'releaseHold'](
        tx,
        {
          id: input.id,
          accountId: input.accountId,
          operationKey: `${confirm ? 'confirm' : 'release'}:${input.id}`,
          transactionData: { type: confirm ? 'REFUND' : 'UNFREEZE' },
        },
      ),
    );

  it('excludes durable unprocessed cash proof from consumption without changing book balance or fabricating a hold', async () => {
    const f = await fixture();
    await blocked(f);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 0,
      refundBlocked: 100,
      bookBalance: 100,
      bookFrozenBalance: 0,
    });
    expect(
      (await new CreditsService(database).lots(f.ownerId, { page: 1, pageSize: 20 })).data[0],
    ).toMatchObject({
      status: 'refund_pending',
      availableAmount: 0,
      frozenAmount: 0,
      refundBlockedAmount: 100,
    });
    await expect(consume(f.ownerId, 1)).rejects.toBeInstanceOf(BatchCreditInsufficientError);
    await expect(consume(f.ownerId, 1, true)).rejects.toBeInstanceOf(BatchCreditInsufficientError);
    expect(await database.model('creditHolds').count({ where: { accountId: f.ownerId } })).toBe(0);
  });
  it('continues consuming and holding other purchase lots from the same owner while a refunded source is blocked', async () => {
    const f = await fixture(),
      healthy = await grant(f.ownerId, randomUUID(), 50);
    await blocked(f, true);
    await consume(f.ownerId, 30);
    expect(await database.model('creditLots').findUnique({ where: { id: f.lotId } })).toMatchObject(
      { remainingAmount: 100 },
    );
    expect(await database.model('creditLots').findUnique({ where: { id: healthy } })).toMatchObject(
      { remainingAmount: 20 },
    );
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 20,
      refundBlocked: 100,
      bookBalance: 120,
    });
    const hold = intent(f.ownerId, healthy, 20);
    await reserve(hold);
    await settle(hold, true);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 0,
      refundBlocked: 100,
      bookBalance: 100,
    });
  });
  it('blocks new business holds and confirms, keeps replay idempotent, and permits release without making blocked credits spendable', async () => {
    const f = await fixture(),
      held = intent(f.ownerId, f.lotId);
    await reserve(held);
    await blocked(f);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 30,
      refundBlocked: 70,
      bookBalance: 70,
    });
    await expect(reserve(intent(f.ownerId, f.lotId, 10))).rejects.toBeInstanceOf(
      RefundCreditBlockedError,
    );
    await expect(reserve(intent(f.ownerId, f.lotId, 10), true)).rejects.toBeInstanceOf(
      RefundCreditBlockedError,
    );
    await expect(settle(held, true)).rejects.toBeInstanceOf(RefundCreditBlockedError);
    await expect(settle(held, true, true)).rejects.toBeInstanceOf(RefundCreditBlockedError);
    expect(await reserve(held)).toMatchObject({ changed: false });
    await settle(held, false);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 0,
      refundBlocked: 100,
      bookBalance: 100,
    });
  });
  it('permits only the explicit refund hold and confirmation path to recover blocked credits', async () => {
    const f = await fixture();
    await blocked(f, true);
    const hold = intent(f.ownerId, f.lotId, 100, 'refund-observation');
    await expect(reserve(hold)).rejects.toBeInstanceOf(RefundCreditBlockedError);
    await reserve(hold, true);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 100,
      refundBlocked: 0,
      bookBalance: 0,
    });
    await expect(settle(hold, true)).rejects.toBeInstanceOf(RefundCreditBlockedError);
    expect(await settle(hold, true, true)).toMatchObject({
      hold: { revokedAmount: 100 },
      changed: true,
    });
    expect(await settle(hold, true)).toMatchObject({ changed: false });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 0,
      refundBlocked: 0,
      bookBalance: 0,
    });
  });
  it('allows natural expiry and release of a blocked source without restoring expired value', async () => {
    const f = await fixture(),
      held = intent(f.ownerId, f.lotId);
    await reserve(held);
    await blocked(f);
    await database.transaction(async (tx) => {
      await coordinator.lockAccount(tx, f.ownerId);
      await tx
        .model('creditLots')
        .update({ where: { id: f.lotId }, data: { expiresAt: new Date(Date.now() - 60000) } });
      await createCreditLedger(database).expireInTransaction(tx, {
        accountId: f.ownerId,
        lotIds: [f.lotId],
        transactionData: { type: 'EXPIRE' },
      });
    });
    expect(await settle(held, false)).toMatchObject({
      hold: { expiredAmount: 30, releasedAmount: 0 },
    });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({
      available: 0,
      frozen: 0,
      refundBlocked: 0,
      expired: 100,
      bookBalance: 0,
    });
    expect(
      (await new CreditsService(database).lots(f.ownerId, { page: 1, pageSize: 20 })).data[0],
    ).toMatchObject({ status: 'expired', refundBlockedAmount: 0, availableAmount: 0 });
  });
});
