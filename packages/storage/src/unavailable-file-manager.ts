import type { ReadStream } from 'node:fs';
import type { FileInfo, FileManager, StorageProviderType, UploadOptions, UploadResult } from './storage.interface';

/** Disabled storage preserves startup availability while all data operations remain explicit. */
export class UnavailableFileManager implements FileManager {
  constructor(readonly providerType: StorageProviderType, private readonly message = `Storage provider ${providerType} is not configured`) {}

  isConfigured(): boolean {
    return false;
  }

  private unavailable(): Error {
    return new Error(this.message);
  }

  upload(_buffer: Buffer, _key: string, _options?: UploadOptions): Promise<UploadResult> {
    return Promise.reject(this.unavailable());
  }

  uploadStream(
    _stream: ReadStream,
    _key: string,
    _options?: UploadOptions,
  ): Promise<UploadResult> {
    return Promise.reject(this.unavailable());
  }

  download(_key: string): Promise<{ stream: ReadStream; size: number }> {
    return Promise.reject(this.unavailable());
  }

  delete(_key: string): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  exists(_key: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  getPublicUrl(_key: string): Promise<string> {
    return Promise.reject(this.unavailable());
  }

  getDownloadUrl(_key: string): Promise<string> {
    return Promise.reject(this.unavailable());
  }

  list(_prefix: string): Promise<FileInfo[]> {
    return Promise.resolve([]);
  }
}
