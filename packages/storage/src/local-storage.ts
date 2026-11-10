import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { ReadStream, createReadStream } from 'fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  FileManager,
  UploadOptions,
  UploadResult,
  FileInfo,
  type ChunkUploadState,
  type PosixFilePermissions,
  generateDateBasedKey,
  encodeKeyPath,
} from './storage.interface';

/** Temp files written next to the target by atomic writes (see `tempPathFor`). */
const TEMP_UPLOAD_NAME = /^\.upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

@Injectable()
export class LocalFileStorage implements FileManager {
  private readonly logger = new Logger(LocalFileStorage.name);
  readonly providerType = 'local' as const;
  private readonly basePath: string;
  private readonly baseUrl: string;
  /** Active chunked upload sessions */
  private readonly chunkedUploads = new Map<string, ChunkUploadState>();
  /** Last activity per upload session, used to expire abandoned sessions. */
  private readonly chunkedUploadTouchedAt = new Map<string, number>();
  private readonly chunkSessionTtlMs: number;
  private readonly maxChunks: number;

  constructor(options: {
    basePath: string;
    baseUrl?: string;
    /** Abandoned chunked uploads are removed after this idle time. Default 24 h. */
    chunkSessionTtlMs?: number;
    /** Upper bound for `totalChunks`. Default 10 000. */
    maxChunks?: number;
  }) {
    this.basePath = options.basePath;
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.chunkSessionTtlMs = options.chunkSessionTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxChunks = options.maxChunks ?? 10_000;
    fs.mkdirSync(this.basePath, { recursive: true });
    this.logger.log(`本地存储已初始化: ${this.basePath}`);
  }

  isConfigured(): boolean {
    return true;
  }

  async upload(buffer: Buffer, key: string, _options?: UploadOptions): Promise<UploadResult> {
    const filePath = this.resolvePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // Write next to the target and rename, so a crash never leaves a truncated object.
    const tempPath = this.tempPathFor(filePath);
    try {
      await fs.promises.writeFile(tempPath, buffer);
      await fs.promises.rename(tempPath, filePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }

    return {
      key,
      url: this.buildUrl(key),
      size: buffer.length,
    };
  }

  /** Streams to a temporary file (no full in-memory buffer) and renames it into place. */
  async uploadStream(stream: Readable, key: string, _options?: UploadOptions): Promise<UploadResult> {
    const filePath = this.resolvePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = this.tempPathFor(filePath);
    try {
      await pipeline(stream, fs.createWriteStream(tempPath, { flags: 'wx' }));
      const { size } = await fs.promises.stat(tempPath);
      await fs.promises.rename(tempPath, filePath);
      return { key, url: this.buildUrl(key), size };
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }
  }

  async download(key: string): Promise<{ stream: ReadStream; size: number }> {
    const filePath = this.resolvePath(key);
    const stat = fs.statSync(filePath);
    return {
      stream: createReadStream(filePath),
      size: stat.size,
    };
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      fs.statSync(filePath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  }

  async getPublicUrl(key: string): Promise<string> {
    return this.buildUrl(key);
  }

  async getDownloadUrl(key: string): Promise<string> {
    return this.getPublicUrl(key);
  }

  async list(prefix: string): Promise<FileInfo[]> {
    const dirPath = this.resolvePath(prefix);
    if (!fs.existsSync(dirPath)) return [];

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      // In-flight temp files of upload/uploadStream/completeChunkedUpload are not objects.
      .filter((e) => e.isFile() && !TEMP_UPLOAD_NAME.test(e.name))
      .map((e) => {
        const filePath = path.join(dirPath, e.name);
        const stat = fs.statSync(filePath);
        return {
          key: path.join(prefix, e.name),
          size: stat.size,
          lastModified: stat.mtime,
        };
      });
  }

  async downloadRange(
    key: string,
    position: number,
    length?: number,
  ): Promise<{ stream: ReadStream; size: number }> {
    const filePath = this.resolvePath(key);
    const stat = fs.statSync(filePath);
    // Position 0 of an empty file is a valid (empty) range, as before 1.0.19.
    if (position === 0 && stat.size === 0 && (length === undefined || (Number.isSafeInteger(length) && length > 0))) {
      return { stream: createReadStream(filePath), size: 0 };
    }
    if (!Number.isSafeInteger(position) || position < 0 || position >= stat.size) {
      throw new RangeError(`Range start ${position} is outside the file (size ${stat.size})`);
    }
    if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0)) {
      throw new RangeError(`Range length ${length} must be a positive integer`);
    }
    const end = length !== undefined
      ? Math.min(position + length - 1, stat.size - 1)
      : stat.size - 1;
    const readSize = end - position + 1;
    return {
      stream: createReadStream(filePath, { start: position, end }),
      size: readSize,
    };
  }

