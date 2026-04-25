import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { LocalFileStorage } from './local-storage';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zucker-storage-test-'));
}

describe('LocalFileStorage', () => {
  let tmpDir: string;
  let storage: LocalFileStorage;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new LocalFileStorage({ basePath: tmpDir, baseUrl: 'http://localhost:4200/files' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should report providerType as local', () => {
    expect(storage.providerType).toBe('local');
  });

  it('should always be configured', () => {
    expect(storage.isConfigured()).toBe(true);
  });

  // ---- write / read / delete ----

  it('should upload and download a file', async () => {
    const content = Buffer.from('hello zucker');
    const result = await storage.upload(content, 'test.txt');

    expect(result.key).toBe('test.txt');
    expect(result.size).toBe(content.length);
    expect(result.url).toBe('http://localhost:4200/files/test.txt');

    const { stream, size } = await storage.download('test.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(size).toBe(content.length);
    expect(Buffer.concat(chunks).toString()).toBe('hello zucker');
  });

  it('should upload to nested directory', async () => {
    const content = Buffer.from('nested');
    await storage.upload(content, 'a/b/c/deep.txt');
    expect(await storage.exists('a/b/c/deep.txt')).toBe(true);
  });

  it('should delete a file', async () => {
    await storage.upload(Buffer.from('temp'), 'del.txt');
    expect(await storage.exists('del.txt')).toBe(true);

    await storage.delete('del.txt');
    expect(await storage.exists('del.txt')).toBe(false);
  });

  it('should not throw when deleting a non-existent file', async () => {
    await expect(storage.delete('no-such-file.txt')).resolves.toBeUndefined();
  });

  // ---- path traversal protection ----

  it('should reject path traversal with ../', async () => {
    await expect(
      storage.upload(Buffer.from('evil'), '../../../etc/passwd'),
    ).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on download', async () => {
    await expect(storage.download('../secret')).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on delete', async () => {
    await expect(storage.delete('../../etc/shadow')).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on exists', async () => {
    await expect(storage.exists('../../../etc/hosts')).rejects.toThrow('Path traversal detected');
  });

  // ---- file list ----

  it('should list files in a directory', async () => {
    await storage.upload(Buffer.from('a'), 'dir/a.txt');
    await storage.upload(Buffer.from('b'), 'dir/b.txt');

    const files = await storage.list('dir');
    expect(files).toHaveLength(2);

    const keys = files.map((f) => f.key);
    expect(keys).toContain(path.join('dir', 'a.txt'));
    expect(keys).toContain(path.join('dir', 'b.txt'));

    for (const f of files) {
      expect(f.size).toBeGreaterThan(0);
      expect(f.lastModified).toBeInstanceOf(Date);
    }
  });

  it('should return empty list for non-existent directory', async () => {
    const files = await storage.list('nonexistent');
    expect(files).toEqual([]);
  });

  // ---- hash verification ----

  it('should produce correct MD5 hash of uploaded file', async () => {
    const content = Buffer.from('hash test content');
    await storage.upload(content, 'hashfile.txt');

    const filePath = path.join(tmpDir, 'hashfile.txt');
    const fileBuffer = fs.readFileSync(filePath);
    const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const expectedMd5 = crypto.createHash('md5').update(content).digest('hex');
    expect(md5).toBe(expectedMd5);
  });

  it('should produce correct SHA256 hash of uploaded file', async () => {
    const content = Buffer.from('sha256 test content');
    await storage.upload(content, 'sha256file.txt');

    const filePath = path.join(tmpDir, 'sha256file.txt');
    const fileBuffer = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex');
    expect(sha256).toBe(expectedSha256);
  });

  // ---- getPublicUrl ----

  it('should return public URL', async () => {
    const url = await storage.getPublicUrl('docs/readme.md');
    expect(url).toBe('http://localhost:4200/files/docs/readme.md');
  });

  it('should return key as URL when no baseUrl', async () => {
    const bare = new LocalFileStorage({ basePath: tmpDir });
    const url = await bare.getPublicUrl('some/key.txt');
    expect(url).toBe('some/key.txt');
  });

  // ---- getFileInfo ----

  it('should return file info for existing file', async () => {
    const content = Buffer.from('info test');
    await storage.upload(content, 'info.txt');

    const info = await storage.getFileInfo('info.txt');
    expect(info).toBeDefined();
    expect(info!.key).toBe('info.txt');
    expect(info!.size).toBe(content.length);
    expect(info!.lastModified).toBeInstanceOf(Date);
  });

  it('should return undefined for non-existent file', async () => {
    const info = await storage.getFileInfo('nope.txt');
    expect(info).toBeUndefined();
  });

  // ---- copy / move ----

  it('should copy a file', async () => {
    await storage.upload(Buffer.from('original'), 'src.txt');
    await storage.copy!('src.txt', 'dst.txt');

    expect(await storage.exists('src.txt')).toBe(true);
    expect(await storage.exists('dst.txt')).toBe(true);
  });

  it('should move a file', async () => {
    await storage.upload(Buffer.from('moveme'), 'old.txt');
    await storage.move!('old.txt', 'new.txt');

    expect(await storage.exists('old.txt')).toBe(false);
    expect(await storage.exists('new.txt')).toBe(true);
  });

  // ---- downloadRange ----

  it('should download a range of a file', async () => {
    const content = Buffer.from('0123456789');
    await storage.upload(content, 'range.txt');

    const { stream, size } = await storage.downloadRange!('range.txt', 3, 4);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(size).toBe(4);
    expect(Buffer.concat(chunks).toString()).toBe('3456');
  });

  // ---- chunked upload ----

  it('should support chunked upload workflow', async () => {
    const chunk0 = Buffer.from('Hello ');
    const chunk1 = Buffer.from('World!');

    const uploadId = await storage.initChunkedUpload!('chunked.txt', 2);
    expect(typeof uploadId).toBe('string');

    await storage.uploadChunk!(uploadId, 0, chunk0);
    await storage.uploadChunk!(uploadId, 1, chunk1);

    const result = await storage.completeChunkedUpload!(uploadId);
    expect(result.key).toBe('chunked.txt');
    expect(result.size).toBe(12);

    const { stream } = await storage.download('chunked.txt');
    const chunks: Buffer[] = [];
    for await (const c of stream) {
      chunks.push(Buffer.from(c));
    }
    expect(Buffer.concat(chunks).toString()).toBe('Hello World!');
  });

  it('should reject invalid chunk index', async () => {
    const uploadId = await storage.initChunkedUpload!('fail.txt', 2);
    await expect(storage.uploadChunk!(uploadId, 5, Buffer.from('x'))).rejects.toThrow(
      'Invalid chunk index',
    );
  });

  it('should abort chunked upload', async () => {
    const uploadId = await storage.initChunkedUpload!('abort.txt', 2);
    await storage.uploadChunk!(uploadId, 0, Buffer.from('data'));

    await storage.abortChunkedUpload!(uploadId);

    // Subsequent operations on this uploadId should fail
    await expect(
      storage.completeChunkedUpload!(uploadId),
    ).rejects.toThrow('Unknown upload session');
  });

  // ---- saveFile ----

  it('should save file with auto-generated date-based key', async () => {
    const result = await storage.saveFile!(Buffer.from('auto'), 'png');
    expect(result.key).toMatch(/\.png$/);
    expect(result.size).toBe(4);
    expect(await storage.exists(result.key)).toBe(true);
  });

  it('should handle fileType with leading dot', async () => {
    const result = await storage.saveFile!(Buffer.from('dot'), '.jpg');
    expect(result.key).toMatch(/\.jpg$/);
  });

  // ---- applyFilePermission ----

  it('should apply file permissions without throwing', async () => {
    await storage.upload(Buffer.from('perm'), 'perm.txt');
    await expect(
      storage.applyFilePermission!('perm.txt', { mode: 0o644 }),
    ).resolves.toBeUndefined();
  });

  // ---- uploadStream ----

  it('should upload from a ReadStream', async () => {
    // Write a temp file to create a ReadStream
    const srcPath = path.join(tmpDir, '_stream_src.txt');
    fs.writeFileSync(srcPath, 'stream content');
    const readStream = fs.createReadStream(srcPath);

    const result = await storage.uploadStream(readStream, 'from-stream.txt');
    expect(result.size).toBe(14);
    expect(await storage.exists('from-stream.txt')).toBe(true);
  });
});
