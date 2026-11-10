// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferedFileManagerStore } from './buffered-file-manager-store';
import { LocalFileStorage } from './local-storage';
import { PublicAssetService } from './public-asset.service';
import {
  detectRasterImageMime, parsePublicAssetFileName, PublicAssetError,
  type PublicAssetCandidate, type PublicAssetRecord, type RasterImageMime,
} from './public-asset';

const png = (marker: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([marker, 1, 2, 3, 4, 5])]);

// Atomic test double; PostgreSQL uniqueness is the template repository's contract.
function fixture(quotaFiles = 10) {
  const rows = new Map<string, PublicAssetRecord>();
  const repository = {
    reserve: vi.fn(async (candidate: PublicAssetCandidate) => {
      const existing = rows.get(candidate.sha256);
      if (existing) return { asset: { ...existing }, created: false };
      if ([...rows.values()].filter(row => row.ownerId === candidate.ownerId).length >= quotaFiles) throw new PublicAssetError('QUOTA_EXCEEDED');
      const row: PublicAssetRecord = { ...candidate, state: 'pending' };
      rows.set(row.sha256, row);
      return { asset: { ...row }, created: true };
    }),
    markReady: vi.fn(async (sha256: string) => { const row = rows.get(sha256)!; row.state = 'ready'; return { ...row }; }),
    get: vi.fn(async (sha256: string) => (rows.has(sha256) ? { ...rows.get(sha256)! } : null)),
  };
  const directory = mkdtempSync(join(tmpdir(), 'zucker-public-assets-'));
  const objects = new BufferedFileManagerStore(new LocalFileStorage({ basePath: directory }), 1024);
  const normalize = vi.fn(async (body: Buffer, _sniffed: RasterImageMime): Promise<{ body: Buffer; mimeType: RasterImageMime; width: number; height: number }> => ({ body: png(body[8] ?? 0), mimeType: 'image/png', width: 2, height: 3 }));
  const service = new PublicAssetService({ repository, objects, normalize, maxInputBytes: 64, maxObjectBytes: 1024,
    publicUrl: (_key, name) => `/api/public-assets/${name}` });
  return { rows, repository, directory, normalize, service };
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('PublicAssetService', () => {
  it('sniffs raster magic bytes only', () => {
    expect(detectRasterImageMime(png(1))).toBe('image/png');
    expect(detectRasterImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(detectRasterImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectRasterImageMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(detectRasterImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(parsePublicAssetFileName(`${'a'.repeat(64)}.png`)).toEqual({ sha256: 'a'.repeat(64), mimeType: 'image/png' });
    for (const name of [`../${'a'.repeat(64)}.png`, `${'A'.repeat(64)}.png`, `${'a'.repeat(64)}.svg`, `${'a'.repeat(64)}.png/x`, 'private-assets/x'])
      expect(parsePublicAssetFileName(name)).toBeNull();
  });

  it('stores identical concurrent uploads once and returns the existing URL', async () => {
    const { service, rows, directory } = fixture(); directories.push(directory);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.upload('alice', png(7))));
    expect(new Set(results.map(result => result.url)).size).toBe(1);
    expect(results.filter(result => !result.deduplicated)).toHaveLength(1);
    expect(rows.size).toBe(1);
    expect(readdirSync(join(directory, 'public-assets'))).toHaveLength(1);
    expect(results[0].url).toMatch(/^\/api\/public-assets\/[0-9a-f]{64}\.png$/);
    const again = await service.upload('bob', png(7));
    expect(again).toMatchObject({ url: results[0].url, deduplicated: true });
    const read = await service.read(again.url.split('/').pop());
    expect(read.asset.state).toBe('ready');
  });

  it('rejects SVG, unknown, oversize and undecodable input before writing', async () => {
    const { service, repository, normalize, directory } = fixture(); directories.push(directory);
    await expect(service.upload('alice', Buffer.from('<?xml version="1.0"?><svg></svg>'))).rejects.toMatchObject({ code: 'SVG_REJECTED' });
    await expect(service.upload('alice', Buffer.from('plain text that is not an image'))).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    await expect(service.upload('alice', Buffer.concat([png(1), Buffer.alloc(80)]))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    normalize.mockRejectedValueOnce(new Error('decoder detail'));
    await expect(service.upload('alice', png(2))).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    normalize.mockResolvedValueOnce({ body: Buffer.from('<svg/>'.padEnd(20)), mimeType: 'image/png', width: 1, height: 1 });
    await expect(service.upload('alice', png(3))).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(repository.reserve).not.toHaveBeenCalled();
  });

  it('passes the repository quota refusal through', async () => {
    const { service, directory } = fixture(1); directories.push(directory);
    await service.upload('alice', png(1));
    await expect(service.upload('alice', png(2))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(service.upload('alice', png(1))).resolves.toMatchObject({ deduplicated: true });
  });

  it('does not serve pending, missing or mismatched names', async () => {
    const { service, rows, directory } = fixture(); directories.push(directory);
    const stored = await service.upload('alice', png(4));
    const name = stored.url.split('/').pop()!;
    await expect(service.read(name.replace('.png', '.jpg'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    rows.get(stored.sha256)!.state = 'pending';
    await expect(service.read(name)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
