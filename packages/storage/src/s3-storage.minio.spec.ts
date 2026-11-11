// @vitest-environment node
// Real S3 protocol check against a local MinIO. Opt-in:
//   S3_MINIO_ENDPOINT=http://127.0.0.1:9000 S3_MINIO_KEY=... S3_MINIO_SECRET=... vitest run packages/storage/src/s3-storage.minio.spec.ts
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, HeadObjectCommand, ListMultipartUploadsCommand, ListObjectsV2Command, S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { S3Storage } from './s3-storage';

const endpoint = process.env.S3_MINIO_ENDPOINT;
const run = endpoint ? describe : describe.skip;
const MiB = 1024 * 1024;
const PART = 5 * MiB;

/** Deterministic bytes: content depends on position, so a reordered or dropped part changes the hash. */
function source(total: number, options: { failAfter?: number; failWith?: Error; chunk?: number } = {}) {
  const hash = createHash('sha256');
  let sent = 0;
  const chunk = options.chunk ?? 1_000_003; // deliberately not a divisor of the part size
  const stream = new Readable({
    read() {
      if (options.failAfter !== undefined && sent >= options.failAfter) { this.destroy(options.failWith ?? new Error('synthetic source failure')); return; }
      if (sent >= total) { this.push(null); return; }
      const size = Math.min(chunk, total - sent, options.failAfter !== undefined ? options.failAfter - sent : Infinity);
      const piece = Buffer.allocUnsafe(size);
      for (let i = 0; i < size; i++) piece[i] = ((sent + i) * 31 + ((sent + i) >> 12)) & 255;
      sent += size; hash.update(piece); this.push(piece);
    },
  });
  return { stream, sha256: () => hash.digest('hex'), sent: () => sent };
}

