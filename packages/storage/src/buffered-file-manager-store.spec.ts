import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BufferedFileManagerStore } from './buffered-file-manager-store';
import type { FileManager } from './storage.interface';

function fixture(size: number, chunks: Buffer[], max = 10) {
  const stream = Readable.from(chunks);
  const manager = {
    isConfigured: () => true,
    download: vi.fn(async () => ({ stream, size })),
    exists: vi.fn(async () => false),
    upload: vi.fn(async () => ({ key: 'a', url: '', size })),
  };
  return {
    stream,
    manager,
    store: new BufferedFileManagerStore(manager as unknown as FileManager, max),
  };
}

describe('BufferedFileManagerStore', () => {
  it('buffers within the explicit budget and retains reported size for integrity verification', async () => {
    const { store } = fixture(5, [Buffer.from('ab'), Buffer.from('cde')]);
    await expect(store.read('a')).resolves.toEqual({ body: Buffer.from('abcde'), reportedSize: 5 });
  });
  it('destroys oversized streams whether metadata or actual chunks exceed the budget', async () => {
    const reported = fixture(20, [Buffer.alloc(1)]);
    await expect(reported.store.read('a')).rejects.toThrow('OBJECT_SIZE_OUT_OF_BOUNDS');
    expect(reported.stream.destroyed).toBe(true);
    const actual = fixture(2, [Buffer.alloc(6), Buffer.alloc(6)]);
    await expect(actual.store.read('a')).rejects.toThrow('OBJECT_SIZE_OUT_OF_BOUNDS');
    expect(actual.stream.destroyed).toBe(true);
  });
  it('forces private uploads and rejects oversized bodies before calling the provider', async () => {
    const { store, manager } = fixture(2, []);
    const options = {
      contentType: 'application/test',
      metadata: { sha256: 'digest' },
      private: true as const,
    };
    await store.write('a', Buffer.from('ab'), options);
    expect(manager.upload).toHaveBeenCalledWith(Buffer.from('ab'), 'a', {
      contentType: 'application/test',
      metadata: { sha256: 'digest' },
      acl: 'private',
    });
    manager.upload.mockClear();
    await expect(store.write('a', Buffer.alloc(11), options)).rejects.toThrow(
      'OBJECT_SIZE_OUT_OF_BOUNDS',
    );
    expect(manager.upload).not.toHaveBeenCalled();
  });
});
