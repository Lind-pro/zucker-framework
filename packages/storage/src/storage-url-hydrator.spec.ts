import { describe, expect, it, vi } from 'vitest';
import { hydrateStorageUrls } from './storage-url-hydrator';

describe('hydrateStorageUrls', () => {
  it('hydrates nested storage references without mutating the source value', async () => {
    const storage = {
      getDownloadUrl: vi.fn(async (key: string) => `https://signed.test/${key}`),
    };
    const service = {
      hydrate: <T>(value: T, allowedStorageKeys: ReadonlySet<string>) =>
        hydrateStorageUrls(value, {
          allowedStorageKeys,
          getDownloadUrl: storage.getDownloadUrl,
          storageKeyField: 'storageKey',
          urlFields: ['url', 'imageUrl'],
        }),
    };
    const createdAt = new Date('2026-08-20T00:00:00.000Z');
    const source = {
      createdAt,
      drawings: [
        {
          storageKey: 'uploads/project-1/figure-1.png',
          imageUrl: null,
        },
      ],
    };

    const result = await service.hydrate(source, new Set(['uploads/project-1/figure-1.png']));

    expect(result).not.toBe(source);
    expect(result.createdAt).toBe(createdAt);
    expect(result.drawings[0]).toEqual({
      storageKey: 'uploads/project-1/figure-1.png',
      imageUrl: 'https://signed.test/uploads/project-1/figure-1.png',
      url: 'https://signed.test/uploads/project-1/figure-1.png',
    });
    expect(source.drawings[0].imageUrl).toBeNull();
    expect(source.drawings[0]).not.toHaveProperty('url');
    expect(storage.getDownloadUrl).toHaveBeenCalledWith('uploads/project-1/figure-1.png');
  });

  it('does not sign values without a storage key and reuses signatures per key', async () => {
    const storage = {
      getDownloadUrl: vi.fn(async () => 'https://signed.test/shared'),
    };
    const service = {
      hydrate: <T>(value: T, allowedStorageKeys: ReadonlySet<string>) =>
        hydrateStorageUrls(value, {
          allowedStorageKeys,
          getDownloadUrl: storage.getDownloadUrl,
          storageKeyField: 'storageKey',
          urlFields: ['url', 'imageUrl'],
        }),
    };

    const result = await service.hydrate(
      [
        { storageKey: 'shared/key.png' },
        { nested: { storageKey: 'shared/key.png' } },
        { imageUrl: 'https://legacy.test/image.png' },
      ],
      new Set(['shared/key.png']),
    );

    expect(storage.getDownloadUrl).toHaveBeenCalledTimes(1);
    expect(result[2]).toEqual({ imageUrl: 'https://legacy.test/image.png' });
  });

  it('does not sign a storage key that is absent from the ownership allowlist', async () => {
    const storage = {
      getDownloadUrl: vi.fn(async () => 'https://signed.test/forged'),
    };
    const service = {
      hydrate: <T>(value: T, allowedStorageKeys: ReadonlySet<string>) =>
        hydrateStorageUrls(value, {
          allowedStorageKeys,
          getDownloadUrl: storage.getDownloadUrl,
          storageKeyField: 'storageKey',
          urlFields: ['url', 'imageUrl'],
        }),
    };
    const source = {
      storageKey: 'uploads/another-user/private.png',
      url: '',
    };

    const result = await service.hydrate(source, new Set());

    expect(result).toEqual(source);
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects signing failures without modifying persisted source data', async () => {
    const source = { objectKey: 'private/a', downloadUrl: 'old' };
    const error = new Error('signing unavailable');
    await expect(
      hydrateStorageUrls(source, {
        allowedStorageKeys: new Set(['private/a']),
        getDownloadUrl: async () => {
          throw error;
        },
        storageKeyField: 'objectKey',
        urlFields: ['downloadUrl'],
      }),
    ).rejects.toBe(error);
    expect(source).toEqual({ objectKey: 'private/a', downloadUrl: 'old' });
  });
});