run('S3Storage multipart against MinIO', () => {
  const bucket = `zf-multipart-${randomUUID().slice(0, 8)}`;
  let raw: S3Client, storage: S3Storage;
  const credentials = { accessKeyId: process.env.S3_MINIO_KEY ?? 'minioadmin', secretAccessKey: process.env.S3_MINIO_SECRET ?? 'minioadmin' };

  const pendingUploads = async () => (await raw.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? [];
  const keys = async () => ((await raw.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? []).map(item => item.Key).sort();
  async function sha(key: string): Promise<{ size: number; sha256: string }> {
    const object = await storage.download(key);
    const hash = createHash('sha256'); let size = 0;
    for await (const piece of object.stream) { hash.update(piece as Buffer); size += (piece as Buffer).length; }
    return { size, sha256: hash.digest('hex') };
  }

  beforeAll(async () => {
    raw = new S3Client({ region: 'us-east-1', endpoint, credentials, forcePathStyle: true });
    await raw.send(new CreateBucketCommand({ Bucket: bucket }));
    storage = new S3Storage({ ...credentials, endpoint, bucket, forcePathStyle: true, objectAclMode: 'none', partSize: PART });
  });
  afterAll(() => { storage?.onModuleDestroy(); raw?.destroy(); });

  it.each([0, 1, PART - 1, PART, PART + 1, 2 * PART, 2 * PART + 1, 3 * PART - 7])('round-trips %i bytes with the exact size and hash, leaving no pending upload', async (total) => {
    const input = source(total), key = `sizes/${total}`;
    const result = await storage.uploadStream(input.stream, key, { contentType: 'application/x-synthetic', metadata: { origin: 'test' } });
    expect(result.size).toBe(total);
    expect(await sha(key)).toEqual({ size: total, sha256: input.sha256() });
    const head = await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentLength).toBe(total);
    expect(head.ContentType).toBe('application/x-synthetic');
    expect(head.Metadata).toMatchObject({ origin: 'test' });
    expect(await pendingUploads()).toEqual([]);
  }, 60_000);

  it('a source that fails after parts were uploaded aborts the upload: no object, no pending multipart', async () => {
    const key = 'abort/source-failure';
    const input = source(40 * MiB, { failAfter: 2 * PART + 123, failWith: new Error('connection reset by synthetic peer') });
    await expect(storage.uploadStream(input.stream, key)).rejects.toThrow('connection reset by synthetic peer');
    expect(await pendingUploads()).toEqual([]);
    expect(await keys()).not.toContain(key);
    expect(await storage.exists(key)).toBe(false);
  }, 60_000);

  it('an UploadPart that fails mid-way (real server holds earlier parts) is aborted and never half-visible', async () => {
    const key = 'abort/part-failure';
    const client = (storage as unknown as { client: S3Client }).client;
    const original = client.send.bind(client);
    let parts = 0;
    (client as unknown as { send: unknown }).send = async (command: unknown, ...rest: unknown[]) => {
      if (command instanceof UploadPartCommand && ++parts === 2) throw new Error('synthetic UploadPart outage');
      return (original as (...args: unknown[]) => Promise<unknown>)(command, ...rest);
    };
    try {
      await expect(storage.uploadStream(source(4 * PART).stream, key)).rejects.toThrow('synthetic UploadPart outage');
    } finally { (client as unknown as { send: unknown }).send = original; }
    expect(parts).toBe(2);
    expect(await pendingUploads()).toEqual([]);
    expect(await storage.exists(key)).toBe(false);
  }, 60_000);

  it('destroying the source stream mid-upload also leaves nothing behind', async () => {
    const key = 'abort/destroyed';
    const input = source(40 * MiB);
    const pending = storage.uploadStream(input.stream, key);
    const fail = new Promise<void>(done => input.stream.on('data', () => { if (input.sent() > PART + MiB) { input.stream.destroy(new Error('synthetic client hang-up')); done(); } }));
    await fail;
    await expect(pending).rejects.toThrow();
    expect(await pendingUploads()).toEqual([]);
    expect(await storage.exists(key)).toBe(false);
  }, 60_000);

  it('a failed re-upload leaves the previous object untouched', async () => {
    const key = 'abort/overwrite';
    const good = source(PART + 10);
    await storage.uploadStream(good.stream, key);
    const before = await sha(key);
    await expect(storage.uploadStream(source(3 * PART, { failAfter: PART + 5 }).stream, key)).rejects.toThrow();
    expect(await sha(key)).toEqual(before);
    expect(await pendingUploads()).toEqual([]);
  }, 60_000);

  it('concurrent uploads of different keys do not mix their parts', async () => {
    const inputs = [7 * MiB + 1, 11 * MiB, 5 * MiB, 13 * MiB + 99].map(total => ({ total, input: source(total, { chunk: 700_001 }) }));
    await Promise.all(inputs.map(({ input }, index) => storage.uploadStream(input.stream, `concurrent/${index}`)));
    for (const [index, { total, input }] of inputs.entries()) expect(await sha(`concurrent/${index}`)).toEqual({ size: total, sha256: input.sha256() });
    expect(await pendingUploads()).toEqual([]);
  }, 120_000);

  it('buffers about one part: a 150 MiB stream does not grow external memory with the object size', async () => {
    const input = source(150 * MiB, { chunk: 64 * 1024 });
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 5);
    const baseline = process.memoryUsage().arrayBuffers;
    try { await storage.uploadStream(input.stream, 'memory/150mib'); } finally { clearInterval(timer); }
    expect(peak - baseline).toBeLessThan(80 * MiB);
    expect((await sha('memory/150mib')).size).toBe(150 * MiB);
  }, 180_000);

  it('rejects public ACL on a no-ACL provider before opening a multipart upload', async () => {
    await expect(storage.uploadStream(source(2 * PART).stream, 'acl/refused', { acl: 'public-read' })).rejects.toThrow(/ACL/);
    expect(await pendingUploads()).toEqual([]);
    expect(await storage.exists('acl/refused')).toBe(false);
  });

  it('refuses invalid part sizes at construction', () => {
    for (const partSize of [0, 1, PART - 1, 5 * 1024 * MiB + 1, 1.5 * MiB, Number.NaN, Infinity])
      expect(() => new S3Storage({ ...credentials, endpoint, bucket, forcePathStyle: true, partSize })).toThrow(/partSize/);
  });
});
