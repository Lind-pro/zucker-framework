import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { LocalFileStorage, type FileManager } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../src/database';
import { FilesService } from '../src/files/files.service';
import { FileOrphanSweeper, ORPHAN_SWEEP_BATCH } from '../src/files/file-object-intents';
import { filesOptionsFromEnvironment, type FilesOptions } from '../src/files/files.config';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_files_orphans_${randomUUID().replaceAll('-', '')}`;
const MiB = 1024 * 1024, HOUR = 3_600_000;

function bytes(total: number, fill = 7): Readable {
  let sent = 0;
  return Readable.from((function* () {
    while (sent < total) { const piece = Buffer.alloc(Math.min(MiB, total - sent), fill); sent += piece.length; yield piece; }
  })());
}

run('write-ahead object intents and the file-orphans sweeper (PostgreSQL + local storage)', () => {
  let pool: Pool, database: ApplicationDatabase, directory: string, storage: LocalFileStorage;
  const options: FilesOptions = { maxObjectBytes: 10 * MiB, maxOwnerBytes: 1024 * MiB, maxOwnerFiles: 1000, orphanGraceMinutes: 60 };
  const files = (manager: FileManager = storage) => new FilesService(database, manager, options);
  const sweeper = (manager: FileManager = storage) => new FileOrphanSweeper(database, manager, options);
  const intents = async () => (await pool.query(`SELECT "objectKey","ownerId","kind","createdAt" FROM "${schema}".file_object_intents ORDER BY "objectKey"`)).rows as
    Array<{ objectKey: string; ownerId: string; kind: string; createdAt: Date }>;
  const objects = () => { try { return readdirSync(join(directory, 'private-assets')).sort(); } catch { return []; } };
  const later = (hours = 2) => new Date(Date.now() + hours * HOUR);
  /** The state a crash between upload and record leaves: an intent and an object no row references. */
  async function crashed(ownerId: string, createdAt = new Date(Date.now() - 2 * HOUR)): Promise<string> {
    const key = `private-assets/${randomUUID()}`;
    await pool.query(`INSERT INTO "${schema}".file_object_intents ("objectKey","ownerId","kind","createdAt") VALUES ($1,$2,'generated',$3)`, [key, ownerId, createdAt]);
    mkdirSync(join(directory, 'private-assets'), { recursive: true }); writeFileSync(join(directory, key), 'orphaned synthetic bytes');
    return key;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-files-orphans-')); storage = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
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

  it('FILES_ORPHAN_GRACE_MINUTES defaults to 60 and is validated', () => {
    expect(filesOptionsFromEnvironment({}).orphanGraceMinutes).toBe(60);
    expect(filesOptionsFromEnvironment({ FILES_ORPHAN_GRACE_MINUTES: '5' }).orphanGraceMinutes).toBe(5);
    for (const value of ['0', '-1', '1.5', 'abc', '10081']) expect(() => filesOptionsFromEnvironment({ FILES_ORPHAN_GRACE_MINUTES: value })).toThrow(/FILES_ORPHAN_GRACE_MINUTES/);
  });

  it('records the intent before the upload and removes it with the row; failures leave neither object nor intent', async () => {
    const owner = randomUUID();
    let seen: Array<{ objectKey: string }> = [];
    const watching: FileManager = Object.assign(Object.create(storage) as FileManager, {
      uploadStream: async (stream: Readable, key: string, upload?: object) => { seen = await intents(); return storage.uploadStream(stream, key, upload); },
    });
    const asset = await files(watching).storeGenerated(owner, 'intent-success-key-01', { fileName: 'a.bin', stream: bytes(3 * MiB), maxBytes: 10 * MiB });
    expect(seen.map(row => row.objectKey)).toEqual([asset.objectKey]);
    expect(await intents()).toEqual([]);
    await expect(files().storeGenerated(owner, 'intent-too-large-key1', { fileName: 'b.bin', stream: bytes(3 * MiB), maxBytes: 2 * MiB }))
      .rejects.toMatchObject({ response: { code: 'FILE_TOO_LARGE' } });
    expect(await intents()).toEqual([]);
    expect(objects()).toEqual([asset.objectKey.split('/')[1]]);
  });

  it('keeps the intent when the unrecorded object cannot be deleted, and the sweeper clears it later', async () => {
    const owner = randomUUID();
    const flaky: FileManager = Object.assign(Object.create(storage) as FileManager, { delete: async () => { throw new Error('synthetic delete outage'); } });
    await pool.query(`CREATE FUNCTION "${schema}".reject_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic record failure'; END $$`);
    try {
      await pool.query(`CREATE TRIGGER reject_asset BEFORE INSERT ON "${schema}".file_assets FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_asset()`);
      await expect(files(flaky).storeGenerated(owner, 'intent-record-fail-01', { fileName: 'c.bin', stream: bytes(MiB), maxBytes: 10 * MiB })).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS reject_asset ON "${schema}".file_assets`); await pool.query(`DROP FUNCTION "${schema}".reject_asset()`);
    }
    const [left] = await intents();
    expect(left).toMatchObject({ ownerId: owner, kind: 'generated' });
    expect(objects()).toEqual([left.objectKey.split('/')[1]]);
    // Within the grace period nothing happens; afterwards the object and the intent go.
    expect(await sweeper().sweep()).toEqual({ deleted: 0, released: 0, skipped: 0, failed: 0 });
    expect(await sweeper().sweep(later())).toEqual({ deleted: 1, released: 0, skipped: 0, failed: 0 });
    expect(await intents()).toEqual([]); expect(objects()).toEqual([]);
  });

  it('clears a crash between store and record, honours the grace period, and tolerates a missing object', async () => {
    const owner = randomUUID();
    const old = await crashed(owner), fresh = await crashed(owner, new Date());
    const missing = `private-assets/${randomUUID()}`;
    await pool.query(`INSERT INTO "${schema}".file_object_intents ("objectKey","ownerId","kind","createdAt") VALUES ($1,$2,'generated',$3)`, [missing, owner, new Date(Date.now() - 2 * HOUR)]);
    expect(await sweeper().sweep()).toEqual({ deleted: 2, released: 0, skipped: 0, failed: 0 });
    expect((await intents()).map(row => row.objectKey)).toEqual([fresh]);
    expect(existsSync(join(directory, old))).toBe(false); expect(existsSync(join(directory, fresh))).toBe(true);
  });

  it('never deletes an object a file row references; it only drops the intent', async () => {
    const owner = randomUUID();
    const asset = await files().storeGenerated(owner, 'intent-referenced-001', { fileName: 'd.bin', stream: bytes(MiB), maxBytes: 10 * MiB });
    await pool.query(`INSERT INTO "${schema}".file_object_intents ("objectKey","ownerId","kind","createdAt") VALUES ($1,$2,'generated',$3)`, [asset.objectKey, owner, new Date(0)]);
    expect(await sweeper().sweep()).toEqual({ deleted: 0, released: 1, skipped: 0, failed: 0 });
    expect(await intents()).toEqual([]);
    expect(existsSync(join(directory, asset.objectKey))).toBe(true);
    expect((await files().open(owner, asset.id)).asset.id).toBe(asset.id);
  });

  it('refuses intents for keys outside the server-owned prefixes', async () => {
    for (const key of ['../etc/passwd', 'private-assets/../x', 'other/abc', `public-assets/${randomUUID()}`])
      await expect(pool.query(`INSERT INTO "${schema}".file_object_intents ("objectKey","ownerId","kind") VALUES ($1,'o','generated')`, [key])).rejects.toThrow(/check/i);
  });

  it('two sweepers racing handle each key exactly once', async () => {
    const owner = randomUUID(), keys: string[] = [];
    for (let index = 0; index < 12; index++) keys.push(await crashed(owner));
    const [first, second] = await Promise.all([sweeper().sweep(), sweeper().sweep()]);
    expect(first.deleted + second.deleted).toBe(12);
    expect(first.failed + second.failed).toBe(0);
    expect(await intents()).toEqual([]); expect(objects()).toEqual([]);
  });

  it('works in batches and is throttled per process when driven by the Jobs wake source', async () => {
    const owner = randomUUID();
    for (let index = 0; index < ORPHAN_SWEEP_BATCH + 3; index++) await crashed(owner);
    const worker = sweeper(), now = Date.now();
    expect((await worker.runIfDue(now))?.deleted).toBe(ORPHAN_SWEEP_BATCH);
    expect(await worker.runIfDue(now + 1000)).toBeNull();
    expect((await worker.runIfDue(now + 61_000))?.deleted).toBe(3);
  });

  it('a concurrent duplicate request records one file, keeps one object and leaves no intent', async () => {
    const owner = randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => files().storeGenerated(owner, 'intent-concurrent-key1', { fileName: 'e.bin', stream: bytes(2 * MiB), maxBytes: 10 * MiB })));
    expect(a.id).toBe(b.id);
    expect(objects()).toEqual([a.objectKey.split('/')[1]]);
    expect(await intents()).toEqual([]);
  });

  it('an upload whose intent the sweeper reclaimed is never recorded', async () => {
    const owner = randomUUID();
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let started!: () => void; const begun = new Promise<void>(done => { started = done; });
    const slow = Readable.from((async function* () { yield Buffer.alloc(MiB, 1); started(); await gate; yield Buffer.alloc(MiB, 2); })());
    const pending = files().storeGenerated(owner, 'intent-swept-upload1', { fileName: 'f.bin', stream: slow, maxBytes: 10 * MiB });
    await begun;
    expect((await sweeper().sweep(later())).deleted).toBe(1);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'UPLOAD_UNVERIFIED' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".file_assets WHERE "ownerId"=$1`, [owner])).rows[0].n).toBe(0);
    expect(await intents()).toEqual([]);
  });
});
