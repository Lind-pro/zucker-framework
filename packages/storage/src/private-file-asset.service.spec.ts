// @vitest-environment node
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BufferedFileManagerStore } from './buffered-file-manager-store';
import { LocalFileStorage } from './local-storage';
import { PrivateFileAssetService } from './private-file-asset.service';
import type { FileAsset, FileAssetMutation, FileAssetReservation, PrivateFileObjectStore } from './file-asset';

const body = Buffer.from('synthetic private file');
const input = () => ({ scope: 'alice', idempotencyKey: 'request-one', fileName: 'report.txt', body: Buffer.from(body) });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Atomic test double only. Production database uniqueness/CAS remains the consumer's contract.
function fixture() {
  const rows = new Map<string, FileAsset>();
  const bytes = new Map<string, Buffer>();
  const repository = {
    reserve: vi.fn(async (candidate: FileAssetReservation) => {
      const existing = [...rows.values()].find(row => row.scope === candidate.scope && row.idempotencyKey === candidate.idempotencyKey);
      if (existing) return { ...existing };
      const row: FileAsset = { ...candidate, revision: 0, state: 'pending', updatedAt: candidate.createdAt,
        deletedAt: null, cleanupStatus: null, cleanupConfirmedAt: null };
      rows.set(row.id, row);
      return { ...row };
    }),
    get: vi.fn(async (scope: string, id: string) => {
      const row = rows.get(id);
      return row?.scope === scope ? { ...row } : null;
    }),
    compareAndSwap: vi.fn(async (scope: string, id: string, revision: number, update: FileAssetMutation) => {
      const row = rows.get(id);
      if (!row || row.scope !== scope || row.revision !== revision) return null;
      const changed = { ...row, ...update, revision: revision + 1 };
      rows.set(id, changed);
      return { ...changed };
    }),
  };
  const objects = {
    exists: vi.fn(async (key: string) => bytes.has(key)),
    read: vi.fn(async (key: string) => {
      const data = bytes.get(key);
      if (!data) throw new Error('Synthetic missing object');
      return { body: Buffer.from(data), reportedSize: data.length };
    }),
    write: vi.fn(async (key: string, data: Buffer, _options: { contentType: string; metadata: Record<string, string>; private: true }) => {
      bytes.set(key, Buffer.from(data));
      return { size: data.length };
    }),
    delete: vi.fn(async (key: string) => { bytes.delete(key); }),
  };
  const authorize = vi.fn(async (actor: string, request: { scope: string }) => actor === request.scope);
  const options = { repository, objects, authorize, detectMimeType: () => 'text/plain', maxObjectBytes: 1024 };
  const service = new PrivateFileAssetService(options);
  return { service, options, repository, objects, rows, bytes, authorize,
    row: () => [...rows.values()][0] };
}

