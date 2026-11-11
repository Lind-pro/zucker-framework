import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { BufferedFileManagerStore, FILE_MANAGER, FileAssetError, PrivateFileAssetService, sanitizeFileName } from '@zucker-framework/storage';
import type { FileAsset, FileManager } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../database';
import { FileQuotaExceededError, PostgresFileAssetRepository, type FileOwnerQuota } from './file-asset.repository';
import { FileObjectIntentLostError, FileObjectIntents, graceMilliseconds } from './file-object-intents';
import { DEFAULT_OWNER_MAX_BYTES, DEFAULT_OWNER_MAX_FILES, detectPrivateFileMime, FILES_OPTIONS, type FilesOptions, MAX_FILE_BYTES } from './files.config';

function quotaExceeded(): HttpException {
  return new HttpException({ code: 'FILE_QUOTA_EXCEEDED', message: 'Private file storage quota exceeded; delete files before uploading more' }, 413);
}

export interface UploadedPrivateFile { originalname: string; buffer: Buffer }

/**
 * Largest server-generated private file (AI outputs) this service stores or streams back. Uploads
 * through HTTP stay bounded by `FilesOptions.maxObjectBytes`; `file_assets.size` is a 32-bit integer.
 */
export const MAX_GENERATED_FILE_BYTES = 1024 * 1024 * 1024;

export interface GeneratedFileInput {
  fileName: string;
  /** Bytes to store; consumed once. A stream error aborts the write and removes the partial object. */
  stream: Readable;
  /** Hard cap for this object (<= MAX_GENERATED_FILE_BYTES), enforced while streaming. */
  maxBytes: number;
}

/** A private file read: small files buffered and verified up front, large ones streamed and verified as they flow. */
export type PrivateFileRead = { asset: FileAsset; body: Buffer } | { asset: FileAsset; stream: Readable; size: number };

