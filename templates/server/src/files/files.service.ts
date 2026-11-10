import { BadRequestException, HttpException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { BufferedFileManagerStore, FILE_MANAGER, FileAssetError, PrivateFileAssetService, sanitizeFileName } from '@zucker-framework/storage';
import type { FileAsset, FileManager } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../database';
import { PostgresFileAssetRepository, type FileOwnerQuota } from './file-asset.repository';
import { DEFAULT_OWNER_MAX_BYTES, DEFAULT_OWNER_MAX_FILES, detectPrivateFileMime, FILES_OPTIONS, type FilesOptions, MAX_FILE_BYTES } from './files.config';

function quotaExceeded(): HttpException {
  return new HttpException({ code: 'FILE_QUOTA_EXCEEDED', message: 'Private file storage quota exceeded; delete files before uploading more' }, 413);
}

export interface UploadedPrivateFile { originalname: string; buffer: Buffer }

@Injectable()
export class FilesService {
  private readonly repository: PostgresFileAssetRepository;
  private readonly assets: PrivateFileAssetService<{ ownerId: string }>;
  private readonly quota: FileOwnerQuota;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(FILE_MANAGER) manager: FileManager, @Inject(FILES_OPTIONS) private readonly options: FilesOptions) {
    if (options.maxObjectBytes > MAX_FILE_BYTES) throw new Error('Private file limit exceeds the HTTP upload boundary');
    this.quota = { maxBytes: options.maxOwnerBytes ?? DEFAULT_OWNER_MAX_BYTES, maxFiles: options.maxOwnerFiles ?? DEFAULT_OWNER_MAX_FILES };
    this.repository = new PostgresFileAssetRepository(database, this.quota);
    this.assets = new PrivateFileAssetService({ repository: this.repository,
      objects: new BufferedFileManagerStore(manager, options.maxObjectBytes), maxObjectBytes: options.maxObjectBytes,
      authorize: (context, access) => !!context.ownerId && context.ownerId === access.scope, detectMimeType: detectPrivateFileMime });
  }
  validateRequestKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new BadRequestException('A stable Idempotency-Key is required');
    return value;
  }
  async upload(ownerId: string, key: string | undefined, file: UploadedPrivateFile | undefined) {
    const idempotencyKey = this.validateRequestKey(key);
    if (!file || !Buffer.isBuffer(file.buffer) || typeof file.originalname !== 'string') throw new BadRequestException('One file is required');
    if (file.buffer.length > this.options.maxObjectBytes) throw new PayloadTooLargeException('Private file exceeds the configured size limit');
    let fileName: string;
    try { fileName = sanitizeFileName(file.originalname); } catch { throw new BadRequestException('Invalid filename'); }
    try { return await this.assets.upload({ ownerId }, { scope: ownerId, idempotencyKey, fileName, body: file.buffer }); }
    catch (error) {
      // The repository enforces the quota atomically; the storage service reports its refusal as a
      // generic metadata failure, so confirm the cause before answering 413 instead of 503.
      if (error instanceof FileAssetError && error.code === 'METADATA_UNAVAILABLE') {
        const replay = await this.database.model('fileAssets').count({ where: { ownerId, idempotencyKey } }).catch(() => 1);
        if (!replay && PostgresFileAssetRepository.exceeds(this.quota, await this.repository.usage(ownerId).catch(() => ({ bytes: 0, files: 0 })), file.buffer.length))
          throw quotaExceeded();
      }
      throw error;
    }
  }
  /** Current usage against the per-owner limits. */
  async usage(ownerId: string) {
    return { ...await this.repository.usage(ownerId), maxBytes: this.quota.maxBytes, maxFiles: this.quota.maxFiles };
  }
  async list(ownerId: string, pageValue?: string) {
    const page = pageValue === undefined ? 1 : Number(pageValue);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Invalid file page');
    return this.database.transaction(async tx => {
      const where = { ownerId }, select = { id: true, fileName: true, size: true, mimeType: true, state: true, createdAt: true, updatedAt: true, deletedAt: true, cleanupStatus: true, cleanupConfirmedAt: true };
      const rows = await tx.model('fileAssets').findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20 });
      const total = await tx.model('fileAssets').count({ where });
      return { data: rows, total, page, pageSize: 20 };
    });
  }
  inspect(ownerId: string, id: string) { return this.assets.inspect({ ownerId }, ownerId, id); }
  read(ownerId: string, id: string) { return this.assets.read({ ownerId }, ownerId, id); }
  async delete(ownerId: string, id: string) {
    await this.repository.beginDeletion(ownerId, id); return this.assets.recover({ ownerId }, ownerId, id);
  }
  recover(ownerId: string, id: string) { return this.assets.recover({ ownerId }, ownerId, id); }
  /** Lets a caller find a pending reservation after an upload/response failure using its original request key. */
  async inspectRequest(ownerId: string, key: string) {
    const rows = await this.database.model('fileAssets').findMany({ where: { ownerId, idempotencyKey: this.validateRequestKey(key) }, select: { id: true }, take: 1 }) as Array<{ id: string }>;
    if (!rows[0]) throw new NotFoundException();
    return this.inspect(ownerId, rows[0].id);
  }
}

export function publicFileAsset(asset: FileAsset) {
  return { id: asset.id, fileName: asset.fileName, size: asset.size, mimeType: asset.mimeType,
    state: asset.state, createdAt: new Date(asset.createdAt), updatedAt: new Date(asset.updatedAt),
    deletedAt: asset.deletedAt === null ? null : new Date(asset.deletedAt), cleanupStatus: asset.cleanupStatus,
    cleanupConfirmedAt: asset.cleanupConfirmedAt === null ? null : new Date(asset.cleanupConfirmedAt) };
}
