import { describe, expect, it } from 'vitest';
import { UnavailableFileManager } from './unavailable-file-manager';

describe('UnavailableFileManager', () => {
  it('keeps unconfigured reads empty and data operations explicitly rejected', async () => {
    const manager = new UnavailableFileManager('s3', 'storage is disabled for this consumer');
    expect(manager.isConfigured()).toBe(false);
    expect(manager.providerType).toBe('s3');
    await expect(manager.exists('key')).resolves.toBe(false);
    await expect(manager.list('prefix')).resolves.toEqual([]);
    await expect(manager.upload(Buffer.from('synthetic'), 'key')).rejects.toThrow('storage is disabled for this consumer');
    await expect(manager.download('key')).rejects.toThrow('storage is disabled for this consumer');
    await expect(manager.delete('key')).rejects.toThrow('storage is disabled for this consumer');
  });
});
