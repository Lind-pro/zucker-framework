import type { FileManager } from './storage.interface';
import type { PrivateFileObjectStore } from './file-asset';
import {
  StorageTransferError,
  type StorageTransferErrorFactory,
  type DownloadedStorageObject,
} from './verified-object-transfer';

/** Bounded in-memory transfer adapter over the existing FileManager contract. */
export class BufferedFileManagerStore implements PrivateFileObjectStore {
  constructor(
    private readonly manager: FileManager,
    private readonly maxObjectBytes: number,
    private readonly errorFactory: StorageTransferErrorFactory = (code) =>
      new StorageTransferError(code),
  ) {
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1)
      throw new RangeError('maxObjectBytes must be a positive integer');
    if (!manager.isConfigured()) throw errorFactory('STORAGE_NOT_CONFIGURED');
  }

  async read(key: string): Promise<DownloadedStorageObject> {
    const downloaded = await this.manager.download(key);
    if (downloaded.size < 1 || downloaded.size > this.maxObjectBytes) {
      downloaded.stream.destroy();
      throw this.errorFactory('OBJECT_SIZE_OUT_OF_BOUNDS');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of downloaded.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.maxObjectBytes) {
        downloaded.stream.destroy();
        throw this.errorFactory('OBJECT_SIZE_OUT_OF_BOUNDS');
      }
      chunks.push(buffer);
    }
    return { body: Buffer.concat(chunks), reportedSize: downloaded.size };
  }

  exists(key: string): Promise<boolean> {
    return this.manager.exists(key);
  }

  delete(key: string): Promise<void> {
    return this.manager.delete(key);
  }

  async write(
    key: string,
    body: Buffer,
    options: { contentType: string; metadata: Record<string, string>; private: true },
  ): Promise<{ size: number }> {
    if (body.length > this.maxObjectBytes) throw this.errorFactory('OBJECT_SIZE_OUT_OF_BOUNDS');
    const result = await this.manager.upload(body, key, {
      contentType: options.contentType,
      metadata: options.metadata,
      acl: 'private',
    });
    return { size: result.size };
  }
}
