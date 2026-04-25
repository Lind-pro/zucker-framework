import { Injectable, Logger } from '@nestjs/common';
import { ReadStream } from 'fs';
import * as path from 'path';
import type { WebDAVClient, FileStat } from 'webdav';
import { FileManager, UploadOptions, UploadResult, FileInfo } from './storage.interface';

export interface WebDavStorageOptions {
  /** WebDAV 服务地址，如 https://nextcloud.example.com/remote.php/dav/files/user */
  url: string;
  username: string;
  password: string;
  /** 公开访问 URL 前缀（可选） */
  publicUrl?: string;
  /** 基础路径前缀（可选，默认 '/'） */
  basePath?: string;
}

@Injectable()
export class WebDavStorage implements FileManager {
  private readonly logger = new Logger(WebDavStorage.name);
  private client!: WebDAVClient;
  private readonly publicUrl: string;
  private readonly basePath: string;
  readonly providerType = 'webdav' as const;

  private readonly options: WebDavStorageOptions;

  constructor(options: WebDavStorageOptions) {
    this.options = options;
    this.publicUrl = options.publicUrl ?? '';
    this.basePath = options.basePath ?? '/';
    this.initClient();
    this.logger.log(`WebDAV 存储已初始化: ${options.url}`);
  }

  private initClient(): void {
    // 动态引入 webdav，避免未安装时模块加载失败
    const { createClient } = require('webdav') as typeof import('webdav');
    this.client = createClient(this.options.url, {
      username: this.options.username,
      password: this.options.password,
    });
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async upload(buffer: Buffer, key: string, options?: UploadOptions): Promise<UploadResult> {
    const remotePath = this.resolvePath(key);

    // 确保父目录存在
    const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    if (parentDir && parentDir !== '/') {
      await this.ensureDirectory(parentDir);
    }

    await this.client.putFileContents(remotePath, buffer, {
      contentLength: buffer.length,
      overwrite: true,
      headers: options?.contentType
        ? { 'Content-Type': options.contentType }
        : undefined,
    });

    return {
      key,
      url: this.buildUrl(key),
      size: buffer.length,
    };
  }

  async uploadStream(stream: ReadStream, key: string, options?: UploadOptions): Promise<UploadResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return this.upload(Buffer.concat(chunks), key, options);
  }

  async download(key: string): Promise<{ stream: ReadStream; size: number }> {
    const remotePath = this.resolvePath(key);
    const stat = await this.client.stat(remotePath) as FileStat;
    const buffer = await this.client.getFileContents(remotePath) as Buffer;

    // 将 Buffer 包装为 Readable 并兼容 ReadStream 类型
    const { Readable } = require('stream');
    const readable = Readable.from(buffer);

    return {
      stream: readable as unknown as ReadStream,
      size: stat.size ?? buffer.length,
    };
  }

  async delete(key: string): Promise<void> {
    const remotePath = this.resolvePath(key);
    try {
      await this.client.deleteFile(remotePath);
    } catch (error: unknown) {
      const err = error as { status?: number };
      // 忽略 404（文件不存在）
      if (err.status === 404) return;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const remotePath = this.resolvePath(key);
    return this.client.exists(remotePath);
  }

  async getPublicUrl(key: string): Promise<string> {
    return this.buildUrl(key);
  }

  async list(prefix: string): Promise<FileInfo[]> {
    const remotePath = this.resolvePath(prefix);

    try {
      const items = await this.client.getDirectoryContents(remotePath) as FileStat[];

      return items
        .filter((item: FileStat) => item.type === 'file')
        .map((item: FileStat) => ({
          key: this.stripBasePath(item.filename),
          size: item.size ?? 0,
          lastModified: new Date(item.lastmod ?? Date.now()),
          contentType: item.mime,
        }));
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err.status === 404) return [];
      throw error;
    }
  }

  async getFileInfo(key: string): Promise<FileInfo | undefined> {
    const remotePath = this.resolvePath(key);
    try {
      const stat = await this.client.stat(remotePath) as FileStat;
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
    const src = this.resolvePath(sourceKey);
    const dest = this.resolvePath(destKey);
    const parentDir = dest.substring(0, dest.lastIndexOf('/'));
    if (parentDir && parentDir !== '/') {
      await this.ensureDirectory(parentDir);
    }
    await this.client.copyFile(src, dest);
  }

  async move(sourceKey: string, destKey: string): Promise<void> {
    const src = this.resolvePath(sourceKey);
    const dest = this.resolvePath(destKey);
    const parentDir = dest.substring(0, dest.lastIndexOf('/'));
    if (parentDir && parentDir !== '/') {
      await this.ensureDirectory(parentDir);
    }
    await this.client.moveFile(src, dest);
  }

  /**
   * 递归创建目录
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    const exists = await this.client.exists(dirPath);
    if (!exists) {
      // 递归确保父目录
      const parent = dirPath.substring(0, dirPath.lastIndexOf('/'));
      if (parent && parent !== '/') {
        await this.ensureDirectory(parent);
      }
      await this.client.createDirectory(dirPath);
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
