import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { LocalFileStorage, type FileManager } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../src/database';
import { PostgresFileAssetRepository } from '../src/files/file-asset.repository';
import { FileObjectIntentLostError, FileOrphanSweeper } from '../src/files/file-object-intents';
import type { FilesOptions } from '../src/files/files.config';

/**
 * The sweeper must never delete an object whose file row exists, whatever the interleaving with a
 * late `insertReady`. Real PostgreSQL row locks; the object store is a real directory.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_files_orphan_race_${randomUUID().replaceAll('-', '')}`;
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

run('orphan sweeper vs late insertReady (PostgreSQL + local objects)', () => {
  let pool: Pool, database: ApplicationDatabase, directory: string, storage: LocalFileStorage, repository: PostgresFileAssetRepository;
  const options: FilesOptions = { maxObjectBytes: 10 * 1024 * 1024, maxOwnerBytes: 1024 * 1024 * 1024, maxOwnerFiles: 10_000, orphanGraceMinutes: 60 };
  const sweeper = (manager: FileManager = storage) => new FileOrphanSweeper(database, manager, options);
  const intentCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM "${schema}".file_object_intents`)).rows[0].n as number;
  const rowFor = async (key: string) => (await pool.query(`SELECT "id" FROM "${schema}".file_assets WHERE "objectKey"=$1`, [key])).rows[0] as { id: string } | undefined;

  /** An old intent plus the bytes it guards; the owner exists so the file row can reference it. */
  async function orphanCandidate(ownerId: string, ageHours = 2) {
    const id = randomUUID(), key = `private-assets/${id}`, content = Buffer.from(`synthetic bytes ${id}`);
    await pool.query(`INSERT INTO "${schema}".file_object_intents ("objectKey","ownerId","kind","createdAt") VALUES ($1,$2,'generated',$3)`, [key, ownerId, new Date(Date.now() - ageHours * HOUR)]);
    mkdirSync(join(directory, 'private-assets'), { recursive: true }); writeFileSync(join(directory, key), content);
    const reservation = { id, scope: ownerId, idempotencyKey: `race-${id}`.slice(0, 40), objectKey: key, fileName: 'o.bin',
      sha256: createHash('sha256').update(content).digest('hex'), size: content.length, mimeType: 'application/octet-stream', createdAt: Date.now() };
    return { id, key, reservation };
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-orphan-race-')); storage = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000, max: 20 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    repository = new PostgresFileAssetRepository(database, { maxBytes: options.maxOwnerBytes!, maxFiles: options.maxOwnerFiles! });
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE "${schema}".file_object_intents, "${schema}".file_assets CASCADE`);
    rmSync(join(directory, 'private-assets'), { recursive: true, force: true });
  });
  afterAll(async () => {
    try { await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
      if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it('recorder holds the intent lock when the sweeper runs: the sweeper skips, the object survives, the row commits', async () => {
    const owner = randomUUID(), c = await orphanCandidate(owner);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN'); await holder.query(`SET LOCAL search_path TO "${schema}"`);
      await holder.query('SELECT 1 FROM file_object_intents WHERE "objectKey"=$1 FOR UPDATE', [c.key]);
      expect(await sweeper().sweep()).toEqual({ deleted: 0, released: 0, skipped: 1, failed: 0 });
      expect(existsSync(join(directory, c.key))).toBe(true);
      await holder.query(`INSERT INTO file_assets ("id","ownerId","idempotencyKey","objectKey","fileName","sha256","size","mimeType","state","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,'o.bin',$5,$6,'application/octet-stream','ready',now(),now())`, [c.id, owner, c.reservation.idempotencyKey, c.key, c.reservation.sha256, c.reservation.size]);
      await holder.query('DELETE FROM file_object_intents WHERE "objectKey"=$1', [c.key]);
      await holder.query('COMMIT');
    } finally { holder.release(); }
    expect(await sweeper().sweep()).toEqual({ deleted: 0, released: 0, skipped: 0, failed: 0 });
    expect(existsSync(join(directory, c.key))).toBe(true);
    expect(await rowFor(c.key)).toBeDefined();
  });

  it('sweeper holds the intent lock (deleting) when insertReady arrives: it waits, then fails; no row, no dangling reference', async () => {
    const owner = randomUUID(), c = await orphanCandidate(owner);
    let entered!: () => void; const inDelete = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const slowDelete: FileManager = Object.assign(Object.create(storage) as FileManager, {
      delete: async (key: string) => { entered(); await gate; return storage.delete(key); },
    });
    const sweeping = sweeper(slowDelete).sweep();
    await inDelete;
    let settled = false;
    const recording = repository.insertReady(c.reservation, c.key).then(() => { settled = true; return 'recorded'; }, (error: unknown) => { settled = true; return error; });
    await sleep(300);
    expect(settled).toBe(false); // blocked on the sweeper's row lock, not racing it
    release();
    expect(await sweeping).toEqual({ deleted: 1, released: 0, skipped: 0, failed: 0 });
    expect(await recording).toBeInstanceOf(FileObjectIntentLostError);
    expect(await rowFor(c.key)).toBeUndefined();
    expect(existsSync(join(directory, c.key))).toBe(false);
  });

  it('a recorded row that appears after the candidate scan but before the delete decision keeps the object', async () => {
    const owner = randomUUID(), c = await orphanCandidate(owner);
    // The sweeper only deletes when no row references the key inside the locked transaction.
    await pool.query(`INSERT INTO "${schema}".file_assets ("id","ownerId","idempotencyKey","objectKey","fileName","sha256","size","mimeType","state","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,'o.bin',$5,$6,'application/octet-stream','ready',now(),now())`, [c.id, owner, c.reservation.idempotencyKey, c.key, c.reservation.sha256, c.reservation.size]);
    expect(await sweeper().sweep()).toEqual({ deleted: 0, released: 1, skipped: 0, failed: 0 });
    expect(existsSync(join(directory, c.key))).toBe(true);
    expect(await intentCount()).toBe(0);
  });

  it('a public asset row referencing the key also protects the object', async () => {
    const owner = randomUUID(), key = `public-assets/${'a'.repeat(64)}.png`;
    mkdirSync(join(directory, 'public-assets'), { recursive: true }); writeFileSync(join(directory, key), 'png-bytes');
    await pool.query(`INSERT INTO "${schema}".file_object_intents ("objectKey","ownerId","kind","createdAt") VALUES ($1,$2,'public-asset',$3)`, [key, owner, new Date(Date.now() - 2 * HOUR)]);
    await pool.query(`INSERT INTO "${schema}".public_assets ("sha256","ownerId","objectKey","size","mimeType","width","height","state","createdAt","updatedAt")
      VALUES ($1,$2,$3,9,'image/png',1,1,'ready',now(),now())`, ['a'.repeat(64), owner, key]);
    expect(await sweeper().sweep()).toEqual({ deleted: 0, released: 1, skipped: 0, failed: 0 });
    expect(existsSync(join(directory, key))).toBe(true);
    rmSync(join(directory, 'public-assets'), { recursive: true, force: true });
  });

  it('failed object deletion rolls back: the intent stays for the next sweep and nothing is lost', async () => {
    const owner = randomUUID(), c = await orphanCandidate(owner);
    const outage: FileManager = Object.assign(Object.create(storage) as FileManager, {
      delete: async () => { throw new Error('synthetic storage outage'); }, exists: async () => true,
    });
    expect(await sweeper(outage).sweep()).toEqual({ deleted: 0, released: 0, skipped: 0, failed: 1 });
    expect(await intentCount()).toBe(1);
    expect(existsSync(join(directory, c.key))).toBe(true);
    expect(await sweeper().sweep()).toEqual({ deleted: 1, released: 0, skipped: 0, failed: 0 });
  });

  it('stress: 40 sweeps racing 40 late insertReady calls never leave a row without its object', async () => {
    const owner = randomUUID(), cases = await Promise.all(Array.from({ length: 40 }, () => orphanCandidate(owner)));
    const recorders = cases.map(async (c, index) => {
      await sleep(index % 7); // vary arrival against the sweepers
      return repository.insertReady(c.reservation, c.key).then(() => 'recorded' as const, (error: unknown) => error);
    });
    const sweeps = Array.from({ length: 4 }, async (_unused, round) => { await sleep(round * 3); return sweeper().sweep(); });
    const [outcomes] = await Promise.all([Promise.all(recorders), Promise.all(sweeps)]);
    await sweeper().sweep(); // anything left over is handled by a later pass
    let recorded = 0;
    for (const [index, c] of cases.entries()) {
      const row = await rowFor(c.key), present = existsSync(join(directory, c.key));
      if (row) { recorded++; expect(present, `row without object: ${c.key}`).toBe(true); expect(outcomes[index]).toBe('recorded'); }
      else { expect(outcomes[index]).toBeInstanceOf(FileObjectIntentLostError); expect(present, `orphan left: ${c.key}`).toBe(false); }
    }
    expect(await intentCount()).toBe(0);
    expect(recorded).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('a replayed request keeps the intent so the caller can still delete its own unrecorded object', async () => {
    const owner = randomUUID(), first = await orphanCandidate(owner, 0), second = await orphanCandidate(owner, 0);
    await repository.insertReady(first.reservation, first.key);
    const replay = await repository.insertReady({ ...second.reservation, idempotencyKey: first.reservation.idempotencyKey }, second.key);
    expect(replay.id).toBe(first.id);
    const left = (await pool.query(`SELECT "objectKey" FROM "${schema}".file_object_intents`)).rows.map(row => row.objectKey);
    expect(left).toEqual([second.key]);
    expect(await rowFor(second.key)).toBeUndefined();
  });
});
