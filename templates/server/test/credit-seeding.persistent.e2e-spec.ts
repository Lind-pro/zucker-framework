import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { CreditPackCatalogService, type CreditPackWrite } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { createCreditLedger } from '../src/billing/ledger';
import { createCreditPackStore } from '../src/billing/credit-packs.store';
import { creditPackSeedsFromBillingCatalog, seedCreditPacks } from '../src/billing/credit-pack-seeds';
import { readBillingCatalog } from '../src/billing/catalog';

/** Credit pack seeding and the expiry-first lot order on actual PostgreSQL. Synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_credit_seed_${randomUUID().replaceAll('-', '')}`, DAY = 86_400_000;
const seed = (slug: string, ref?: string, extra: Partial<CreditPackWrite> = {}): CreditPackWrite => ({ slug, title: slug, titleI18n: {}, description: null, descriptionI18n: {},
  credits: 10, expiresInDays: null, status: true, order: 0, prices: [{ currency: 'USD', amount: '5.00', providerRefs: ref ? { stripe: ref } : {} }], ...extra });

run('credit pack seeding and expiry-first ledger order (PostgreSQL)', () => {
  let pool: Pool, database: ApplicationDatabase, second: ApplicationDatabase;
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  async function user() {
    const id = randomUUID();
    await database.model('users').create({ data: { id, username: `seed_${id.replaceAll('-', '')}`, name: 'Synthetic', typeId: 'member', email: `${id}@example.invalid`, status: true } });
    return id;
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href); second = new ApplicationDatabase(url.href);
  });
  afterAll(async () => {
    try { await Promise.all([database?.disconnect(), second?.disconnect()]); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('seeds once under 10 concurrent setup runs across two connections pools, with no duplicate packs, prices or references', async () => {
    const seeds = [seed('alpha', 'price_AlphaA'), seed('beta', 'price_BetaB', { order: 1 }), seed('gamma', undefined, { order: 2 })];
    const results = await Promise.all(Array.from({ length: 10 }, (_v, index) => (index % 2 ? second : database).transaction(tx => seedCreditPacks(tx, seeds))));
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(3);
    expect(results.filter(value => value === 3)).toHaveLength(1);
    expect(await q('SELECT slug FROM "S".credit_packs ORDER BY slug')).toEqual([{ slug: 'alpha' }, { slug: 'beta' }, { slug: 'gamma' }]);
    expect((await q('SELECT count(*)::int AS n FROM "S".credit_pack_prices'))[0].n).toBe(3);
    expect((await q('SELECT count(*)::int AS n FROM "S".credit_pack_price_refs'))[0].n).toBe(2);
    // Later runs change nothing, including a changed seed for an existing slug.
    expect(await database.transaction(tx => seedCreditPacks(tx, [seed('alpha', 'price_Other', { credits: 999 })]))).toBe(0);
    expect((await q(`SELECT credits FROM "S".credit_packs WHERE slug = 'alpha'`))[0].credits).toBe(10);
  });
  it('does not recreate a pack an administrator deleted while others remain, and keeps administrator edits', async () => {
    const packs = new CreditPackCatalogService(createCreditPackStore(database));
    const beta = (await packs.findBySlug('beta'))!, gamma = (await packs.findBySlug('gamma'))!;
    await packs.update(beta.id, { credits: 77 }); await packs.delete(gamma.id);
    expect(await database.transaction(tx => seedCreditPacks(tx, [seed('beta', 'price_BetaB'), seed('gamma')]))).toBe(0);
    expect((await packs.findBySlug('beta'))!.credits).toBe(77); expect(await packs.findBySlug('gamma')).toBeNull();
  });
  it('doc contract: packs an administrator deleted are never recreated, even when every pack was deleted', async () => {
    // seedCreditPacks documents "packs an administrator edited or deleted are never recreated". It guards with
    // "credit_packs is empty", so deleting every pack makes the next setup run recreate the seeds.
    const packs = new CreditPackCatalogService(createCreditPackStore(database));
    for (const pack of await packs.list()) await packs.delete(pack.id);
    expect(await database.transaction(tx => seedCreditPacks(tx, [seed('alpha', 'price_AlphaA')]))).toBe(0);
    expect(await packs.list()).toEqual([]);
  });
  it('skips invalid seeds and seeds whose provider reference is taken without aborting the others', async () => {
    // A fresh installation: no packs and no seed marker.
    await q('DELETE FROM "S".credit_packs'); await q('DELETE FROM "S".starter_data_markers');
    const created = await database.transaction(tx => seedCreditPacks(tx, [
      seed('ok-one', 'price_OkOne'), seed('Bad Slug'), seed('zero', undefined, { credits: 0 }), seed('dup-ref', 'price_OkOne'),
      { ...seed('float-price'), prices: [{ currency: 'USD', amount: 5 as unknown as string, providerRefs: {} }] }, seed('ok-two', 'price_OkTwo')]));
    expect(created).toBe(3); // ok-one, dup-ref (its reference is dropped, the pack is kept) and ok-two
    expect(await q('SELECT slug FROM "S".credit_packs ORDER BY slug')).toEqual([{ slug: 'dup-ref' }, { slug: 'ok-one' }, { slug: 'ok-two' }]);
    expect(await q(`SELECT reference FROM "S".credit_pack_price_refs ORDER BY reference`)).toEqual([{ reference: 'price_OkOne' }, { reference: 'price_OkTwo' }]);
    expect(await database.transaction(tx => seedCreditPacks(tx, []))).toBe(0);
  });
  it('seeds only one-time static offers and freezes their provider references and expiry', async () => {
    const items = readBillingCatalog(JSON.stringify([
      { id: 'one-time', title: 'One time', version: 'v1', mode: 'payment', amount: '5.00', currency: 'USD', credits: 50, expiresInDays: 30, providers: { stripe: 'price_Static1' } },
      { id: 'recurring', title: 'Recurring', version: 'v1', mode: 'subscription', amount: '9.00', currency: 'USD', credits: 100, expiresInDays: null, subscriptionGrantBasis: { stripe: 'period' }, providers: { stripe: 'price_Static2' } },
    ]));
    expect(creditPackSeedsFromBillingCatalog(items).map(entry => [entry.slug, entry.credits, entry.expiresInDays, entry.status])).toEqual([['one-time', 50, 30, true]]);
  });

  // ── Expiry-first order on the real ledger ───────────────────────────────
  describe('expiry-first consumption', () => {
    const ledger = () => createCreditLedger(database);
    async function grant(accountId: string, amount: number, expiresAt: Date | undefined, createdAt: Date, id?: string) {
      const sourceId = randomUUID();
      await database.transaction(tx => ledger().grant(tx, { accountId, amount, source: 'grant', sourceId, expiresAt, transactionData: { type: 'GRANT', description: 'Synthetic' } }));
      const row = (await q('SELECT id FROM "S".credit_lots WHERE "sourceId" = $1', [sourceId]))[0];
      await q('UPDATE "S".credit_lots SET "createdAt" = $2 WHERE id = $1', [row.id, createdAt]);
      if (id) { await q('UPDATE "S".credit_lots SET id = $2 WHERE id = $1', [row.id, id]); return id as string; }
      return row.id as string;
    }
    const spend = (accountId: string, amount: number) => database.transaction(tx => ledger().consume(tx, { accountId, amount,
      transactionData: { type: 'CONSUME', description: 'Synthetic spend' }, consumptionData: { resourceType: 'synthetic', resourceId: randomUUID() } }));
    const remaining = async (accountId: string) => Object.fromEntries((await q('SELECT id, "remainingAmount" FROM "S".credit_lots WHERE "userId" = $1', [accountId])).map(row => [row.id, row.remainingAmount]));

    it('breaks an expiry tie by creation time, then by id', async () => {
      const owner = await user(), at = new Date(Date.now() + 10 * DAY), t0 = new Date(Date.now() - 5 * DAY);
      const newer = await grant(owner, 5, at, new Date(t0.getTime() + DAY), 'lot-m');
      const older = await grant(owner, 5, at, t0, 'lot-z');
      const sameB = await grant(owner, 5, at, new Date(t0.getTime() + 2 * DAY), 'lot-b');
      const sameA = await grant(owner, 5, at, new Date(t0.getTime() + 2 * DAY), 'lot-a');
      await spend(owner, 5); expect((await remaining(owner))[older]).toBe(0);
      await spend(owner, 5); expect((await remaining(owner))[newer]).toBe(0);
      await spend(owner, 5); expect((await remaining(owner))[sameA]).toBe(0); expect((await remaining(owner))[sameB]).toBe(5);
    });
    it('draws never-expiring credits last even when they are the oldest, and skips lots that have already expired', async () => {
      const owner = await user();
      const never = await grant(owner, 10, undefined, new Date(Date.now() - 30 * DAY));
      const soon = await grant(owner, 10, new Date(Date.now() + DAY), new Date(Date.now() - DAY));
      const dead = await grant(owner, 10, new Date(Date.now() + 5 * DAY), new Date(Date.now() - 2 * DAY));
      await q('UPDATE "S".credit_lots SET "expiresAt" = $2 WHERE id = $1', [dead, new Date(Date.now() - 1000)]); // expired but not yet swept
      await spend(owner, 4);
      expect(await remaining(owner)).toEqual({ [never]: 10, [soon]: 6, [dead]: 10 });
      await spend(owner, 10);
      expect(await remaining(owner)).toEqual({ [never]: 6, [soon]: 0, [dead]: 10 });
      await expect(spend(owner, 7)).rejects.toThrow(); // the expired lot is not spendable
      expect(await remaining(owner)).toEqual({ [never]: 6, [soon]: 0, [dead]: 10 });
    });
    it('records one allocation per drawn lot with that lot expiry, and the journal balance stays consistent', async () => {
      const owner = await user(), soonAt = new Date(Date.now() + 2 * DAY);
      const soon = await grant(owner, 3, soonAt, new Date()), never = await grant(owner, 10, undefined, new Date(Date.now() - DAY));
      const result = await spend(owner, 8);
      const allocations = await q('SELECT "creditLotId", amount, "expiresAt" FROM "S".credit_allocations WHERE "consumptionId" = $1 ORDER BY amount', [result.consumptionId]);
      expect(allocations).toEqual([{ creditLotId: soon, amount: 3, expiresAt: soonAt }, { creditLotId: never, amount: 5, expiresAt: null }]);
      expect((await q('SELECT balance FROM "S".credit_account WHERE "userId" = $1', [owner]))[0].balance).toBe(5);
      expect(Object.values(await remaining(owner)).reduce((sum, value) => sum + value, 0)).toBe(5);
    });
    it('allocates a hold over the selected lots soonest-expiring first', async () => {
      const owner = await user();
      const late = await grant(owner, 10, new Date(Date.now() + 20 * DAY), new Date(Date.now() - 3 * DAY)), soon = await grant(owner, 10, new Date(Date.now() + 2 * DAY), new Date(Date.now() - DAY));
      const held = await database.transaction(tx => ledger().hold(tx, { id: `hold-${randomUUID()}`, accountId: owner, amount: 12, lotIds: [late, soon], resourceType: 'synthetic',
        resourceId: randomUUID(), operationKey: `hold-op-${randomUUID()}`, transactionData: { type: 'FREEZE', description: 'Synthetic hold' } }));
      const rows = await q('SELECT "creditLotId", "activeAmount" FROM "S".credit_hold_allocations WHERE "holdId" = $1', [held.hold.id]);
      const byLot = Object.fromEntries(rows.map(row => [row.creditLotId as string, row.activeAmount]));
      expect(byLot).toEqual({ [soon]: 10, [late]: 2 });
    });
    it('keeps the account balance and lot totals equal under 12 concurrent spends of mixed sizes', async () => {
      const owner = await user();
      await grant(owner, 100, new Date(Date.now() + 3 * DAY), new Date(Date.now() - DAY)); await grant(owner, 100, undefined, new Date(Date.now() - 2 * DAY));
      await grant(owner, 100, new Date(Date.now() + 9 * DAY), new Date());
      const sizes = [7, 13, 29, 31, 41, 53, 61, 67, 3, 5, 11, 17];
      const results = await Promise.allSettled(sizes.map((size, index) => (index % 2 ? second : database).transaction(tx => ledger().consume(tx, { accountId: owner, amount: size,
        transactionData: { type: 'CONSUME', description: 'Synthetic spend' }, consumptionData: { resourceType: 'synthetic', resourceId: randomUUID() } }))));
      const spent = sizes.filter((_size, index) => results[index]!.status === 'fulfilled').reduce((sum, size) => sum + size, 0);
      const lotTotal = Object.values(await remaining(owner)).reduce((sum, value) => sum + value, 0);
      expect(lotTotal).toBe(300 - spent);
      expect((await q('SELECT balance FROM "S".credit_account WHERE "userId" = $1', [owner]))[0].balance).toBe(300 - spent);
      expect(Object.values(await remaining(owner)).every(value => value >= 0)).toBe(true);
    });
  });
});
