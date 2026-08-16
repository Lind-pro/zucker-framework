import { Logger } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Storage } from './s3-storage';

// Mock AWS SDK
const mockSend = vi.fn();
const mockDestroy = vi.fn();
const loggerLog = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

vi.mock('@aws-sdk/client-s3', () => {
  class MockCommand {
    constructor(
      readonly _type: string,
      readonly input: Record<string, unknown>,
    ) {}
  }

  return {
    S3Client: class MockS3Client {
      send(...arguments_: unknown[]) {
        return mockSend(...arguments_);
      }

      destroy() {
        mockDestroy();
      }
    },
    PutObjectCommand: class extends MockCommand {
      constructor(input: Record<string, unknown>) {
        super('PutObject', input);
      }
    },
    GetObjectCommand: class extends MockCommand {
      constructor(input: Record<string, unknown>) {
        super('GetObject', input);
      }
    },
    DeleteObjectCommand: class extends MockCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteObject', input);
      }
    },
    HeadObjectCommand: class extends MockCommand {
      constructor(input: Record<string, unknown>) {
        super('HeadObject', input);
      }
    },
    ListObjectsV2Command: class extends MockCommand {
      constructor(input: Record<string, unknown>) {
        super('ListObjects', input);
      }
    },
    CopyObjectCommand: class extends MockCommand {
      constructor(input: Record<string, unknown>) {
        super('CopyObject', input);
      }
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/test'),
}));

const defaultOptions = {
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  region: 'us-east-1',
  bucket: 'test-bucket',
  publicUrl: 'https://cdn.example.com',
};

describe('S3Storage', () => {
  let storage: S3Storage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new S3Storage(defaultOptions);
  });

  it('should report providerType as s3', () => {
    expect(storage.providerType).toBe('s3');
  });

  it('should always be configured', () => {
    expect(storage.isConfigured()).toBe(true);
  });

  it('does not disclose the bucket in lifecycle logs', () => {
    expect(loggerLog).toHaveBeenCalledWith('S3 storage initialized');
    expect(JSON.stringify(loggerLog.mock.calls)).not.toContain(defaultOptions.bucket);
  });

  // ---- upload ----

  it('should upload a buffer to S3', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await storage.upload(Buffer.from('data'), 'files/test.txt', {
      contentType: 'text/plain',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('files/test.txt');
    expect(cmd.input.ContentType).toBe('text/plain');

    expect(result.key).toBe('files/test.txt');
    expect(result.url).toBe('https://cdn.example.com/files/test.txt');
    expect(result.size).toBe(4);
  });

  it('should use default content type when none provided', async () => {
    mockSend.mockResolvedValueOnce({});

    await storage.upload(Buffer.from('x'), 'key.bin');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.ContentType).toBe('application/octet-stream');
  });

  // ---- download ----

  it('should download a file from S3', async () => {
    const mockBody = Buffer.from('file content');
    mockSend.mockResolvedValueOnce({
      Body: mockBody,
      ContentLength: 12,
    });

    const { stream, size } = await storage.download('doc.txt');
    expect(size).toBe(12);
    expect(stream).toBe(mockBody);
  });

  it('should throw when download body is empty', async () => {
    mockSend.mockResolvedValueOnce({ Body: null });

    const error = await storage
      .download('missing.txt')
      .then(() => undefined)
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Stored object response had no body');
    expect((error as Error).message).not.toContain('missing.txt');
  });

  // ---- delete ----

  it('should delete a file from S3', async () => {
    mockSend.mockResolvedValueOnce({});

    await storage.delete('old.txt');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('old.txt');
  });

  // ---- exists ----

  it('should return true for existing file', async () => {
    mockSend.mockResolvedValueOnce({});

    expect(await storage.exists('present.txt')).toBe(true);
  });

  it('should return false for NotFound', async () => {
    mockSend.mockRejectedValueOnce({ name: 'NotFound' });

    expect(await storage.exists('missing.txt')).toBe(false);
  });

  it('should return false for 404 status code', async () => {
    mockSend.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });

    expect(await storage.exists('gone.txt')).toBe(false);
  });

  it('should rethrow unexpected errors in exists', async () => {
    mockSend.mockRejectedValueOnce(new Error('network failure'));

    await expect(storage.exists('err.txt')).rejects.toThrow('network failure');
  });

  // ---- getPublicUrl ----

  it('should return publicUrl-based URL', async () => {
    const url = await storage.getPublicUrl('path/file.txt');
    expect(url).toBe('https://cdn.example.com/path/file.txt');
  });

  it('should use signed URL when no publicUrl', async () => {
    const noPublicUrl = new S3Storage({ ...defaultOptions, publicUrl: undefined });
    const url = await noPublicUrl.getPublicUrl('secret.txt');
    expect(url).toBe('https://signed-url.example.com/test');
  });

  // ---- list ----

  it('should list objects by prefix', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'dir/a.txt', Size: 100, LastModified: new Date('2024-01-01') },
        { Key: 'dir/b.txt', Size: 200, LastModified: new Date('2024-02-01') },
      ],
    });

    const files = await storage.list('dir/');
    expect(files).toHaveLength(2);
    expect(files[0].key).toBe('dir/a.txt');
    expect(files[0].size).toBe(100);
    expect(files[1].key).toBe('dir/b.txt');
  });

  it('should return empty list when no Contents', async () => {
    mockSend.mockResolvedValueOnce({ Contents: undefined });

    const files = await storage.list('empty/');
    expect(files).toEqual([]);
  });

  // ---- getFileInfo ----

  it('should return file info via HeadObject', async () => {
    mockSend.mockResolvedValueOnce({
      ContentLength: 512,
      LastModified: new Date('2024-03-15'),
      ContentType: 'application/pdf',
    });

    const info = await storage.getFileInfo('report.pdf');
    expect(info).toBeDefined();
    expect(info!.key).toBe('report.pdf');
    expect(info!.size).toBe(512);
    expect(info!.contentType).toBe('application/pdf');
  });

  it('should return undefined for non-existent file', async () => {
    mockSend.mockRejectedValueOnce({ name: 'NotFound' });

    const info = await storage.getFileInfo('nope.txt');
    expect(info).toBeUndefined();
  });

  // ---- copy / move ----

  it('should copy a file within S3', async () => {
    mockSend.mockResolvedValueOnce({});

    await storage.copy!('src.txt', 'dst.txt');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.CopySource).toBe('test-bucket/src.txt');
    expect(cmd.input.Key).toBe('dst.txt');
  });

  it('should move a file (copy + delete)', async () => {
    mockSend.mockResolvedValue({});

    await storage.move!('old.txt', 'new.txt');

    expect(mockSend).toHaveBeenCalledTimes(2);
    // First call: copy
    expect(mockSend.mock.calls[0][0].input.CopySource).toBe('test-bucket/old.txt');
    // Second call: delete
    expect(mockSend.mock.calls[1][0].input.Key).toBe('old.txt');
  });

  // ---- uploadStream ----

  it('should upload from a stream by collecting chunks', async () => {
    mockSend.mockResolvedValueOnce({});

    const chunks = [Buffer.from('part1'), Buffer.from('part2')];
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };

    const result = await storage.uploadStream(mockStream as any, 'stream.txt');
    expect(result.size).toBe(10);
  });

  // ---- onModuleDestroy ----

  it('should destroy S3 client on module destroy', () => {
    storage.onModuleDestroy();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
