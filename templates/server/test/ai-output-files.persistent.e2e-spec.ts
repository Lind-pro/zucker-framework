import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { LocalFileStorage } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../src/database';
import { FilesService } from '../src/files/files.service';
import { aiOutputMaxBytesFromEnvironment, DEFAULT_AI_OUTPUT_MAX_BYTES } from '../src/ai-tasks/ai-tasks.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_ai_output_files_${randomUUID().replaceAll('-', '')}`;
const MiB = 1024 * 1024;

/** Synthetic MP4-like bytes produced 1 MiB at a time (never held whole by the test). */
function video(totalBytes: number): { stream: Readable; sha256: () => string } {
  const hash = createHash('sha256');
  let sent = 0;
  const stream = Readable.from((function* () {
    while (sent < totalBytes) {
      const piece = Buffer.alloc(Math.min(MiB, totalBytes - sent), sent === 0 ? 0 : 9);
      if (sent === 0) Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]).copy(piece);
      sent += piece.length; hash.update(piece);
      yield piece;
    }
  })());
  return { stream, sha256: () => hash.digest('hex') };
}
async function digest(stream: Readable): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: hash.digest('hex'), bytes };
}

run('AI outputs as streamed private files (PostgreSQL + local storage)', () => {
  let pool: Pool, database: ApplicationDatabase, directory: string, storage: LocalFileStorage;
  const owner = randomUUID();
  const service = (maxOwnerBytes = 1024 * MiB) => new FilesService(database, storage, { maxObjectBytes: 10 * MiB, maxOwnerBytes, maxOwnerFiles: 100 });
  const objects = () => { try { return readdirSync(join(directory, 'private-assets')).length; } catch { return 0; } };

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-ai-output-files-')); storage = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
  });
  afterAll(async () => {
    try { await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
      if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it('AI_OUTPUT_MAX_BYTES defaults to 200 MiB and rejects invalid values', () => {
    expect(aiOutputMaxBytesFromEnvironment({})).toBe(DEFAULT_AI_OUTPUT_MAX_BYTES);
    expect(DEFAULT_AI_OUTPUT_MAX_BYTES).toBe(209715200);
    expect(aiOutputMaxBytesFromEnvironment({ AI_OUTPUT_MAX_BYTES: '52428800' })).toBe(50 * MiB);
    for (const value of ['0', '-1', '1.5', '1e9', 'abc', String(2 * 1024 * MiB)])
      expect(() => aiOutputMaxBytesFromEnvironment({ AI_OUTPUT_MAX_BYTES: value })).toThrow(/AI_OUTPUT_MAX_BYTES/);
  });

  it('streams a 50 MiB output into a ready private file that downloads as a verified stream; replays reuse it', async () => {
    const files = service(), source = video(50 * MiB);
    const asset = await files.storeGenerated(owner, 'ait-streamed-video-0001', { fileName: 'ai-video-1.mp4', stream: source.stream, maxBytes: 200 * MiB });
    expect(asset).toMatchObject({ state: 'ready', size: 50 * MiB, sha256: source.sha256() });
    expect((await files.usage(owner)).bytes).toBe(50 * MiB);
    const read = await files.open(owner, asset.id);
    expect('stream' in read && read.size).toBe(50 * MiB);
    if ('stream' in read) expect(await digest(read.stream)).toEqual({ sha256: asset.sha256, bytes: 50 * MiB });
    const replay = video(MiB);
    const again = await files.storeGenerated(owner, 'ait-streamed-video-0001', { fileName: 'ai-video-1.mp4', stream: replay.stream, maxBytes: 200 * MiB });
    expect(again.id).toBe(asset.id);
    expect(replay.stream.destroyed).toBe(true);
    expect(objects()).toBe(1);
  }, 60_000);

  it('removes the partial object when the cap is exceeded or the owner quota is full', async () => {
    const before = objects();
    await expect(service().storeGenerated(owner, 'ait-too-large-video-01', { fileName: 'big.mp4', stream: video(3 * MiB).stream, maxBytes: 2 * MiB }))
      .rejects.toMatchObject({ response: { code: 'FILE_TOO_LARGE' } });
    await expect(service(51 * MiB).storeGenerated(owner, 'ait-over-quota-video-1', { fileName: 'quota.mp4', stream: video(2 * MiB).stream, maxBytes: 200 * MiB }))
      .rejects.toMatchObject({ response: { code: 'FILE_QUOTA_EXCEEDED' } });
    expect(objects()).toBe(before);
    expect((await service().usage(owner)).files).toBe(1);
  }, 60_000);
});
