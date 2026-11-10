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

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'propagates real directory permission denial instead of reporting missing or deleted', async () => {
      const key = 'protected/private.txt';
      await storage.upload(Buffer.from('synthetic retained bytes'), key);
      const directory = path.join(tmpDir, 'protected');
      fs.chmodSync(directory, 0o000);
      try {
        await expect(storage.exists(key)).rejects.toMatchObject({ code: 'EACCES' });
        await expect(storage.delete(key)).rejects.toMatchObject({ code: 'EACCES' });
      } finally { fs.chmodSync(directory, 0o700); }
      expect(await storage.exists(key)).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, key), 'utf8')).toBe('synthetic retained bytes');
    });

  it('treats a non-directory ancestor as absent for lookup but does not report a successful delete', async () => {
    await storage.upload(Buffer.from('synthetic file'), 'ancestor');
    expect(await storage.exists('ancestor/child')).toBe(false);
    await expect(storage.delete('ancestor/child')).rejects.toMatchObject({ code: 'ENOTDIR' });
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
  it('ignores abort requests for unknown or crafted upload ids (no traversal)', async () => {
    const victim = path.join(path.dirname(tmpDir), `${path.basename(tmpDir)}-victim`);
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'x');
    try {
      await storage.abortChunkedUpload(`../../${path.basename(victim)}`);
      await storage.abortChunkedUpload('..');
      await storage.abortChunkedUpload('../..');
      expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
      expect(fs.existsSync(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });

  it('validates chunk counts and indices as bounded integers', async () => {
    await expect(storage.initChunkedUpload('a.bin', Number.NaN)).rejects.toThrow('totalChunks');
    await expect(storage.initChunkedUpload('a.bin', 1.5)).rejects.toThrow('totalChunks');
    await expect(storage.initChunkedUpload('a.bin', 0)).rejects.toThrow('totalChunks');
    await expect(storage.initChunkedUpload('../a.bin', 1)).rejects.toThrow('Path traversal');
    const id = await storage.initChunkedUpload('a.bin', 2);
    await expect(storage.uploadChunk(id, Number.NaN, Buffer.from('x'))).rejects.toThrow('Invalid chunk index');
    await expect(storage.uploadChunk(id, 0.5, Buffer.from('x'))).rejects.toThrow('Invalid chunk index');
  });

  it('expires abandoned chunked uploads', async () => {
    const short = new LocalFileStorage({ basePath: tmpDir, chunkSessionTtlMs: -1 });
    const id = await short.initChunkedUpload('a.bin', 1);
    expect(fs.existsSync(path.join(tmpDir, '.chunks', id))).toBe(true);
    await expect(short.uploadChunk(id, 0, Buffer.from('x'))).rejects.toThrow('Unknown upload session');
    expect(fs.existsSync(path.join(tmpDir, '.chunks', id))).toBe(false);
  });

  it('rejects ranges that start outside the file and encodes public URLs', async () => {
    await storage.upload(Buffer.from('hello'), 'dir/a b#?.txt');
    await expect(storage.downloadRange('dir/a b#?.txt', 5)).rejects.toThrow(RangeError);
    await expect(storage.downloadRange('dir/a b#?.txt', -1)).rejects.toThrow(RangeError);
    expect(await storage.getPublicUrl('dir/a b#?.txt')).toBe('http://localhost:4200/files/dir/a%20b%23%3F.txt');
  });

  it('streams uploads through a temporary file and leaves no partial object on failure', async () => {
    const { Readable } = await import('node:stream');
    const ok = await storage.uploadStream(Readable.from([Buffer.from('ab'), Buffer.from('c')]), 's/ok.txt');
    expect(ok.size).toBe(3);
    expect(fs.readFileSync(path.join(tmpDir, 's/ok.txt'), 'utf8')).toBe('abc');
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('source failed'));
      },
    });
    await expect(storage.uploadStream(failing, 's/bad.txt')).rejects.toThrow('source failed');
    expect(fs.readdirSync(path.join(tmpDir, 's'))).toEqual(['ok.txt']);
  });

  describe('round-2 hardening', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    const tempFiles = (dir: string) => walk(dir).filter((f) => /\.upload-.*\.tmp$/.test(path.basename(f)));

    it('uploads and streams a file whose basename is 255 bytes', async () => {
      const { Readable } = await import('node:stream');
      const name = '\u4e2d'.repeat(80) + '.txt'; // 80 * 3 + 4 = 244 bytes
      expect(Buffer.byteLength(name)).toBe(244);
      const long = 'a'.repeat(251) + '.txt'; // 255 bytes
      expect(Buffer.byteLength(long)).toBe(255);
      for (const base of [name, long]) {
        expect((await storage.upload(Buffer.from('x'), `u/${base}`)).size).toBe(1);
        expect((await storage.uploadStream(Readable.from([Buffer.from('yy')]), `s/${base}`)).size).toBe(2);
        expect(fs.readFileSync(path.join(tmpDir, 's', base), 'utf8')).toBe('yy');
      }
      expect(tempFiles(tmpDir)).toEqual([]);
    });

    it('leaves no temp file after a failing stream', async () => {
      const { Readable } = await import('node:stream');
      const failing = new Readable({
        read() {
          this.push(Buffer.from('partial'));
          this.destroy(new Error('boom'));
        },
      });
      await expect(storage.uploadStream(failing, 'f/bad.txt')).rejects.toThrow('boom');
      expect(tempFiles(tmpDir)).toEqual([]);
      expect(fs.existsSync(path.join(tmpDir, 'f/bad.txt'))).toBe(false);
    });

    it('does not list the temp file of an in-flight uploadStream', async () => {
      const { Readable } = await import('node:stream');
      const source = new Readable({ read() {} });
      source.push(Buffer.from('first'));
      const pending = storage.uploadStream(source, 'p/slow.txt');
      for (let i = 0; i < 200 && tempFiles(tmpDir).length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(tempFiles(tmpDir)).toHaveLength(1);
      expect((await storage.list('p')).map((f) => f.key)).toEqual([]);
      source.push(null);
      await pending;
      expect((await storage.list('p')).map((f) => path.basename(f.key))).toEqual(['slow.txt']);
      expect(tempFiles(tmpDir)).toEqual([]);
    });

    async function failingChunkedComplete() {
      const uploadId = await storage.initChunkedUpload!('c/final.txt', 2);
      await storage.uploadChunk!(uploadId, 0, Buffer.from('aa'));
      await storage.uploadChunk!(uploadId, 1, Buffer.from('bb'));
      const chunk1 = walk(tmpDir).find((f) => path.basename(f) === 'chunk-1');
      expect(chunk1).toBeDefined();
      fs.rmSync(chunk1!);
      await expect(storage.completeChunkedUpload!(uploadId)).rejects.toThrow();
      // Let the already-dispatched temp-file open settle before teardown removes the directory.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    it('completeChunkedUpload with a deleted chunk file throws and leaves no file under the final key', async () => {
      await failingChunkedComplete();
      expect(fs.existsSync(path.join(tmpDir, 'c/final.txt'))).toBe(false);
      expect((await storage.list('c')).map((f) => f.key)).toEqual([]);
    });

    // IMPLEMENTATION BUG (round 2): the write stream's open races the cleanup rm in
    // completeChunkedUpload, so a failed assembly can leave an orphan `.upload-*.tmp`.
    it('completeChunkedUpload failure leaves no temp file on disk', async () => {
      await failingChunkedComplete();
      expect(tempFiles(tmpDir)).toEqual([]);
    });

    it('downloadRange on an empty file: position 0 is an empty range, position 1 is a RangeError', async () => {
      await storage.upload(Buffer.alloc(0), 'empty.txt');
      const { stream, size } = await storage.downloadRange!('empty.txt', 0);
      expect(size).toBe(0);
      const parts: Buffer[] = [];
      for await (const part of stream) parts.push(Buffer.from(part));
      expect(Buffer.concat(parts).length).toBe(0);
      await expect(storage.downloadRange!('empty.txt', 1)).rejects.toThrow(RangeError);
    });
  });
});
