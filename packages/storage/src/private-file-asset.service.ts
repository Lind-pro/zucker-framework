import { createHash, randomUUID } from 'node:crypto';
import { sanitizeFileName } from './storage.interface';
import { StorageTransferError, transferVerifiedObject, verifyStoredObject } from './verified-object-transfer';
import {
  FileAssetError,
  type FileAsset,
  type FileAssetAction,
  type FileAssetMutation,
  type FileAssetReservation,
  type PrivateFileAssetOptions,
} from './file-asset';

/** Durable metadata orchestration over the existing private, verified object IO. */
export class PrivateFileAssetService<TContext> {
  private readonly now: () => number;

  constructor(private readonly options: PrivateFileAssetOptions<TContext>) {
    if (!Number.isSafeInteger(options.maxObjectBytes) || options.maxObjectBytes < 1)
      throw new RangeError('maxObjectBytes must be a positive integer');
    this.now = options.now ?? Date.now;
  }

  async upload(context: TContext, input: {
    scope: string; idempotencyKey: string; fileName: string; body: Buffer;
  }): Promise<FileAsset> {
    const { scope, idempotencyKey, fileName: requestedFileName, body: requestedBody } = input;
    this.text(scope);
    this.text(idempotencyKey);
    this.text(requestedFileName);
    if (!Buffer.isBuffer(requestedBody) || requestedBody.length < 1 || requestedBody.length > this.options.maxObjectBytes)
      throw new FileAssetError('INVALID_ARGUMENT');
    // Snapshot every request field before awaiting policy: authorization and persistence
    // must use the same scope/key as validation, even if the caller mutates its input.
    const body = Buffer.from(requestedBody);
    const fileName = sanitizeFileName(requestedFileName);
    const mimeType = this.options.detectMimeType(body);
    this.text(mimeType);
    await this.authorize(context, scope, 'upload');
    const id = randomUUID();
    const candidate: FileAssetReservation = {
      id, scope, idempotencyKey,
      objectKey: `private-assets/${id}`, fileName,
      sha256: createHash('sha256').update(body).digest('hex'), size: body.length, mimeType,
      createdAt: this.now(),
    };
    const asset = await this.metadata(() => this.options.repository.reserve(candidate));
    this.assertSameRequest(asset, candidate);
    if (asset.state === 'deleted') throw new FileAssetError('ASSET_DELETED');
    try {
      await transferVerifiedObject({
        source: { body, reportedSize: body.length }, target: this.options.objects,
        destinationKey: asset.objectKey, mode: 'apply', allowUpload: true,
        detectMimeType: this.options.detectMimeType,
      });
    } catch (error) {
      // The durable reservation remains pending if upload/response/verification is uncertain.
      if (error instanceof StorageTransferError) throw error;
      throw new FileAssetError('UPLOAD_UNVERIFIED');
    }
    return this.makeReady(asset);
  }

  /** Authorized metadata inspection; pending/deleted metadata never grants file access. */
  async inspect(context: TContext, scope: string, id: string): Promise<FileAsset> {
    await this.authorize(context, scope, 'inspect', id);
    return this.find(scope, id);
  }

  /** Bounded, verified private read. No public/signed URLs are stored or returned. */
  async read(context: TContext, scope: string, id: string): Promise<{ asset: FileAsset; body: Buffer }> {
    await this.authorize(context, scope, 'read', id);
    const asset = await this.find(scope, id);
    if (asset.state === 'deleted') throw new FileAssetError('ASSET_DELETED');
    if (asset.state !== 'ready') throw new FileAssetError('ASSET_NOT_READY');
    const body = await this.readVerified(asset);
    // Only a still-ready record can release bytes after the object read.
    const current = await this.find(scope, id);
    if (current.state === 'deleted') throw new FileAssetError('ASSET_DELETED');
    if (current.state !== 'ready') throw new FileAssetError('ASSET_NOT_READY');
    return { asset: current, body };
  }

  /**
   * Resume metadata commit after an interrupted upload, without writing new bytes.
   * Missing pending data remains pending. Tombstones retry object cleanup instead.
   * Consumers schedule this through their durable task/outbox, using trusted context.
   */
  async recover(context: TContext, scope: string, id: string): Promise<FileAsset> {
    await this.authorize(context, scope, 'recover', id);
    const asset = await this.find(scope, id);
    if (asset.state === 'deleted') return this.cleanup(asset);
    let exists: boolean;
    try { exists = await this.options.objects.exists(asset.objectKey); }
    catch { throw new FileAssetError('CONTENT_UNAVAILABLE'); }
    if (!exists) {
      if (asset.state === 'ready') throw new FileAssetError('CONTENT_UNAVAILABLE');
      return this.find(scope, id);
    }
    await this.readVerified(asset);
    return this.makeReady(asset);
  }