describe('private file asset metadata and recovery', () => {
  it('reserves metadata before private upload and verifies bytes before marking ready', async () => {
    const f = fixture();
    f.objects.write.mockImplementationOnce(async (key, data, options) => {
      expect(f.row()).toMatchObject({ state: 'pending', objectKey: key, size: body.length });
      expect(options.private).toBe(true);
      f.bytes.set(key, Buffer.from(data));
      return { size: data.length };
    });
    const asset = await f.service.upload('alice', input());
    expect(asset).toMatchObject({ state: 'ready', scope: 'alice', mimeType: 'text/plain', size: body.length });
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(asset.objectKey).toBe(`private-assets/${asset.id}`);
    await expect(f.service.read('alice', 'alice', asset.id)).resolves.toMatchObject({ body });
  });

  it('reuses an identical idempotent upload and rejects changed content or request metadata before object IO', async () => {
    const f = fixture();
    const first = await f.service.upload('alice', input());
    expect((await f.service.upload('alice', input())).id).toBe(first.id);
    expect(f.objects.write).toHaveBeenCalledTimes(1);
    f.objects.exists.mockClear();
    for (const changed of [
      { ...input(), body: Buffer.from('other private contents') },
      { ...input(), fileName: 'other.txt' },
    ]) await expect(f.service.upload('alice', changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const changedMime = new PrivateFileAssetService({ ...f.options, detectMimeType: () => 'application/test' });
    await expect(changedMime.upload('alice', input())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.objects.exists).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(1);
  });

  it('enforces authorization before metadata or object IO on every entry', async () => {
    const f = fixture();
    const attempts = [
      () => f.service.upload('mallory', input()),
      () => f.service.read('mallory', 'alice', 'id'),
      () => f.service.inspect('mallory', 'alice', 'id'),
      () => f.service.recover('mallory', 'alice', 'id'),
      () => f.service.delete('mallory', 'alice', 'id'),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.repository.reserve).not.toHaveBeenCalled();
    expect(f.repository.get).not.toHaveBeenCalled();
    expect(f.objects.exists).not.toHaveBeenCalled();
    expect(f.objects.delete).not.toHaveBeenCalled();
  });

  it('does not expose another scope and scopes idempotency independently', async () => {
    const f = fixture();
    const a = await f.service.upload('alice', input());
    f.objects.read.mockClear();
    await expect(f.service.read('bob', 'bob', a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.delete('bob', 'bob', a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.objects.read).not.toHaveBeenCalled();
    const b = await f.service.upload('bob', { ...input(), scope: 'bob', body: Buffer.from('bob data') });
    expect(b.objectKey).not.toBe(a.objectKey);
  });

  it('resumes an uncertain remote upload through a new service without uploading again', async () => {
    const f = fixture();
    f.objects.write.mockImplementationOnce(async (key, data) => {
      f.bytes.set(key, Buffer.from(data));
      throw new Error('Synthetic response lost after write');
    });
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'UPLOAD_UNVERIFIED' });
    expect(f.row().state).toBe('pending');
    await expect(f.service.read('alice', 'alice', f.row().id)).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    const resumed = new PrivateFileAssetService(f.options);
    await expect(resumed.recover('alice', 'alice', f.row().id)).resolves.toMatchObject({ state: 'ready' });
    expect(f.objects.write).toHaveBeenCalledTimes(1);
  });

  it('keeps the object and reservation recoverable after metadata commit failure', async () => {
    const f = fixture();
    f.repository.compareAndSwap.mockRejectedValueOnce(new Error('Synthetic database unavailable'));
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
    expect(f.row().state).toBe('pending');
    expect(f.bytes.size).toBe(1);
    await expect(new PrivateFileAssetService(f.options).recover('alice', 'alice', f.row().id)).resolves.toMatchObject({ state: 'ready' });
    expect(f.objects.write).toHaveBeenCalledTimes(1);
  });

  it('performs no storage IO when reservation fails and does not treat unknown existence as missing', async () => {
    const f = fixture();
    f.repository.reserve.mockRejectedValueOnce(new Error('Synthetic database unavailable'));
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
    expect(f.objects.exists).not.toHaveBeenCalled();
    f.objects.exists.mockRejectedValueOnce(new Error('Synthetic permission denied'));
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'UPLOAD_UNVERIFIED' });
    expect(f.objects.write).not.toHaveBeenCalled();
    expect(f.row().state).toBe('pending');
  });

  it('does not claim missing, unknown or corrupt pending content is ready', async () => {
    const f = fixture();
    f.objects.write.mockRejectedValueOnce(new Error('Synthetic upload unavailable'));
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'UPLOAD_UNVERIFIED' });
    const asset = f.row();
    await expect(f.service.recover('alice', 'alice', asset.id)).resolves.toMatchObject({ state: 'pending' });
    f.objects.exists.mockRejectedValueOnce(new Error('Synthetic permission denied'));
    await expect(f.service.recover('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
    const corrupt = Buffer.from(body); corrupt[0] ^= 1;
    f.bytes.set(asset.objectKey, corrupt);
    await expect(f.service.recover('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'TARGET_HASH_CONFLICT' });
    expect(f.row().state).toBe('pending');
  });

  it('never overwrites or serves conflicting stored bytes', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    const corrupt = Buffer.from(body); corrupt[0] ^= 1;
    f.bytes.set(asset.objectKey, corrupt);
    await expect(f.service.read('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'TARGET_HASH_CONFLICT' });
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'TARGET_HASH_CONFLICT' });
    expect(f.objects.write).toHaveBeenCalledTimes(1);
  });

  it('enforces the current byte budget on previously stored files before reading them', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    const smaller = new PrivateFileAssetService({ ...f.options, maxObjectBytes: body.length - 1 });
    f.objects.read.mockClear();
    await expect(smaller.read('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.objects.read).not.toHaveBeenCalled();
  });

  it('atomically reserves one identity across concurrent service instances', async () => {
    const f = fixture();
    const second = new PrivateFileAssetService(f.options);
    const [a, b] = await Promise.all([f.service.upload('alice', input()), second.upload('alice', input())]);
    expect(a.id).toBe(b.id);
    expect(a.state).toBe('ready');
    expect(b.state).toBe('ready');
    expect(f.rows.size).toBe(1);
    expect(f.bytes.size).toBe(1);
  });

  it('rejects a concurrent idempotency conflict before writing different bytes', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.service.upload('alice', input()),
      new PrivateFileAssetService(f.options).upload('alice', { ...input(), body: Buffer.from('conflicting') }),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect([...f.bytes.values()]).toEqual([body]);
  });

  it('bounds input and snapshots scope, idempotency, filename and bytes before asynchronous authorization', async () => {
    const f = fixture();
    for (const data of [Buffer.alloc(0), Buffer.alloc(1025)])
      await expect(f.service.upload('alice', { ...input(), body: data })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.repository.reserve).not.toHaveBeenCalled();
    const authorized = deferred();
    f.authorize.mockImplementationOnce(async (actor, request) => { await authorized.promise; return actor === request.scope; });
    const request = input();
    const upload = f.service.upload('alice', request);
    request.scope = 'mallory';
    request.idempotencyKey = '\0invalid-mutated-key';
    request.fileName = 'changed.txt';
    request.body.fill(0);
    request.body = Buffer.alloc(1025);
    authorized.resolve();
    const asset = await upload;
    expect(asset).toMatchObject({ scope: 'alice', idempotencyKey: 'request-one', fileName: 'report.txt' });
    expect(f.repository.reserve).toHaveBeenCalledWith(expect.objectContaining({ scope: 'alice', idempotencyKey: 'request-one' }));
    expect(f.bytes.get(asset.objectKey)).toEqual(body);
  });

  it('keeps a failed deletion logically inaccessible and retries cleanup after service replacement', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    f.objects.delete.mockRejectedValueOnce(new Error('Synthetic deletion unavailable'));
    await expect(f.service.delete('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'DELETE_UNVERIFIED' });
    expect(f.row()).toMatchObject({ state: 'deleted', cleanupStatus: 'pending', cleanupConfirmedAt: null });
    await expect(f.service.read('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'ASSET_DELETED' });
    await expect(f.service.upload('alice', input())).rejects.toMatchObject({ code: 'ASSET_DELETED' });
    await expect(new PrivateFileAssetService(f.options).recover('alice', 'alice', asset.id)).resolves.toMatchObject({ state: 'deleted', cleanupStatus: 'confirmed' });
    expect(f.row().cleanupConfirmedAt).toEqual(expect.any(Number));
    expect(f.bytes.size).toBe(0);
    expect(f.rows.size).toBe(1);
  });

  it('requires a durable tombstone before touching the object', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    f.repository.compareAndSwap.mockRejectedValueOnce(new Error('Synthetic database unavailable'));
    await expect(f.service.delete('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
    expect(f.objects.delete).not.toHaveBeenCalled();
    expect(f.bytes.size).toBe(1);
  });

  it('recovers a deletion whose object removal succeeded but metadata acknowledgement failed', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    const original = f.repository.compareAndSwap.getMockImplementation()!;
    f.repository.compareAndSwap.mockImplementationOnce(original).mockRejectedValueOnce(new Error('Synthetic database unavailable'));
    await expect(f.service.delete('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
    expect(f.row()).toMatchObject({ state: 'deleted', cleanupStatus: 'pending' });
    expect(f.bytes.size).toBe(0);
    await expect(f.service.recover('alice', 'alice', asset.id)).resolves.toMatchObject({ cleanupStatus: 'confirmed' });
  });

  it('does not confirm cleanup when deletion is ineffective or absence is unknown', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    f.objects.delete.mockResolvedValueOnce(undefined);
    await expect(f.service.delete('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'DELETE_UNVERIFIED' });
    expect(f.row().cleanupStatus).toBe('pending');
    f.objects.exists.mockRejectedValueOnce(new Error('Synthetic unknown storage status'));
    await expect(f.service.recover('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'DELETE_UNVERIFIED' });
    expect(f.row().cleanupStatus).toBe('pending');
    await expect(f.service.recover('alice', 'alice', asset.id)).resolves.toMatchObject({ cleanupStatus: 'confirmed' });
  });

  it('does not resurrect deleted metadata when an earlier upload finishes late', async () => {
    const f = fixture();
    const started = deferred(); const finish = deferred();
    f.objects.write.mockImplementationOnce(async (key, data) => {
      started.resolve(); await finish.promise;
      f.bytes.set(key, Buffer.from(data));
      return { size: data.length };
    });
    const upload = f.service.upload('alice', input());
    await started.promise;
    const asset = f.row();
    await expect(f.service.delete('alice', 'alice', asset.id)).resolves.toMatchObject({ state: 'deleted', cleanupStatus: 'confirmed' });
    finish.resolve();
    await expect(upload).rejects.toMatchObject({ code: 'ASSET_DELETED' });
    expect(f.bytes.size).toBe(0);
    expect(f.row().state).toBe('deleted');
    expect(f.objects.delete).toHaveBeenCalledTimes(2);
  });

  it('retains retryable cleanup when compensating for a late upload fails', async () => {
    const f = fixture();
    const started = deferred(); const finish = deferred();
    f.objects.write.mockImplementationOnce(async (key, data) => {
      started.resolve(); await finish.promise;
      f.bytes.set(key, Buffer.from(data)); return { size: data.length };
    });
    const upload = f.service.upload('alice', input());
    await started.promise;
    const originalDelete = f.objects.delete.getMockImplementation()!;
    f.objects.delete.mockImplementationOnce(originalDelete).mockRejectedValueOnce(new Error('Synthetic cleanup failed'));
    await f.service.delete('alice', 'alice', f.row().id);
    finish.resolve();
    await expect(upload).rejects.toMatchObject({ code: 'DELETE_UNVERIFIED' });
    expect(f.row()).toMatchObject({ state: 'deleted', cleanupStatus: 'pending' });
    expect(f.bytes.size).toBe(1);
    await f.service.recover('alice', 'alice', f.row().id);
    expect(f.bytes.size).toBe(0);
  });

  it('retained tombstones reconcile remote writes that arrive after a previous absence observation', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    await f.service.delete('alice', 'alice', asset.id);
    // A remote operation may outlive a crashed process; no permanent physical guarantee is claimed.
    f.bytes.set(asset.objectKey, Buffer.from(body));
    await expect(f.service.read('alice', 'alice', asset.id)).rejects.toMatchObject({ code: 'ASSET_DELETED' });
    await new PrivateFileAssetService(f.options).recover('alice', 'alice', asset.id);
    expect(f.bytes.size).toBe(0);
  });

  it('refuses to release file bytes when deletion wins during a read', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    const started = deferred(); const finish = deferred();
    f.objects.read.mockImplementationOnce(async () => {
      started.resolve(); await finish.promise;
      return { body: Buffer.from(body), reportedSize: body.length };
    });
    const read = f.service.read('alice', 'alice', asset.id);
    await started.promise;
    await f.service.delete('alice', 'alice', asset.id);
    finish.resolve();
    await expect(read).rejects.toMatchObject({ code: 'ASSET_DELETED' });
  });

  it('refuses to release bytes when the final metadata read is no longer ready', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    const started = deferred(); const finish = deferred();
    f.objects.read.mockImplementationOnce(async () => {
      started.resolve(); await finish.promise;
      return { body: Buffer.from(body), reportedSize: body.length };
    });
    const read = f.service.read('alice', 'alice', asset.id);
    await started.promise;
    f.rows.set(asset.id, { ...f.row(), state: 'pending', revision: f.row().revision + 1 });
    finish.resolve();
    await expect(read).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
  });

  it('cannot restore ready state when deletion wins during recovery verification', async () => {
    const f = fixture();
    const asset = await f.service.upload('alice', input());
    const started = deferred(); const finish = deferred();
    f.objects.read.mockImplementationOnce(async () => {
      started.resolve(); await finish.promise;
      return { body: Buffer.from(body), reportedSize: body.length };
    });
    const recovery = f.service.recover('alice', 'alice', asset.id);
    await started.promise;
    await f.service.delete('alice', 'alice', asset.id);
    finish.resolve();
    await expect(recovery).rejects.toMatchObject({ code: 'ASSET_DELETED' });
    expect(f.row().state).toBe('deleted');
  });

  it('uses the existing bounded FileManager adapter against real temporary local objects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zucker-private-files-'));
    try {
      const f = fixture();
      const objects: PrivateFileObjectStore = new BufferedFileManagerStore(new LocalFileStorage({ basePath: directory }), 1024);
      const service = new PrivateFileAssetService({ ...f.options, objects });
      const asset = await service.upload('alice', input());
      expect(existsSync(join(directory, asset.objectKey))).toBe(true);
      await expect(service.read('alice', 'alice', asset.id)).resolves.toMatchObject({ body });
      await expect(service.delete('alice', 'alice', asset.id)).resolves.toMatchObject({ cleanupStatus: 'confirmed' });
      expect(existsSync(join(directory, asset.objectKey))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
