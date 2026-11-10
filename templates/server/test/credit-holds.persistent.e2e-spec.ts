import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { BatchCreditInsufficientError, CreditHoldMigrationRequiredError, CreditLotHeldError, CreditLotHoldError, PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import type { CreateCreditLotHold } from '@zucker-framework/credit';
import type { DurableTaskAttemptContext } from '@zucker-framework/task';
import { ApplicationDatabase } from '../src/database';
import { createCreditLedger } from '../src/billing/ledger';
import { CreditsService, readCreditBalance } from '../src/credits/credits.service';
import { CREDIT_EXPIRY_JOB, CreditsRuntime } from '../src/credits/credits.runtime';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { DeliveryService } from '../src/delivery/delivery.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_holds_${randomUUID().replaceAll('-', '')}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
run('credit lot wallet holds on actual PostgreSQL', () => {
  let pool: Pool, first: ApplicationDatabase, second: ApplicationDatabase, scopedUrl: string, ownerId: string, otherId: string;
  const hosts: JobsHost[] = [];
  const ledger = () => createCreditLedger(first);
  const table = async (name: string) => (await pool.query(`SELECT * FROM "${schema}"."${name}"`)).rows;
  async function grant(value = 10, expiresAt?: Date, owner = ownerId, source = 'purchase') {
    const id = randomUUID();
    await first.transaction(tx => ledger().grant(tx, { accountId: owner, amount: value, source, sourceId: id, expiresAt,
      operation: { accountId: owner, amount: value, idempotencyKey: `grant:${id}`, operationType: 'SYNTHETIC_GRANT', resourceType: 'test-receipt', resourceId: id },
      transactionData: { type: 'GRANT', description: 'Synthetic credits' } }));
    const rows = await first.model('creditLots').findMany({ where: { userId: owner, sourceId: id }, select: { id: true } }) as Array<{ id: string }>;
    return rows[0].id;
  }
  function intent(lotIds: string[], amount = 6, accountId = ownerId): CreateCreditLotHold {
    const id = randomUUID(); return { id, accountId, amount, lotIds, resourceType: 'refund-request', resourceId: id,
      operationKey: `hold:${id}`, transactionData: { type: 'FREEZE', metadata: { holdId: id } } };
  }
  const reserve = (input: CreateCreditLotHold, database = first) => database.transaction(tx => createCreditLedger(database).hold(tx, input));
  const settle = (input: CreateCreditLotHold, phase: 'confirm' | 'release', database = first, now?: Date) => database.transaction(tx =>
    createCreditLedger(database)[phase === 'confirm' ? 'confirmHold' : 'releaseHold'](tx, { id: input.id, accountId: input.accountId,
      operationKey: `${phase}:${input.id}`, transactionData: { type: phase === 'confirm' ? 'REVOKE' : 'UNFREEZE', metadata: { holdId: input.id } },
      expiryTransactionData: { type: 'EXPIRE', metadata: { holdId: input.id } } }, now));
  const consume = (amount: number, database = first, extra: object = {}) => database.transaction(tx => createCreditLedger(database).consume(tx, {
    accountId: ownerId, amount, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic-operation', resourceId: randomUUID() }, ...extra }));
  async function fail(tableName: 'credit_hold_allocations' | 'credit_account' | 'credit_transaction', event: 'INSERT' | 'UPDATE', condition: string, work: () => Promise<void>, skip = false) {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_hold_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${skip ? 'RETURN NULL;' : "RAISE EXCEPTION 'Synthetic hold persistence failure';"} END; $$`);
    try { await pool.query(`CREATE TRIGGER synthetic_hold_failure BEFORE ${event} ON "${schema}"."${tableName}" FOR EACH ROW ${condition} EXECUTE FUNCTION "${schema}".synthetic_hold_failure()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER synthetic_hold_failure ON "${schema}"."${tableName}"`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_hold_failure()`); }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; first = new ApplicationDatabase(scopedUrl); second = new ApplicationDatabase(scopedUrl);
    ownerId = randomUUID(); otherId = randomUUID();
    for (const id of [ownerId, otherId]) await first.model('users').create({ data: { id, username: `holds_${id.replaceAll('-', '')}`, name: 'Synthetic hold owner', typeId: 'member', email: `${id}@example.invalid`, emailVerified: true, status: true } });
  });
  beforeEach(async () => { await pool.query(`TRUNCATE "${schema}".credit_holds,"${schema}".credit_account,"${schema}".credit_transaction,"${schema}".credit_lots,"${schema}".credit_operation_receipts,"${schema}".async_jobs CASCADE`); });
  afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())); });
  afterAll(async () => { try { await Promise.all([first?.disconnect(), second?.disconnect()]); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('holds an exact partial amount, excludes it from all consumption and confirms only that allocation', async () => {
    const lotId = await grant(), input = intent([lotId]); expect(await reserve(input)).toMatchObject({ changed: true, hold: { amount: 6, activeAmount: 6 } });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 4, frozen: 6, bookBalance: 4 });
    expect((await new CreditsService(first).lots(ownerId, { page: 1, pageSize: 20 })).data[0]).toMatchObject({ availableAmount: 4, frozenAmount: 6 });
    await consume(4, second); await expect(consume(1)).rejects.toBeInstanceOf(BatchCreditInsufficientError);
    expect(await settle(input, 'confirm')).toMatchObject({ changed: true, hold: { amount: 6, activeAmount: 0, revokedAmount: 6, expiredAmount: 0 } });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 0, frozen: 0 }); expect((await table('credit_lots'))[0].remainingAmount).toBe(0);
    expect((await table('credit_allocations')).map(row => row.amount)).toEqual([4]);
    expect(await settle(input, 'confirm', second)).toMatchObject({ changed: false });
    expect((await table('credit_transaction')).filter(row => row.type === 'REVOKE')).toHaveLength(1);
  });

  it('releases once after a negative decision and refuses the opposite final decision', async () => {
    const input = intent([await grant()]); await reserve(input);
    expect(await settle(input, 'release')).toMatchObject({ hold: { amount: 6, releasedAmount: 6, status: 'RELEASED' } });
    expect(await settle(input, 'release', second)).toMatchObject({ changed: false });
    await expect(settle(input, 'confirm')).rejects.toMatchObject({ reason: 'conflict' });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 10, frozen: 0 }); await consume(10);
    expect((await table('credit_transaction')).filter(row => row.type === 'UNFREEZE')).toHaveLength(1);
  });

  it('deduplicates concurrent stable reservations and detects changed identity', async () => {
    const input = intent([await grant()]); const results = await Promise.all([reserve(input), reserve(input, second)]);
    expect(results.map(result => result.changed).sort()).toEqual([false, true]); expect(await table('credit_holds')).toHaveLength(1);
    expect((await table('credit_operation_receipts')).filter(row => row.operationType === 'CREDIT_HOLD_CREATE')).toHaveLength(1);
    await expect(reserve({ ...input, amount: 5 })).rejects.toMatchObject({ reason: 'conflict' });
    await expect(reserve({ ...input, resourceId: 'changed' })).rejects.toMatchObject({ reason: 'conflict' });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 4, frozen: 6 });
  });

  it('serializes a hold against concurrent consumption without overspending', async () => {
    const input = intent([await grant()], 8); const outcomes = await Promise.allSettled([reserve(input), consume(5, second)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: expect.any(BatchCreditInsufficientError) });
    const account = (await table('credit_account'))[0], lot = (await table('credit_lots'))[0];
    expect(account.balance + account.frozenBalance).toBe(lot.remainingAmount); expect(account.balance).toBeGreaterThanOrEqual(0);
  });

  it('never holds consumed amounts or silently accepts another owner’s selected lot', async () => {
    const owned = await grant(), foreign = await grant(20, undefined, otherId); await consume(3);
    await expect(reserve(intent([owned], 8))).rejects.toMatchObject({ available: 7 });
    await expect(reserve(intent([owned, foreign], 1))).rejects.toMatchObject({ reason: 'not_found' });
    expect(await table('credit_holds')).toHaveLength(0); expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 7, frozen: 0 });
  });

  it('falls back from a fully held preferred source to other permitted lots', async () => {
    const preferred = await grant(4, undefined, ownerId, 'purchase'); await grant(6, undefined, ownerId, 'subscription');
    await reserve(intent([preferred], 4));
    expect(await consume(2, first, { preferredSource: 'purchase', allowedSources: ['purchase', 'subscription'] })).toMatchObject({ consumedSource: 'subscription' });
    expect((await table('credit_lots')).find(row => row.id === preferred).remainingAmount).toBe(4);
  });

  it.each(['confirm', 'release'] as const)('preserves full expiry evidence before a later %s decision', async phase => {
    const lotId = await grant(10, new Date('2030-01-01')), input = intent([lotId], 10); await reserve(input);
    expect(await first.transaction(tx => ledger().expireInTransaction(tx, { accountId: ownerId, lotIds: [lotId], transactionData: { type: 'EXPIRE' } }, new Date('2031-01-01')))).toBe(10);
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 0, frozen: 0, expired: 10 });
    const held = (await table('credit_holds'))[0]; expect(held).toMatchObject({ amount: 10, status: 'HELD', settledAt: null });
    const result = await settle(input, phase, second); expect(result.hold).toMatchObject({ amount: 10, activeAmount: 0, expiredAmount: 10, revokedAmount: 0, releasedAmount: 0 });
    expect(result.hold.allocations[0].expiredAt).toEqual(new Date('2031-01-01'));
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 0, frozen: 0, bookBalance: 0 });
    expect((await table('credit_transaction')).filter(row => row.type === 'EXPIRE')).toHaveLength(1);
    expect((await table('credit_transaction')).find(row => row.type === 'EXPIRE')).toMatchObject({ amount: -10, balanceBefore: 0, balanceAfter: 0, frozenBalanceBefore: 10, frozenBalanceAfter: 0 });
  });

  it('settles mixed source allocations without losing the expired portion of the original hold', async () => {
    const expiring = await grant(5, new Date('2030-01-01')), persistent = await grant(10), input = intent([expiring, persistent], 7); await reserve(input);
    const result = await settle(input, 'confirm', first, new Date('2031-01-01'));
    expect(result.hold).toMatchObject({ amount: 7, expiredAmount: 5, revokedAmount: 2, activeAmount: 0 });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 8, frozen: 0, expired: 5 });
    expect((await table('credit_lots')).find(row => row.id === persistent).remainingAmount).toBe(8);
  });

  it('shows only effective frozen value after a real deadline and expires before releasing it', async () => {
    const deadline = new Date(Date.now() + 1500), lotId = await grant(10, deadline), input = intent([lotId]); await reserve(input);
    await new Promise(done => setTimeout(done, Math.max(0, deadline.getTime() - Date.now()) + 30));
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 0, frozen: 0, pendingExpiry: 10, bookBalance: 4, bookFrozenBalance: 6 });
    expect((await new CreditsService(first).lots(ownerId, { page: 1, pageSize: 20 })).data[0]).toMatchObject({ availableAmount: 0, frozenAmount: 0, status: 'expired' });
    expect((await settle(input, 'release')).hold).toMatchObject({ amount: 6, expiredAmount: 6, releasedAmount: 0 });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 0, frozen: 0, expired: 10, pendingExpiry: 0, bookBalance: 0 });
  });

  it('uses a fresh default settlement time after waiting for the account lock', async () => {
    const deadline = new Date(Date.now() + 1500), input = intent([await grant(10, deadline)]); await reserve(input);
    const locked = deferred(), release = deferred(), coordinator = new PostgresCreditOperationCoordinator();
    const blocker = first.transaction(async tx => { await coordinator.lockAccount(tx, ownerId); locked.resolve(); await release.promise; });
    await locked.promise; const pending = settle(input, 'release', second);
    try { await new Promise(done => setTimeout(done, Math.max(0, deadline.getTime() - Date.now()) + 30)); }
    finally { release.resolve(); await blocker; }
    expect((await pending).hold).toMatchObject({ expiredAmount: 6, releasedAmount: 0 });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ bookBalance: 0, frozen: 0, expired: 10 });
  });

  it.each(['credit_hold_allocations', 'credit_account', 'credit_transaction'] as const)('rolls a failed reservation at %s back with its receipt and journal', async location => {
    const input = intent([await grant()]);
    await fail(location, location === 'credit_account' ? 'UPDATE' : 'INSERT', '', async () => { await expect(reserve(input)).rejects.toThrow(); });
    expect(await table('credit_holds')).toHaveLength(0); expect(await table('credit_hold_allocations')).toHaveLength(0);
    expect((await table('credit_operation_receipts')).filter(row => row.operationType.startsWith('CREDIT_HOLD'))).toHaveLength(0);
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 10, frozen: 0 }); expect(await table('credit_transaction')).toHaveLength(1);
  });

  it.each(['confirm', 'release'] as const)('rolls a failed %s journal back without changing the hold or balances', async phase => {
    const input = intent([await grant()]); await reserve(input);
    const type = phase === 'confirm' ? 'REVOKE' : 'UNFREEZE';
    await fail('credit_transaction', 'INSERT', `WHEN (NEW.type='${type}')`, async () => { await expect(settle(input, phase)).rejects.toThrow(); });
    expect((await table('credit_holds'))[0].status).toBe('HELD'); expect((await table('credit_hold_allocations'))[0].activeAmount).toBe(6);
    expect((await table('credit_lots'))[0].remainingAmount).toBe(10); expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 4, frozen: 6 });
    expect((await table('credit_operation_receipts')).filter(row => row.operationType === `CREDIT_HOLD_${phase.toUpperCase()}`)).toHaveLength(0);
    expect((await settle(input, phase)).changed).toBe(true);
  });

  it('rolls expiry allocation, lot and frozen/free balances back if its journal fails', async () => {
    const lotId = await grant(10, new Date('2030-01-01')), input = intent([lotId]); await reserve(input);
    await fail('credit_transaction', 'INSERT', "WHEN (NEW.type='EXPIRE')", async () => {
      await expect(first.transaction(tx => ledger().expireInTransaction(tx, { accountId: ownerId, lotIds: [lotId], transactionData: { type: 'EXPIRE' } }, new Date('2031-01-01')))).rejects.toThrow();
    });
    expect((await table('credit_lots'))[0].isExpired).toBe(false); expect((await table('credit_hold_allocations'))[0]).toMatchObject({ activeAmount: 6, expiredAmount: 0 });
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 4, frozen: 6 });
  });

  it('refuses a lost allocation CAS instead of reporting successful settlement', async () => {
    const input = intent([await grant()]); await reserve(input);
    await fail('credit_hold_allocations', 'UPDATE', '', async () => { await expect(settle(input, 'confirm')).rejects.toBeInstanceOf(CreditLotHoldError); }, true);
    expect((await table('credit_holds'))[0].status).toBe('HELD'); expect((await table('credit_lots'))[0].remainingAmount).toBe(10);
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 4, frozen: 6 });
  });

  it('rejects legacy unallocated freezing instead of guessing which expiry source to debit', async () => {
    const lotId = await grant(10, new Date('2030-01-01'));
    await first.model('creditAccount').update({ where: { userId: ownerId }, data: { balance: 7, frozenBalance: 3 } });
    await expect(readCreditBalance(first, ownerId)).rejects.toBeInstanceOf(CreditHoldMigrationRequiredError);
    await expect(consume(1)).rejects.toBeInstanceOf(CreditHoldMigrationRequiredError);
    await expect(reserve(intent([lotId]))).rejects.toBeInstanceOf(CreditHoldMigrationRequiredError);
    await expect(first.transaction(tx => ledger().expireInTransaction(tx, { accountId: ownerId, lotIds: [lotId], transactionData: { type: 'EXPIRE' } }, new Date('2031-01-01')))).rejects.toBeInstanceOf(CreditHoldMigrationRequiredError);
    expect((await table('credit_account'))[0]).toMatchObject({ balance: 7, frozenBalance: 3 }); expect(await table('credit_holds')).toHaveLength(0);
  });

  it('protects active holds from unrelated revocation and prevents evidence rewrites', async () => {
    const lotId = await grant(), input = intent([lotId]); await reserve(input);
    await expect(pool.query(`INSERT INTO "${schema}".credit_holds (id,"accountId",amount,"selectedLotIds","resourceType") VALUES ($1,$2,1,NULL,'synthetic')`,
      [randomUUID(), ownerId])).rejects.toThrow(/check constraint/);
    await expect(first.transaction(tx => ledger().revokeUnused(tx, { accountId: ownerId, lotIds: [lotId], transactionData: { type: 'REVOKE' } }))).rejects.toBeInstanceOf(CreditLotHeldError);
    await expect(pool.query(`UPDATE "${schema}".credit_holds SET amount=5 WHERE id=$1`, [input.id])).rejects.toThrow(/immutable/);
    await settle(input, 'release');
    await expect(pool.query(`UPDATE "${schema}".credit_hold_allocations SET "activeAmount"=1,"releasedAmount"=5 WHERE "holdId"=$1`, [input.id])).rejects.toThrow(/reversed/);
    await expect(pool.query(`UPDATE "${schema}".credit_holds SET status='HELD',"settledAt"=NULL WHERE id=$1`, [input.id])).rejects.toThrow(/immutable/);
  });

  it('keeps enough integer headroom to release the entire frozen wallet later', async () => {
    const input = intent([await grant(2147483647)], 1); await reserve(input);
    await expect(grant(1)).rejects.toBeInstanceOf(CreditLotHoldError); await settle(input, 'release');
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 2147483647, frozen: 0 });
  });

  it('retains an unknown outstanding hold across a fresh Node process without an automatic TTL', async () => {
    const input = intent([await grant()]); await reserve(input); const directory = mkdtempSync(join(tmpdir(), 'zucker-hold-worker-')), path = join(directory, 'worker.cjs');
    writeFileSync(path, String.raw`
const {createRequire}=require('node:module');const {resolve}=require('node:path');const load=createRequire(resolve('package.json'));load('tsx/cjs');load('reflect-metadata');
const {ApplicationDatabase}=load('./src/database.ts');const {createCreditLedger}=load('./src/billing/ledger.ts');
(async()=>{let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);const db=new ApplicationDatabase(process.env.TEST_DATABASE_URL);
try{const result=await db.transaction(tx=>createCreditLedger(db).hold(tx,input));process.stdout.write('EVIDENCE:'+JSON.stringify({pid:process.pid,changed:result.changed,status:result.hold.status,amount:result.hold.amount,activeAmount:result.hold.activeAmount}));}
finally{await db.disconnect();}})().catch(()=>{process.stderr.write('Synthetic hold restart failed');process.exitCode=1;});
`);
    try { const child = spawn(process.execPath, [path], { cwd: resolve('.'), env: { ...process.env, TEST_DATABASE_URL: scopedUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = await new Promise<string>((done, reject) => { let value = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic hold restart timed out')); }, 10000);
        child.stdout.on('data', chunk => { value += chunk; }); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? done(value) : reject(new Error('Synthetic hold restart failed')); }); child.stdin.end(JSON.stringify(input)); });
      const evidence = JSON.parse(output.slice(output.indexOf('EVIDENCE:') + 9)); expect(evidence).toMatchObject({ changed: false, status: 'HELD', amount: 6, activeAmount: 6 }); expect(evidence.pid).not.toBe(process.pid);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('expires held lots only under a live maintenance lease and commits its journal once', async () => {
    const deadline = new Date(Date.now() + 1500), lotId = await grant(10, deadline), input = intent([lotId]); await reserve(input);
    await new Promise(done => setTimeout(done, Math.max(0, deadline.getTime() - Date.now()) + 30));
    const jobs = new JobsService(first), runtime = new CreditsRuntime(first, jobs), delivery = new DeliveryService(first, { accountScope: '', leaseMs: 2000, heartbeatMs: 500 });
    runtime.onModuleInit(); const host = new JobsHost(jobs, delivery, { enabled: false, workerId: 'held-expiry', concurrency: 1, scanIntervalMs: 100, leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 }); hosts.push(host);
    await runtime.scheduleDue(); const task = (await jobs.list(ownerId))[0];
    const claimed = (await jobs.repository.claim({ id: task.id, workerId: 'expired', leaseToken: 'stale-hold-expiry', now: new Date(), leaseExpiresAt: new Date(Date.now() + 2000) }))!;
    await pool.query(`UPDATE "${schema}".async_jobs SET "leaseExpiresAt"=$2 WHERE id=$1`, [task.id, new Date(Date.now() - 1000)]);
    const context: DurableTaskAttemptContext = { task: claimed, leaseToken: 'stale-hold-expiry', signal: new AbortController().signal, now: () => new Date(), assertActive: async () => {}, reportProgress: async () => claimed };
    expect(await jobs.handler(CREDIT_EXPIRY_JOB, '1')!.complete!(context, {})).toBe(false);
    expect((await table('credit_account'))[0]).toMatchObject({ balance: 4, frozenBalance: 6 });
    await jobs.repository.recoverExpiredLease({ id: task.id, leaseToken: context.leaseToken, now: new Date(), error: { code: 'SYNTHETIC', category: 'INTERNAL', retryable: true, summary: 'Synthetic lease recovery' } });
    await host.runTask(task.id); await runtime.scheduleDue();
    expect(await readCreditBalance(first, ownerId)).toMatchObject({ available: 0, frozen: 0, expired: 10 });
    expect((await table('credit_transaction')).filter(row => row.type === 'EXPIRE')).toHaveLength(1);
  });
});