  /** Logical deletion is durable before object IO. Cleanup failure leaves a retryable tombstone. */
  async delete(context: TContext, scope: string, id: string): Promise<FileAsset> {
    await this.authorize(context, scope, 'delete', id);
    return this.cleanup(await this.find(scope, id));
  }

  private async authorize(context: TContext, scope: string, action: FileAssetAction, assetId?: string): Promise<void> {
    this.text(scope);
    if (assetId !== undefined) this.text(assetId);
    if (!await this.options.authorize(context, { scope, action, assetId })) throw new FileAssetError('FORBIDDEN');
  }

  private text(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))
      throw new FileAssetError('INVALID_ARGUMENT');
  }

  private async metadata<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new FileAssetError('METADATA_UNAVAILABLE'); }
  }

  private async find(scope: string, id: string): Promise<FileAsset> {
    const asset = await this.metadata(() => this.options.repository.get(scope, id));
    if (!asset || asset.scope !== scope || asset.id !== id) throw new FileAssetError('NOT_FOUND');
    return asset;
  }

  private assertSameRequest(asset: FileAsset, expected: FileAssetReservation): void {
    if (asset.scope !== expected.scope || asset.idempotencyKey !== expected.idempotencyKey)
      throw new FileAssetError('METADATA_UNAVAILABLE');
    if (asset.sha256 !== expected.sha256 || asset.size !== expected.size
      || asset.mimeType !== expected.mimeType || asset.fileName !== expected.fileName)
      throw new FileAssetError('IDEMPOTENCY_CONFLICT');
  }

  private async readVerified(asset: FileAsset): Promise<Buffer> {
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > this.options.maxObjectBytes)
      throw new FileAssetError('INVALID_ARGUMENT');
    try {
      const object = await this.options.objects.read(asset.objectKey);
      verifyStoredObject(object, asset, this.options.detectMimeType);
      return object.body;
    } catch (error) {
      if (error instanceof StorageTransferError) throw error;
      throw new FileAssetError('CONTENT_UNAVAILABLE');
    }
  }

  private async makeReady(asset: FileAsset): Promise<FileAsset> {
    const ready = await this.metadata(() => this.options.repository.compareAndSwap(asset.scope, asset.id, asset.revision, {
      state: 'ready', updatedAt: this.now(), deletedAt: null, cleanupStatus: null, cleanupConfirmedAt: null,
    }));
    if (ready) return ready;
    const current = await this.find(asset.scope, asset.id);
    if (current.state === 'ready') return current;
    if (current.state === 'deleted') {
      // A late write never resurrects metadata; retry cleanup of its permanently retained key.
      await this.cleanup(current);
      throw new FileAssetError('ASSET_DELETED');
    }
    throw new FileAssetError('CONCURRENT_CHANGE');
  }

  private async cleanup(initial: FileAsset): Promise<FileAsset> {
    let asset = initial;
    let tombstone: FileAsset | null = null;
    // Bounded CAS contention. No provider operation runs before the durable tombstone.
    for (let attempt = 0; attempt < 4 && !tombstone; attempt++) {
      const update: FileAssetMutation = {
        state: 'deleted', updatedAt: this.now(), deletedAt: asset.deletedAt ?? this.now(),
        cleanupStatus: 'pending', cleanupConfirmedAt: null,
      };
      tombstone = await this.metadata(() => this.options.repository.compareAndSwap(asset.scope, asset.id, asset.revision, update));
      if (!tombstone) asset = await this.find(asset.scope, asset.id);
    }
    if (!tombstone) throw new FileAssetError('CONCURRENT_CHANGE');
    try {
      await this.options.objects.delete(tombstone.objectKey);
      if (await this.options.objects.exists(tombstone.objectKey)) throw new FileAssetError('DELETE_UNVERIFIED');
    } catch { throw new FileAssetError('DELETE_UNVERIFIED'); }
    const confirmedAt = this.now();
    const confirmed = await this.metadata(() => this.options.repository.compareAndSwap(tombstone.scope, tombstone.id, tombstone.revision, {
      state: 'deleted', updatedAt: confirmedAt, deletedAt: tombstone.deletedAt,
      cleanupStatus: 'confirmed', cleanupConfirmedAt: confirmedAt,
    }));
    // A concurrent cleanup may still be pending. Report that persisted state honestly.
    return confirmed ?? this.find(tombstone.scope, tombstone.id);
  }
}