  async getFileInfo(key: string): Promise<FileInfo | undefined> {
    const filePath = this.resolvePath(key);
    if (!fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    return {
      key,
      size: stat.size,
      lastModified: stat.mtime,
    };
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const src = this.resolvePath(sourceKey);
    const dest = this.resolvePath(destKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  async move(sourceKey: string, destKey: string): Promise<void> {
    const src = this.resolvePath(sourceKey);
    const dest = this.resolvePath(destKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }

  async initChunkedUpload(key: string, totalChunks: number, totalSize?: number): Promise<string> {
    if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > this.maxChunks) {
      throw new Error(`totalChunks must be an integer between 1 and ${this.maxChunks}`);
    }
    if (totalSize !== undefined && (!Number.isSafeInteger(totalSize) || totalSize < 0)) {
      throw new Error('totalSize must be a non-negative integer');
    }
    this.resolvePath(key); // reject traversal before any chunk is accepted
    this.expireChunkedUploads();
    const uploadId = randomUUID();
    fs.mkdirSync(this.chunksDir(uploadId), { recursive: true });

    this.chunkedUploads.set(uploadId, {
      uploadId,
      key,
      totalChunks,
      receivedChunks: [],
      totalSize,
      complete: false,
    });
    this.chunkedUploadTouchedAt.set(uploadId, Date.now());

    this.logger.log(`Chunked upload initialized: ${uploadId} for key=${key}, totalChunks=${totalChunks}`);
    return uploadId;
  }

  async uploadChunk(uploadId: string, chunkIndex: number, buffer: Buffer): Promise<void> {
    this.expireChunkedUploads();
    const state = this.chunkedUploads.get(uploadId);
    if (!state) {
      throw new Error(`Unknown upload session: ${uploadId}`);
    }

    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= state.totalChunks) {
      throw new Error(`Invalid chunk index ${chunkIndex} (expected 0-${state.totalChunks - 1})`);
    }

    const chunkPath = path.join(this.chunksDir(uploadId), `chunk-${chunkIndex}`);
    fs.writeFileSync(chunkPath, buffer);
    if (!state.receivedChunks.includes(chunkIndex)) state.receivedChunks.push(chunkIndex);
    this.chunkedUploadTouchedAt.set(uploadId, Date.now());
  }

  async completeChunkedUpload(uploadId: string, _options?: UploadOptions): Promise<UploadResult> {
    this.expireChunkedUploads();
    const state = this.chunkedUploads.get(uploadId);
    if (!state) {
      throw new Error(`Unknown upload session: ${uploadId}`);
    }

    // Verify all chunks received
    const received = new Set(state.receivedChunks);
    const missing: number[] = [];
    for (let i = 0; i < state.totalChunks; i++) {
      if (!received.has(i)) {
        missing.push(i);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Missing chunks: ${missing.join(', ')}`);
    }

    // Assemble chunks into final file
    const filePath = this.resolvePath(state.key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Assemble into a temp file and rename, so a missing/unreadable chunk never leaves a
    // partial file under the final key.
    const tempPath = this.tempPathFor(filePath);
    const writeStream = fs.createWriteStream(tempPath);
    const finished = new Promise<void>((resolve, reject) => {
      writeStream.once('finish', resolve);
      writeStream.once('error', reject);
    });
    // Observed on every path: when the loop throws first, a later stream error (ENOSPC, ...)
    // must not become an unhandled rejection.
    finished.catch(() => {});
    try {
      for (let i = 0; i < state.totalChunks; i++) {
        const chunkPath = path.join(this.chunksDir(uploadId), `chunk-${i}`);
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
      }
      writeStream.end();
      await finished;
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      // The file is opened asynchronously: wait until the stream has closed its descriptor,
      // otherwise the open can recreate the temp file after it was removed.
      await new Promise<void>((resolve) => {
        if (writeStream.closed) {
          resolve();
          return;
        }
        writeStream.once('close', () => resolve());
        writeStream.destroy();
      });
      fs.rmSync(tempPath, { force: true });
      throw error;
    }

    // Cleanup chunks
    fs.rmSync(this.chunksDir(uploadId), { recursive: true, force: true });

    state.complete = true;
    this.chunkedUploads.delete(uploadId);
    this.chunkedUploadTouchedAt.delete(uploadId);

    const stat = fs.statSync(filePath);
    return {
      key: state.key,
      url: this.buildUrl(state.key),
      size: stat.size,
    };
  }

  async abortChunkedUpload(uploadId: string): Promise<void> {
    // Upload ids come back from clients: only ids of sessions this instance created
    // are honoured, so a crafted id can never select another directory.
    if (!this.chunkedUploads.has(uploadId)) return;
    this.removeChunkedUpload(uploadId);
    this.logger.log(`Chunked upload aborted: ${uploadId}`);
  }

  private removeChunkedUpload(uploadId: string): void {
    fs.rmSync(this.chunksDir(uploadId), { recursive: true, force: true });
    this.chunkedUploads.delete(uploadId);
    this.chunkedUploadTouchedAt.delete(uploadId);
  }

  private expireChunkedUploads(now = Date.now()): void {
    for (const [uploadId, touchedAt] of this.chunkedUploadTouchedAt) {
      if (now - touchedAt <= this.chunkSessionTtlMs) continue;
      try {
        this.removeChunkedUpload(uploadId);
        this.logger.warn(`Expired abandoned chunked upload: ${uploadId}`);
      } catch (error) {
        this.logger.warn(`Failed to remove expired chunked upload ${uploadId}: ${String(error)}`);
      }
    }
  }

  /** Chunk directory of a known session, contained in `<basePath>/.chunks`. */
  private chunksDir(uploadId: string): string {
    const root = path.resolve(this.basePath, '.chunks');
    const dir = path.resolve(root, uploadId);
    if (path.dirname(dir) !== root) {
      throw new Error(`Invalid upload id: ${uploadId}`);
    }
    return dir;
  }

  /**
   * Temp name independent of the target name: a target basename near the 255-byte limit
   * (for example ~80 CJK characters) must not overflow it.
   */
  private tempPathFor(filePath: string): string {
    return path.join(path.dirname(filePath), `.upload-${randomUUID()}.tmp`);
  }

  /**
   * 便捷文件保存
   * 自动根据文件类型生成日期归档路径并保存。
   */
  async saveFile(buffer: Buffer, fileType: string, options?: UploadOptions): Promise<UploadResult> {
    const normalizedType = fileType.startsWith('.') ? fileType : `.${fileType}`;
    const key = generateDateBasedKey(`_temp${normalizedType}`);
    return this.upload(buffer, key, options);
  }

  /**
   * 应用 POSIX 文件权限
   * 使用 fs.chmodSync 设置文件权限，非 POSIX 系统静默忽略错误。
   */
  async applyFilePermission(key: string, permissions: PosixFilePermissions): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      fs.chmodSync(filePath, permissions.mode);
    } catch {
      // 非 POSIX 系统（如 Windows）静默忽略
    }
  }

  /**
   * Resolve a storage key to an absolute file path.
   * Validates against path traversal attacks (e.g. "../../../etc/passwd").
   */
  private resolvePath(key: string): string {
    const resolved = path.resolve(this.basePath, key);
    const normalizedBase = path.resolve(this.basePath);
    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
      throw new Error(`Path traversal detected: key "${key}" resolves outside base path`);
    }
    return resolved;
  }

  private buildUrl(key: string): string {
    return this.baseUrl ? `${this.baseUrl}/${encodeKeyPath(key)}` : key;
  }
}