@Injectable()
export class FilesService {
  private readonly repository: PostgresFileAssetRepository;
  private readonly assets: PrivateFileAssetService<{ ownerId: string }>;
  private readonly quota: FileOwnerQuota;
  private readonly intents: FileObjectIntents;
  private readonly logger = new Logger(FilesService.name);
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(FILE_MANAGER) private readonly manager: FileManager, @Inject(FILES_OPTIONS) private readonly options: FilesOptions) {
    if (options.maxObjectBytes > MAX_FILE_BYTES) throw new Error('Private file limit exceeds the HTTP upload boundary');
    this.quota = { maxBytes: options.maxOwnerBytes ?? DEFAULT_OWNER_MAX_BYTES, maxFiles: options.maxOwnerFiles ?? DEFAULT_OWNER_MAX_FILES };
    this.repository = new PostgresFileAssetRepository(database, this.quota);
    this.intents = new FileObjectIntents(database);
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
  /**
   * Stores server-generated content (AI outputs) as the owner's ready private file without buffering
   * it: the stream is written to a fresh object key while it is hashed and capped, read back and
   * verified, then recorded `ready` in one quota-checked transaction (the actual size counts toward
   * the owner's file quota). Any failure removes the object. Idempotent per (owner, key): an existing
   * ready file is returned without consuming the stream.
   *
   * Crash safety: a write-ahead intent for the object key is recorded before the first byte is uploaded
   * and removed in the transaction that records the row (or after the object is discarded), so a crash
   * in between leaves an intent the `file-orphans` sweeper uses to delete the unrecorded object. Uploads
   * that run longer than a quarter of the grace period refresh the intent as bytes flow.
   */
  async storeGenerated(ownerId: string, key: string, input: GeneratedFileInput): Promise<FileAsset> {
    const idempotencyKey = this.validateRequestKey(key);
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_GENERATED_FILE_BYTES)
      throw new RangeError('Invalid generated file limit');
    let fileName: string;
    try { fileName = sanitizeFileName(input.fileName); } catch { throw new BadRequestException('Invalid filename'); }
    const existing = await this.repository.findByRequest(ownerId, idempotencyKey);
    if (existing) {
      input.stream.destroy();
      if (existing.state === 'ready') return existing;
      // A pending row from an interrupted buffered upload: finish it from its stored object.
      const recovered = await this.assets.recover({ ownerId }, ownerId, existing.id);
      if (recovered.state === 'ready') return recovered;
      throw new FileAssetError(recovered.state === 'deleted' ? 'ASSET_DELETED' : 'ASSET_NOT_READY');
    }
    const id = randomUUID(), objectKey = `private-assets/${id}`;
    const hash = createHash('sha256');
    let size = 0, head = Buffer.alloc(0);
    const limit = input.maxBytes, intents = this.intents;
    const refreshMs = Math.max(1000, Math.floor(graceMilliseconds(this.options) / 4));
    try { await intents.open(ownerId, objectKey, 'generated'); }
    catch (error) { input.stream.destroy(); throw error; }
    let touchedAt = Date.now();
    const counted = Readable.from((async function* () {
      for await (const chunk of input.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > limit) throw new PayloadTooLargeException({ code: 'FILE_TOO_LARGE', message: 'Generated file exceeds the configured size limit' });
        hash.update(buffer);
        if (head.length < 16) head = Buffer.concat([head, buffer.subarray(0, 16 - head.length)]);
        // Awaited, so a sweeper that already reclaimed the key stops the upload instead of racing it.
        if (Date.now() - touchedAt >= refreshMs) {
          if (!await intents.touch(objectKey)) throw new FileObjectIntentLostError();
          touchedAt = Date.now();
        }
        yield buffer;
      }
    })());
    try {
      await this.manager.uploadStream(counted, objectKey, { contentType: 'application/octet-stream', acl: 'private' });
      if (size < 1) throw new FileAssetError('INVALID_ARGUMENT');
      const sha256 = hash.digest('hex');
      await this.verifyObject(objectKey, size, sha256);
      const asset = await this.repository.insertReady({ id, scope: ownerId, idempotencyKey, objectKey, fileName, sha256, size,
        mimeType: detectPrivateFileMime(head), createdAt: Date.now() }, objectKey);
      if (asset.id !== id) {
        // A concurrent attempt recorded this request first; keep its object, drop ours.
        await this.discardUnrecorded(objectKey);
        if (asset.state !== 'ready') throw new FileAssetError('ASSET_NOT_READY');
      }
      return asset;
    } catch (error) {
      input.stream.destroy();
      // Remove a partial or unrecorded object (a no-op when nothing was written).
      await this.discardUnrecorded(objectKey);
      if (error instanceof FileQuotaExceededError) throw quotaExceeded();
      if (error instanceof FileObjectIntentLostError) throw new FileAssetError('UPLOAD_UNVERIFIED');
      throw error;
    }
  }

  /** Deletes an object no row references, then its intent; a failed delete leaves the intent for the sweeper. */
  private async discardUnrecorded(objectKey: string): Promise<void> {
    if (!await this.discardObject(objectKey)) return;
    try { await this.intents.close(objectKey); }
    catch { this.logger.warn('generated_file_intent_close_failed'); }
  }

  /** Re-reads a just-written object as a stream and checks its size and SHA-256. */
  private async verifyObject(objectKey: string, size: number, sha256: string): Promise<void> {
    const object = await this.manager.download(objectKey);
    const hash = createHash('sha256');
    let read = 0;
    try {
      for await (const chunk of object.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        read += buffer.length;
        if (read > size) break;
        hash.update(buffer);
      }
    } finally { object.stream.destroy(); }
    if (read !== size || hash.digest('hex') !== sha256) throw new FileAssetError('UPLOAD_UNVERIFIED');
  }

  private async discardObject(objectKey: string): Promise<boolean> {
    try { await this.manager.delete(objectKey); return true; }
    catch { this.logger.warn('generated_file_cleanup_failed'); return false; }
  }

  /**
   * Reads a ready private file for an attachment response. Files within the HTTP object limit keep the
   * buffered, verified-before-release path; larger (server-generated) files are streamed with their size
   * checked up front and their SHA-256 checked at the end (a mismatch aborts the response).
   */
  async open(ownerId: string, id: string): Promise<PrivateFileRead> {
    const asset = await this.assets.inspect({ ownerId }, ownerId, id);
    if (asset.state === 'deleted') throw new FileAssetError('ASSET_DELETED');
    if (asset.state !== 'ready') throw new FileAssetError('ASSET_NOT_READY');
    if (asset.size <= this.options.maxObjectBytes) return this.read(ownerId, id);
    if (!Number.isSafeInteger(asset.size) || asset.size > MAX_GENERATED_FILE_BYTES) throw new FileAssetError('INVALID_ARGUMENT');
    let object: { stream: Readable; size: number };
    try { object = await this.manager.download(asset.objectKey); }
    catch { throw new FileAssetError('CONTENT_UNAVAILABLE'); }
    if (object.size !== asset.size) { object.stream.destroy(); throw new FileAssetError('CONTENT_UNAVAILABLE'); }
    const hash = createHash('sha256');
    let read = 0;
    // The latest chunk is held back until the next one arrives, and the final chunk is released only
    // after the size and SHA-256 match: a client never receives every declared byte of a bad object
    // (Content-Length is the stored size), so a mismatch always reads as a truncated, failed download.
    let held: Buffer | undefined;
    const verified = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        read += chunk.length;
        if (read > asset.size) return done(new FileAssetError('CONTENT_UNAVAILABLE'));
        hash.update(chunk);
        const previous = held;
        held = chunk;
        done(null, previous);
      },
      flush(done) {
        if (read !== asset.size || hash.digest('hex') !== asset.sha256) return done(new FileAssetError('CONTENT_UNAVAILABLE'));
        done(null, held);
      },
    });
    object.stream.on('error', error => verified.destroy(error));
    object.stream.pipe(verified);
    return { asset, stream: verified, size: asset.size };
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
