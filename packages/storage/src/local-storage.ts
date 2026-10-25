import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { ReadStream, createReadStream } from 'fs';
import type { Readable } from 'node:stream';
import {
  FileManager,
  UploadOptions,
  UploadResult,
  FileInfo,
  type ChunkUploadState,
  type PosixFilePermissions,
  generateDateBasedKey,
} from './storage.interface';

@Injectable()
export class LocalFileStorage implements FileManager {
  private readonly logger = new Logger(LocalFileStorage.name);
  readonly providerType = 'local' as const;
  private readonly basePath: string;
  private readonly baseUrl: string;
  /** Active chunked upload sessions */
  private readonly chunkedUploads = new Map<string, ChunkUploadState>();

  constructor(options: { basePath: string; baseUrl?: string }) {
    this.basePath = options.basePath;
    this.baseUrl = options.baseUrl ?? '';
    fs.mkdirSync(this.basePath, { recursive: true });
    this.logger.log(`本地存储已初始化: ${this.basePath}`);
  }

  isConfigured(): boolean {
    return true;
  }

  async upload(buffer: Buffer, key: string, _options?: UploadOptions): Promise<UploadResult> {
    const filePath = this.resolvePath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return {
      key,
      url: this.buildUrl(key),
      size: buffer.length,
    };
  }

  async uploadStream(stream: Readable, key: string, options?: UploadOptions): Promise<UploadResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return this.upload(Buffer.concat(chunks), key, options);
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
      .filter((e) => e.isFile())
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
    const uploadId = randomUUID();
    const chunksDir = path.join(this.basePath, '.chunks', uploadId);
    fs.mkdirSync(chunksDir, { recursive: true });

    this.chunkedUploads.set(uploadId, {
      uploadId,
      key,
      totalChunks,
      receivedChunks: [],
      totalSize,
      complete: false,
    });

    this.logger.log(`Chunked upload initialized: ${uploadId} for key=${key}, totalChunks=${totalChunks}`);
    return uploadId;
  }

  async uploadChunk(uploadId: string, chunkIndex: number, buffer: Buffer): Promise<void> {
    const state = this.chunkedUploads.get(uploadId);
    if (!state) {
      throw new Error(`Unknown upload session: ${uploadId}`);
    }

    if (chunkIndex < 0 || chunkIndex >= state.totalChunks) {
      throw new Error(`Invalid chunk index ${chunkIndex} (expected 0-${state.totalChunks - 1})`);
    }

    const chunkPath = path.join(this.basePath, '.chunks', uploadId, `chunk-${chunkIndex}`);
    fs.writeFileSync(chunkPath, buffer);
    state.receivedChunks.push(chunkIndex);
  }

  async completeChunkedUpload(uploadId: string, _options?: UploadOptions): Promise<UploadResult> {
    const state = this.chunkedUploads.get(uploadId);
    if (!state) {
      throw new Error(`Unknown upload session: ${uploadId}`);
    }

    // Verify all chunks received
    const missing: number[] = [];
    for (let i = 0; i < state.totalChunks; i++) {
      if (!state.receivedChunks.includes(i)) {
        missing.push(i);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Missing chunks: ${missing.join(', ')}`);
    }

    // Assemble chunks into final file
    const filePath = this.resolvePath(state.key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const writeStream = fs.createWriteStream(filePath);
    for (let i = 0; i < state.totalChunks; i++) {
      const chunkPath = path.join(this.basePath, '.chunks', uploadId, `chunk-${i}`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
    }
    writeStream.end();

    // Wait for write to complete
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Cleanup chunks
    const chunksDir = path.join(this.basePath, '.chunks', uploadId);
    fs.rmSync(chunksDir, { recursive: true, force: true });

    state.complete = true;
    this.chunkedUploads.delete(uploadId);

    const stat = fs.statSync(filePath);
    return {
      key: state.key,
      url: this.buildUrl(state.key),
      size: stat.size,
    };
  }

  async abortChunkedUpload(uploadId: string): Promise<void> {
    const chunksDir = path.join(this.basePath, '.chunks', uploadId);
    if (fs.existsSync(chunksDir)) {
      fs.rmSync(chunksDir, { recursive: true, force: true });
    }
    this.chunkedUploads.delete(uploadId);
    this.logger.log(`Chunked upload aborted: ${uploadId}`);
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
    return this.baseUrl ? `${this.baseUrl}/${key}` : key;
  }
}
