import { Logger } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebDavStorage } from './webdav-storage';

// Mock webdav module
const mockPutFileContents = vi.fn();
const mockGetFileContents = vi.fn();
const mockStat = vi.fn();
const mockDeleteFile = vi.fn();
const mockExists = vi.fn();
const mockGetDirectoryContents = vi.fn();
const mockCopyFile = vi.fn();
const mockMoveFile = vi.fn();
const mockCreateDirectory = vi.fn();

vi.mock('webdav', () => ({
  createClient: vi.fn(() => ({
    putFileContents: mockPutFileContents,
    getFileContents: mockGetFileContents,
    stat: mockStat,
    deleteFile: mockDeleteFile,
    exists: mockExists,
    getDirectoryContents: mockGetDirectoryContents,
    copyFile: mockCopyFile,
    moveFile: mockMoveFile,
    createDirectory: mockCreateDirectory,
  })),
}));

const defaultOptions = {
  url: 'https://dav.example.com/remote.php/dav',
  username: 'user',
  password: 'pass',
  publicUrl: 'https://public.example.com',
  basePath: '/files',
};

const loggerLog = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

describe('WebDavStorage', () => {
  let storage: WebDavStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new WebDavStorage(defaultOptions);
  });

  it('should report providerType as webdav', () => {
    expect(storage.providerType).toBe('webdav');
  });

  it('should be configured after construction', () => {
    expect(storage.isConfigured()).toBe(true);
  });

  it('rejects incomplete credentials before creating a client', () => {
    expect(() => new WebDavStorage({ ...defaultOptions, password: '' })).toThrow(
      'WebDAV url, username and password are required',
    );
  });

  it('does not disclose the endpoint or credentials in lifecycle logs', () => {
    expect(loggerLog).toHaveBeenCalledWith('WebDAV storage initialized');
    expect(JSON.stringify(loggerLog.mock.calls)).not.toContain(defaultOptions.url);
    expect(JSON.stringify(loggerLog.mock.calls)).not.toContain(defaultOptions.username);
    expect(JSON.stringify(loggerLog.mock.calls)).not.toContain(defaultOptions.password);
  });

  // ---- upload ----

  it('should upload a buffer via putFileContents', async () => {
    mockPutFileContents.mockResolvedValueOnce(undefined);
    mockExists.mockResolvedValue(true);

    const result = await storage.upload(Buffer.from('hello'), 'doc.txt', {
      contentType: 'text/plain',
    });

    expect(mockPutFileContents).toHaveBeenCalledTimes(1);
    const [remotePath, buffer, opts] = mockPutFileContents.mock.calls[0];
    expect(remotePath).toBe('/files/doc.txt');
    expect(buffer).toEqual(Buffer.from('hello'));
    expect(opts.headers['Content-Type']).toBe('text/plain');

    expect(result.key).toBe('doc.txt');
    expect(result.url).toBe('https://public.example.com/doc.txt');
    expect(result.size).toBe(5);
  });

  it('coalesces concurrent creation of the same directory', async () => {
    mockExists.mockImplementation(async (remotePath: string) => remotePath === '/files');
    mockCreateDirectory.mockResolvedValueOnce(undefined);
    mockPutFileContents.mockResolvedValue(undefined);

    await Promise.all([
      storage.upload(Buffer.from('a'), 'shared/a.txt'),
      storage.upload(Buffer.from('b'), 'shared/b.txt'),
    ]);

    expect(mockCreateDirectory).toHaveBeenCalledTimes(1);
    expect(mockCreateDirectory).toHaveBeenCalledWith('/files/shared');
    expect(mockPutFileContents).toHaveBeenCalledTimes(2);
  });

  it('accepts a cross-process directory creation conflict after verifying existence', async () => {
    mockExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockCreateDirectory.mockRejectedValueOnce({ status: 409 });
    mockPutFileContents.mockResolvedValueOnce(undefined);

    await expect(storage.upload(Buffer.from('a'), 'shared/a.txt')).resolves.toEqual(
      expect.objectContaining({ key: 'shared/a.txt' }),
    );
  });

  // ---- download ----

  it('should download a file', async () => {
    const content = Buffer.from('file data');
    mockStat.mockResolvedValueOnce({ size: content.length });
    mockGetFileContents.mockResolvedValueOnce(content);

    const { size } = await storage.download('doc.txt');
    expect(size).toBe(9);
  });

  // ---- delete ----

  it('should delete a file', async () => {
    mockDeleteFile.mockResolvedValueOnce(undefined);

    await storage.delete('old.txt');

    expect(mockDeleteFile).toHaveBeenCalledWith('/files/old.txt');
  });

  it('should ignore 404 on delete', async () => {
    mockDeleteFile.mockRejectedValueOnce({ status: 404 });

    await expect(storage.delete('gone.txt')).resolves.toBeUndefined();
  });

  it('should rethrow non-404 errors on delete', async () => {
    mockDeleteFile.mockRejectedValueOnce({ status: 500, message: 'server error' });

    await expect(storage.delete('err.txt')).rejects.toMatchObject({ status: 500 });
  });

  // ---- exists ----

  it('should check file existence', async () => {
    mockExists.mockResolvedValueOnce(true);

    expect(await storage.exists('test.txt')).toBe(true);
    expect(mockExists).toHaveBeenCalledWith('/files/test.txt');
  });

  // ---- getPublicUrl ----

  it('should return public URL', async () => {
    const url = await storage.getPublicUrl('path/to/file.pdf');
    expect(url).toBe('https://public.example.com/path/to/file.pdf');
  });

  it('should return key when no publicUrl', async () => {
    const bare = new WebDavStorage({ ...defaultOptions, publicUrl: undefined });
    const url = await bare.getPublicUrl('file.txt');
    expect(url).toBe('file.txt');
  });

  // ---- list ----

  it('should list files in a directory', async () => {
    mockGetDirectoryContents.mockResolvedValueOnce([
      {
        type: 'file',
        filename: '/files/dir/a.txt',
        size: 100,
        lastmod: '2024-01-01',
        mime: 'text/plain',
      },
      {
        type: 'file',
        filename: '/files/dir/b.txt',
        size: 200,
        lastmod: '2024-02-01',
        mime: 'text/plain',
      },
      { type: 'directory', filename: '/files/dir/sub', size: 0, lastmod: '2024-01-01' },
    ]);

    const files = await storage.list('dir');
    expect(files).toHaveLength(2);
    expect(files[0].key).toBe('dir/a.txt');
    expect(files[1].size).toBe(200);
  });

  it('should return empty list on 404', async () => {
    mockGetDirectoryContents.mockRejectedValueOnce({ status: 404 });

    const files = await storage.list('nonexistent');
    expect(files).toEqual([]);
  });

  // ---- getFileInfo ----

  it('should return file info', async () => {
    mockStat.mockResolvedValueOnce({
      type: 'file',
      size: 1024,
      lastmod: '2024-06-15T10:00:00Z',
      mime: 'application/json',
    });

    const info = await storage.getFileInfo('data.json');
    expect(info).toBeDefined();
    expect(info!.key).toBe('data.json');
    expect(info!.size).toBe(1024);
    expect(info!.contentType).toBe('application/json');
  });

  it('should return undefined for directory', async () => {
    mockStat.mockResolvedValueOnce({ type: 'directory' });

    const info = await storage.getFileInfo('somedir');
    expect(info).toBeUndefined();
  });

  it('should return undefined on 404', async () => {
    mockStat.mockRejectedValueOnce({ status: 404 });

    const info = await storage.getFileInfo('nope.txt');
    expect(info).toBeUndefined();
  });

  // ---- copy / move ----

  it('should copy a file', async () => {
    mockExists.mockResolvedValue(true);
    mockCopyFile.mockResolvedValueOnce(undefined);

    await storage.copy!('src.txt', 'dst.txt');

    expect(mockCopyFile).toHaveBeenCalledWith('/files/src.txt', '/files/dst.txt');
  });

  it('should move a file', async () => {
    mockExists.mockResolvedValue(true);
    mockMoveFile.mockResolvedValueOnce(undefined);

    await storage.move!('old.txt', 'new.txt');

    expect(mockMoveFile).toHaveBeenCalledWith('/files/old.txt', '/files/new.txt');
  });

  // ---- path traversal protection ----

  it('should reject path traversal on upload', async () => {
    await expect(storage.upload(Buffer.from('evil'), '../../../etc/passwd')).rejects.toThrow(
      'Path traversal detected',
    );
  });

  it('should reject path traversal on download', async () => {
    await expect(storage.download('../../secret')).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on delete', async () => {
    await expect(storage.delete('../../etc/shadow')).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on exists', async () => {
    await expect(storage.exists('../../../etc/hosts')).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on list', async () => {
    await expect(storage.list('../../')).rejects.toThrow('Path traversal detected');
  });

  it('should reject path traversal on getFileInfo', async () => {
    await expect(storage.getFileInfo('../../secret.txt')).rejects.toThrow(
      'Path traversal detected',
    );
  });

  // ---- uploadStream ----

  it('should upload from stream by collecting chunks', async () => {
    mockPutFileContents.mockResolvedValueOnce(undefined);
    mockExists.mockResolvedValue(true);

    const chunks = [Buffer.from('ab'), Buffer.from('cd')];
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };

    const result = await storage.uploadStream(mockStream as any, 'stream.txt');
    expect(result.size).toBe(4);
  });
});
