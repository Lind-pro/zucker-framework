import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFileStorage } from './local-storage';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Package review regressions', () => {
  it('R05: completing chunks respects stream backpressure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-review-chunks-'));
    const write = fs.WriteStream.prototype.write;
    let peakBuffered = 0;
    vi.spyOn(fs.WriteStream.prototype, 'write').mockImplementation(function (this: fs.WriteStream, ...input: Parameters<typeof write>) {
      const result = write.apply(this, input);
      peakBuffered = Math.max(peakBuffered, this.writableLength);
      return result;
    } as typeof write);
    try {
      const storage = new LocalFileStorage({ basePath: root });
      const chunk = Buffer.alloc(256 * 1024, 1);
      const id = await storage.initChunkedUpload('file.bin', 8, chunk.length * 8);
      for (let i = 0; i < 8; i++) await storage.uploadChunk(id, i, chunk);
      const result = await storage.completeChunkedUpload(id);
      expect(result.size).toBe(2 * 1024 * 1024);
      expect(peakBuffered).toBeLessThanOrEqual(128 * 1024);
      expect(fs.readFileSync(path.join(root, result.key))).toEqual(Buffer.alloc(result.size, 1));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

});
