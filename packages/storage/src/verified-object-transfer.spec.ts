import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { transferVerifiedObject, verifyStoredObject } from './verified-object-transfer';

function fixture() {
  const body = Buffer.from('synthetic-object');
  const target = {
    exists: vi.fn(async () => false),
    read: vi.fn(async () => ({ body: Buffer.from(body), reportedSize: body.length })),
    write: vi.fn(async () => ({ size: body.length })),
  };
  const options = {
    source: { body, reportedSize: body.length },
    target,
    destinationKey: 'objects/example',
    mode: 'apply' as const,
    allowUpload: true,
    detectMimeType: () => 'application/test',
  };
  return { body, target, options };
}

describe('verified object transfer', () => {
  it('never uploads a dry-run or unauthorized planned object', async () => {
    const { options, target } = fixture();
    await expect(transferVerifiedObject({ ...options, mode: 'dry-run' })).resolves.toMatchObject({
      targetDisposition: 'planned',
    });
    await expect(transferVerifiedObject({ ...options, allowUpload: false })).resolves.toMatchObject(
      { targetDisposition: 'planned' },
    );
    expect(target.write).not.toHaveBeenCalled();
  });

  it('writes privately then verifies returned bytes before reporting uploaded', async () => {
    const { options, target, body } = fixture();
    const sha256 = createHash('sha256').update(body).digest('hex');
    await expect(transferVerifiedObject(options)).resolves.toEqual({
      sha256,
      size: body.length,
      mimeType: 'application/test',
      targetDisposition: 'uploaded',
    });
    expect(target.write).toHaveBeenCalledWith('objects/example', body, {
      contentType: 'application/test',
      metadata: { sha256, size: String(body.length), mimeType: 'application/test' },
      private: true,
    });
    expect(target.read).toHaveBeenCalledWith('objects/example');
  });

  it('reuses matching objects but never overwrites conflicting bytes', async () => {
    const { options, target, body } = fixture();
    target.exists.mockResolvedValue(true);
    await expect(transferVerifiedObject(options)).resolves.toMatchObject({
      targetDisposition: 'reused',
    });
    const corrupt = Buffer.from(body);
    corrupt[0] ^= 1;
    target.read.mockResolvedValueOnce({ body: corrupt, reportedSize: corrupt.length });
    await expect(transferVerifiedObject(options)).rejects.toMatchObject({
      code: 'TARGET_HASH_CONFLICT',
    });
    expect(target.write).not.toHaveBeenCalled();
  });

  it('rejects corrupt source/upload sizes and preserves custom error mapping', async () => {
    const { options, target, body } = fixture();
    const errorFactory = (code: string) =>
      Object.assign(new Error(code), { code, productMapping: true });
    await expect(
      transferVerifiedObject({ ...options, errorFactory, source: { body, reportedSize: 0 } }),
    ).rejects.toMatchObject({ code: 'SOURCE_SIZE_MISMATCH', productMapping: true });
    expect(target.exists).not.toHaveBeenCalled();
    target.write.mockResolvedValueOnce({ size: 0 });
    await expect(transferVerifiedObject(options)).rejects.toMatchObject({
      code: 'UPLOAD_SIZE_MISMATCH',
    });
  });

  it('distinguishes stored size and MIME conflicts before hash mismatch', () => {
    const body = Buffer.from('x');
    const expected = { sha256: '0'.repeat(64), size: 1, mimeType: 'type/expected' };
    expect(() =>
      verifyStoredObject({ body, reportedSize: 2 }, expected, () => 'type/expected'),
    ).toThrow('TARGET_SIZE_CONFLICT');
    expect(() =>
      verifyStoredObject({ body, reportedSize: 1 }, expected, () => 'type/other'),
    ).toThrow('TARGET_MIME_CONFLICT');
  });
});
