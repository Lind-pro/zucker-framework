import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { Readable, Transform, addAbortSignal } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import type { WebDAVClient, FileStat } from 'webdav';
import { FileManager, UploadOptions, UploadResult, FileInfo } from './storage.interface';

export interface WebDavEntry extends FileInfo {
  type: 'file' | 'directory';
  filename: string;
  basename: string;
  lastmod: string;
}

export interface WebDavStorageOptions {
  /** WebDAV 服务地址，如 https://nextcloud.example.com/remote.php/dav/files/user */
  url: string;
  username?: string;
  password?: string;
  /** Explicit opt-in for endpoints/consumer policies allowing missing credentials. Default false. */
  allowAnonymous?: boolean;
  /** 公开访问 URL 前缀（可选） */
  publicUrl?: string;
  /** 基础路径前缀（可选，默认 '/'） */
  basePath?: string;
}

@Injectable()
export class WebDavStorage implements FileManager {
  private readonly logger = new Logger(WebDavStorage.name);
  private clientPromise?: Promise<WebDAVClient>;
  private readonly publicUrl: string;
  private readonly basePath: string;
  private readonly directoryPromises = new Map<string, Promise<void>>();
  readonly providerType = 'webdav' as const;

  private readonly options: WebDavStorageOptions;

  constructor(options: WebDavStorageOptions) {
    if (!options.url || (!options.allowAnonymous && (!options.username || !options.password))) {
      throw new Error('WebDAV url, username and password are required');
    }
    this.options = options;
    this.publicUrl = (options.publicUrl ?? '').replace(/\/$/, '');
    this.basePath = options.basePath?.trim() || '/';
    this.logger.log('WebDAV storage initialized');
  }

  private async initClient(): Promise<WebDAVClient> {
    const { createClient } = await import('webdav');
    return createClient(this.options.url, {
      username: this.options.username,
      password: this.options.password,
    });
  }

  private getClient(): Promise<WebDAVClient> {
    this.clientPromise ??= this.initClient();
    return this.clientPromise;
  }

  isConfigured(): boolean {
    return true;
  }

  async upload(buffer: Buffer, key: string, options?: UploadOptions): Promise<UploadResult> {
    const client = await this.getClient();
    const remotePath = this.resolvePath(key);

    // 确保父目录存在
    const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    if (parentDir && parentDir !== '/') {
      await this.ensureRemoteDirectory(parentDir);
    }

    await client.putFileContents(remotePath, buffer, {
      contentLength: buffer.length,
      overwrite: true,
      headers: options?.contentType ? { 'Content-Type': options.contentType } : undefined,
    });

    return {
      key,
      url: this.buildUrl(key),
      size: buffer.length,
    };
  }

