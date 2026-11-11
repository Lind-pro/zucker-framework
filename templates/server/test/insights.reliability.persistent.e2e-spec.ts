/**
 * Insights reliability (WP 3.5b, Sonnet additions) against PostgreSQL: concurrent callers share one
 * in-flight load, a failed load is never cached, a forced statement timeout becomes a 503
 * INSIGHTS_TIMEOUT, 365-day windows stay correct across Europe/London DST changes (23 h and 25 h days),
 * and malformed money never reaches a total. Service level on purpose: no HTTP wiring is needed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ServiceUnavailableException } from '@nestjs/common';
import { ApplicationDatabase } from '../src/database';
import { InsightsService } from '../src/insights';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_insights_rel_${randomUUID().replaceAll('-', '')}`;
const LONDON = 'Europe/London';

run('insights reliability (PostgreSQL)', () => {
  let pool: Pool, database: ApplicationDatabase;
  const sql = (text: string, values: unknown[] = []) => database.transaction(tx => tx.query(text, values));

  /** Counts transactions and lets a test inject a failure or a slow statement into the next ones. */
  const hooks = { transactions: 0, fail: undefined as Error | undefined, sleepOnPresence: false, gate: undefined as Promise<void> | undefined };
  const instrumented = new Proxy({} as ApplicationDatabase, {
    get(_target, property) {
      if (property !== 'transaction') {
        const value = Reflect.get(database, property);
        return typeof value === 'function' ? value.bind(database) : value;
      }
      return (work: (tx: any) => Promise<unknown>, ...rest: unknown[]) => {
        hooks.transactions += 1;
        const failure = hooks.fail;
        return (database.transaction as any)(async (tx: any) => {
          if (hooks.gate) await hooks.gate;
          if (failure) throw failure;
          const query = tx.query.bind(tx);
          return work(new Proxy(tx, {
            get(inner, key) {
              if (key !== 'query') return Reflect.get(inner, key);
              return async (text: string, values?: unknown[]) => {
                if (hooks.sleepOnPresence && text.includes('to_regclass')) {
                  // The service sets 5 s; shrink it so the test is fast, then run a statement that outlives it.
                  await query(`SET LOCAL statement_timeout = '150ms'`);
                  await query('SELECT pg_sleep(3)');
                }
                return query(text, values);
              };
            },
          }));
        }, ...rest);
      };
    },
  });
  const service = (asOf: Date) => new InsightsService(instrumented, () => asOf);

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
  });
  afterAll(async () => {
    try { await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });
  beforeEach(async () => {
    hooks.transactions = 0; hooks.fail = undefined; hooks.sleepOnPresence = false; hooks.gate = undefined;
    await sql('DELETE FROM billing_refund_receipts'); await sql('DELETE FROM billing_refund_payments');
    await sql('DELETE FROM billing_orders'); await sql(`DELETE FROM users WHERE id LIKE 'rel-%'`);
  });

  const user = (id: string, at: string) => sql(`INSERT INTO users (id, username, name, "typeId", "createTime") VALUES ($1, $1, $1, 'user', $2::timestamptz)`, [id, at]);

  it('concurrent identical requests share one in-flight load', async () => {
    await user('rel-u1', '2026-03-10T10:00:00Z');
    const insights = service(new Date('2026-03-10T16:00:00Z'));
    let release!: () => void;
    hooks.gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const calls = Array.from({ length: 6 }, () => insights.summary({ days: '3', tz: 'UTC' }));
    // A different parameter set must not join the same load.
    const other = insights.summary({ days: '4', tz: 'UTC' });
    release();
    const results = await Promise.all([...calls, other]);
    expect(hooks.transactions).toBe(2);
    for (const result of results.slice(1, 6)) expect(result).toBe(results[0]);
    expect(results[0]!.metrics['new-users']).toEqual({ available: true, value: 1 });
    // After settling, the cached result is still served without another read.
    await insights.summary({ days: '3', tz: 'UTC' });
    expect(hooks.transactions).toBe(2);
  });

  it('a failed load is not cached and all concurrent waiters see the failure', async () => {
    const insights = service(new Date('2026-03-10T16:00:00Z'));
    hooks.fail = new Error('synthetic read failure');
    const settled = await Promise.allSettled([insights.summary({ days: '3' }), insights.summary({ days: '3' }), insights.summary({ days: '3' })]);
    expect(settled.map(entry => entry.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(hooks.transactions).toBe(1);
    hooks.fail = undefined;
    const recovered = await insights.summary({ days: '3' });
    expect(recovered.range.days).toBe(3);
    expect(hooks.transactions).toBe(2);
    await insights.summary({ days: '3' });
    expect(hooks.transactions).toBe(2);
  });

  it('a statement timeout is a 503 INSIGHTS_TIMEOUT, and is not cached', async () => {
    const insights = service(new Date('2026-03-10T16:00:00Z'));
    hooks.sleepOnPresence = true;
    const error = await insights.summary({ days: '30' }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const exception = error as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    expect(exception.getResponse()).toMatchObject({ code: 'INSIGHTS_TIMEOUT' });
    // Series path maps the same way.
    const series = await insights.series({ metric: 'revenue', days: '30' }).then(() => undefined, (caught: unknown) => caught);
    expect((series as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'INSIGHTS_TIMEOUT' });
    hooks.sleepOnPresence = false;
    await expect(insights.summary({ days: '30' })).resolves.toMatchObject({ range: { days: 30 } });
  });

  it.each([
    // 2026-03-29 clocks go forward (a 23 h local day); the 365-day window starts on 2025-03-30, itself a 23 h day.
    { name: 'spring change', asOf: '2026-03-29T12:00:00Z', first: '2025-03-30', last: '2026-03-29',
      users: [['2025-03-29T23:59:59Z', null], ['2025-03-30T00:00:00Z', '2025-03-30'], ['2025-03-30T22:59:59Z', '2025-03-30'], ['2025-03-30T23:00:00Z', '2025-03-31'],
        ['2026-03-28T23:30:00Z', '2026-03-28'], ['2026-03-29T00:30:00Z', '2026-03-29'], ['2026-03-29T00:59:59Z', '2026-03-29'], ['2026-03-29T01:00:00Z', '2026-03-29'],
        ['2026-03-29T22:59:59Z', '2026-03-29'], ['2026-03-29T23:00:00Z', null]] },
    // 2026-10-25 clocks go back (a 25 h local day); the window starts on 2025-10-26, also a 25 h day.
    { name: 'autumn change', asOf: '2026-10-25T23:30:00Z', first: '2025-10-26', last: '2026-10-25',
      users: [['2025-10-25T22:59:59Z', null], ['2025-10-25T23:00:00Z', '2025-10-26'], ['2025-10-26T00:30:00Z', '2025-10-26'], ['2025-10-26T01:30:00Z', '2025-10-26'],
        ['2025-10-26T23:59:59Z', '2025-10-26'], ['2025-10-27T00:00:00Z', '2025-10-27'],
        ['2026-10-25T00:30:00Z', '2026-10-25'], ['2026-10-25T01:30:00Z', '2026-10-25'], ['2026-10-25T23:59:59Z', '2026-10-25'], ['2026-10-26T00:00:00Z', null]] },
  ] as Array<{ name: string; asOf: string; first: string; last: string; users: Array<[string, string | null]> }>)(
    '365 days in $name: one point per local day and exact boundaries', async ({ asOf, first, last, users }) => {
      for (const [index, [at]] of users.entries()) await user(`rel-u${index}`, at);
      const insights = service(new Date(asOf));
      const series = await insights.series({ metric: 'new-users', days: '365', tz: LONDON });
      expect(series).toMatchObject({ available: true, kind: 'daily', range: { days: 365, tz: LONDON, from: first, to: last } });
      if (!series.available || series.kind !== 'daily') throw new Error('expected a daily series');
      const points = series.series[0]!.points;
      expect(points).toHaveLength(365);
      expect(points[0]!.date).toBe(first);
      expect(points.at(-1)!.date).toBe(last);
      // Contiguous, strictly increasing local dates (a 23 h or 25 h day must not skip or repeat one).
      for (let index = 1; index < points.length; index += 1) {
        const previous = Date.parse(`${points[index - 1]!.date}T00:00:00Z`), current = Date.parse(`${points[index]!.date}T00:00:00Z`);
        expect(current - previous).toBe(86_400_000);
      }
      const expected = new Map<string, number>();
      for (const [, day] of users) if (day) expected.set(day, (expected.get(day) ?? 0) + 1);
      for (const point of points) expect(point.value, point.date).toBe(expected.get(point.date) ?? 0);
      expect(series.series[0]!.total).toBe(users.filter(([, day]) => day).length);
      const summary = await insights.summary({ days: '365', tz: LONDON });
      expect(summary.metrics['new-users']).toEqual({ available: true, value: users.filter(([, day]) => day).length });
    });

  it('malformed money is ignored, valid money is summed, never cast', async () => {
    await user('rel-owner', '2026-03-10T10:00:00Z');
    let counter = 0;
    const order = (money: unknown, promotion?: unknown) => sql(`INSERT INTO billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl",
        "createKey", "captureKey", "creationState", "captureState", state, "paymentId", "paymentKind", "fulfilledAt")
      VALUES ($1, 'rel-owner', 'offer', 'fake', 'default', $2::jsonb, '/ok', '/cancel', $1 || ':c', $1 || ':k', 'created', 'captured', 'paid', $1, 'payment', '2026-03-10T12:00:00Z')`,
    [`rel-o${counter += 1}`, JSON.stringify({ mode: 'payment', ...(money === undefined ? {} : { money }), ...(promotion ? { promotion } : {}) })]);
    await order({ amount: '7.25', currency: 'USD' });
    for (const bad of [
      { amount: 'abc', currency: 'USD' }, { amount: '1e5', currency: 'USD' }, { amount: '-5.00', currency: 'USD' }, { amount: '10.1234567', currency: 'USD' },
      { amount: '1234567890123456', currency: 'USD' }, { amount: '', currency: 'USD' }, { amount: ' 5.00', currency: 'USD' }, { amount: '5.00', currency: 'usd' },
      { amount: '5.00', currency: 'US' }, { amount: '5.00', currency: 'USDX' }, { amount: '5.00' }, { currency: 'USD' }, 'not-money', 12, [], null,
    ]) await order(bad);
    await order(undefined);
    // A malformed promotion payable is ignored; it does not silently fall back to the list price.
    await order({ amount: '99.00', currency: 'EUR' }, { id: 'p', providerCode: 'X', payable: { amount: 'oops', currency: 'EUR' } });
    // A malformed refund receipt is ignored too.
    await sql(`INSERT INTO billing_refund_payments (id, "ownerId", "orderId", "providerId", "accountScope", "paymentKind", "paymentId", "sourceKind", "sourceId",
        title, "paidMoney", "paidMinor", "minorScale", "totalCredits", "observedAt")
      VALUES ('rel-rp1', 'rel-owner', 'rel-o1', 'fake', 'default', 'payment', 'rel-o1', 'order', 'rel-o1', 'Pack', '{"amount":"7.25","currency":"USD"}', '725', 2, 1, now())`);
    for (const [refundId, money] of [['rr1', '{"amount":"2.00","currency":"USD"}'], ['rr2', '{"amount":"NaN","currency":"USD"}'], ['rr3', '{"amount":"3.00","currency":"usd"}']])
      await sql(`INSERT INTO billing_refund_receipts ("providerId", "accountScope", "refundId", "targetId", "sourceKind", "sourceId", state, money, "amountMinor", "occurredAt")
        VALUES ('fake', 'default', $1, 'rel-rp1', 'order', 'rel-o1', 'succeeded', $2::jsonb, '200', '2026-03-10T14:00:00Z')`, [refundId, money]);

    const insights = service(new Date('2026-03-10T16:00:00Z'));
    const summary = await insights.summary({ days: '3', tz: 'UTC' });
    expect(summary.metrics.revenue).toEqual({ available: true, totals: [{ currency: 'USD', amount: '7.25' }] });
    expect(summary.metrics.refunds).toEqual({ available: true, totals: [{ currency: 'USD', amount: '2.00' }] });
    const revenue = await insights.series({ metric: 'revenue', days: '3', tz: 'UTC' });
    if (!revenue.available || revenue.kind !== 'daily') throw new Error('expected a daily series');
    expect(revenue.series).toEqual([{ key: 'USD', total: '7.25', points: [
      { date: '2026-03-08', value: '0' }, { date: '2026-03-09', value: '0' }, { date: '2026-03-10', value: '7.25' }] }]);
  });
});