  async uploadStream(
    stream: Readable,
    key: string,
    options?: UploadOptions & { signal?: AbortSignal },
  ): Promise<UploadResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    let size = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    } });
    let transfer: Promise<unknown> | undefined;
    let pumping: Promise<void> | undefined;
    const sourceError = (error: Error) => controller.abort(error);
    stream.on('error', sourceError);
    addAbortSignal(controller.signal, stream);
    try {
      controller.signal.throwIfAborted();
      const client = await this.getClient();
      const remotePath = this.resolvePath(key);
      await this.ensureRemoteDirectory(path.posix.dirname(remotePath), controller.signal);
      controller.signal.throwIfAborted();
      transfer = client.putFileContents(remotePath, counter, {
        overwrite: true, contentLength: false, signal: controller.signal,
        headers: options?.contentType ? { 'Content-Type': options.contentType } : undefined,
      });
      pumping = pipeline(stream, counter, { signal: controller.signal });
      await Promise.all([transfer, pumping]);
      return { key, url: this.buildUrl(key), size };
    } catch (error) {
      controller.abort(error);
      stream.destroy(error instanceof Error ? error : new Error('Storage upload failed'));
      counter.destroy();
      // Wait for asynchronous destroy/error delivery before removing our source observer.
      await Promise.allSettled([transfer, pumping, finished(stream, { cleanup: true })]);
      throw error;
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      stream.off('error', sourceError);
    }
  }

  async download(key: string, options?: { signal?: AbortSignal }): Promise<{ stream: Readable; size: number }> {
    options?.signal?.throwIfAborted();
    const client = await this.getClient();
    const remotePath = this.resolvePath(key);
    const stat = (await client.stat(remotePath, ...(options?.signal ? [{ signal: options.signal }] : []))) as FileStat;
    if (stat.type !== 'file') throw new Error('Remote path is not a file');
    options?.signal?.throwIfAborted();
    const stream = client.createReadStream(remotePath, ...(options?.signal ? [{ signal: options.signal }] : []));
    if (options?.signal) addAbortSignal(options.signal, stream);
    return { stream, size: stat.size };
  }

  async delete(key: string): Promise<void> {
    const client = await this.getClient();
    const remotePath = this.resolvePath(key);
    try {
      await client.deleteFile(remotePath);
    } catch (error: unknown) {
      const err = error as { status?: number };
      // 忽略 404（文件不存在）
      if (err.status === 404) return;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.getClient();
    const remotePath = this.resolvePath(key);
    return client.exists(remotePath);
  }

  async getPublicUrl(key: string): Promise<string> {
    return this.buildUrl(key);
  }

  async getDownloadUrl(key: string): Promise<string> {
    return this.getPublicUrl(key);
  }

  async list(prefix: string, options: { deep?: boolean; includeDirectories?: boolean; missing?: 'empty' | 'throw' } = {}): Promise<WebDavEntry[]> {
    const client = await this.getClient();
    const remotePath = this.resolvePath(prefix);

    try {
      const items = (await client.getDirectoryContents(remotePath, { deep: options.deep ?? true })) as FileStat[];

      return items
        .filter((item: FileStat) => item.type === 'file' || options.includeDirectories)
        .map((item: FileStat) => ({
          key: this.stripBasePath(item.filename),
          type: item.type,
          filename: item.filename,
          basename: item.basename,
          lastmod: item.lastmod,
          size: item.size ?? 0,
          lastModified: new Date(item.lastmod ?? Date.now()),
          contentType: item.mime,
        }));
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err.status === 404 && options.missing !== 'throw') return [];
      throw error;
    }
  }

  async getFileInfo(key: string): Promise<FileInfo | undefined> {
    const client = await this.getClient();
    const remotePath = this.resolvePath(key);
    try {
      const stat = (await client.stat(remotePath)) as FileStat;
      if (stat.type === 'directory') return undefined;
      return {
        key,
        size: stat.size ?? 0,
        lastModified: new Date(stat.lastmod ?? Date.now()),
        contentType: stat.mime,
      };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err.status === 404) return undefined;
      throw error;
    }
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const client = await this.getClient();
    const src = this.resolvePath(sourceKey);
    const dest = this.resolvePath(destKey);
    const parentDir = dest.substring(0, dest.lastIndexOf('/'));
    if (parentDir && parentDir !== '/') {
      await this.ensureDirectory(parentDir);
    }
    await client.copyFile(src, dest);
  }

  async move(sourceKey: string, destKey: string): Promise<void> {
    const client = await this.getClient();
    const src = this.resolvePath(sourceKey);
    const dest = this.resolvePath(destKey);
    const parentDir = dest.substring(0, dest.lastIndexOf('/'));
    if (parentDir && parentDir !== '/') {
      await this.ensureDirectory(parentDir);
    }
    await client.moveFile(src, dest);
  }

  /**
   * 递归创建目录
   */
  /** Accepts a storage key, with the same traversal protection as upload. */
  async ensureDirectory(key: string): Promise<void> {
    return this.ensureRemoteDirectory(this.resolvePath(key));
  }

  private async ensureRemoteDirectory(dirPath: string, signal?: AbortSignal): Promise<void> {
    // Cancellable requests must not inherit another request's directory operation/signal.
    if (signal) return this.createDirectoryIfMissing(dirPath, signal);
    const inflight = this.directoryPromises.get(dirPath);
    if (inflight) return inflight;

    const creation = this.createDirectoryIfMissing(dirPath);
    this.directoryPromises.set(dirPath, creation);
    try {
      await creation;
    } finally {
      if (this.directoryPromises.get(dirPath) === creation) {
        this.directoryPromises.delete(dirPath);
      }
    }
  }

  private async createDirectoryIfMissing(dirPath: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const client = await this.getClient();
    if (await client.exists(dirPath, ...(signal ? [{ signal }] : []))) return;

    const parent = dirPath.substring(0, dirPath.lastIndexOf('/'));
    if (parent && parent !== '/') {
      await this.ensureRemoteDirectory(parent, signal);
    }
    try {
      signal?.throwIfAborted();
      await client.createDirectory(dirPath, ...(signal ? [{ signal }] : []));
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if ([405, 409].includes(status ?? 0) && (await client.exists(dirPath, ...(signal ? [{ signal }] : [])))) return;
      throw error;
    }
  }

  private resolvePath(key: string): string {
    const base = this.basePath.endsWith('/') ? this.basePath : `${this.basePath}/`;
    const resolved = path.posix.resolve(base, key);
    const normalizedBase = path.posix.resolve(base);
    if (!resolved.startsWith(normalizedBase + '/') && resolved !== normalizedBase) {
      throw new Error(`Path traversal detected: key "${key}" resolves outside base path`);
    }
    return resolved;
  }

  private stripBasePath(fullPath: string): string {
    const base = this.basePath.endsWith('/') ? this.basePath : `${this.basePath}/`;
    if (fullPath.startsWith(base)) {
      return fullPath.substring(base.length);
    }
    return fullPath;
  }

  private buildUrl(key: string): string {
    return this.publicUrl ? `${this.publicUrl}/${key}` : key;
  }
}
