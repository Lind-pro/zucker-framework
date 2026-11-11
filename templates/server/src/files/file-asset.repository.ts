import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { FileAsset, FileAssetMutation, FileAssetRepository, FileAssetReservation } from '@zucker-framework/storage';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { FileObjectIntents } from './file-object-intents';

interface FileAssetRow extends Omit<FileAsset, 'scope' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'cleanupConfirmedAt'> {
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  cleanupConfirmedAt: Date | null;
}
function fromRow(row: FileAssetRow): FileAsset {
  const { ownerId, createdAt, updatedAt, deletedAt, cleanupConfirmedAt, ...asset } = row;
  return { ...asset, scope: ownerId, createdAt: createdAt.getTime(), updatedAt: updatedAt.getTime(),
    deletedAt: deletedAt?.getTime() ?? null, cleanupConfirmedAt: cleanupConfirmedAt?.getTime() ?? null };
}

/** Real PostgreSQL uniqueness/CAS; all object bytes remain outside this metadata table. */
/** Raised inside `reserve`; the storage service reports it generically, so FilesService re-checks usage. */
export class FileQuotaExceededError extends Error {
  constructor() { super('Private file storage quota exceeded'); this.name = 'FileQuotaExceededError'; }
}
export interface FileOwnerQuota { maxBytes: number; maxFiles: number }
export interface FileOwnerUsage { bytes: number; files: number }

/**
 * One owner's storage usage under the shared per-owner limits: live private files plus the public
 * assets that owner was charged for (first uploader of the content). Callers that enforce the quota
 * hold `lockOwnerQuota` in the same transaction.
 */
export async function ownerStorageUsage(database: ApplicationDatabase, ownerId: string, tx?: ApplicationTransaction): Promise<FileOwnerUsage> {
  if (!tx) return database.transaction(inner => ownerStorageUsage(database, ownerId, inner));
  const result = await tx.query<{ bytes: string | null; files: string }>(`
    SELECT (COALESCE((SELECT SUM(size) FROM file_assets WHERE "ownerId"=$1 AND state<>'deleted'),0)
      + COALESCE((SELECT SUM(size) FROM public_assets WHERE "ownerId"=$1),0))::text AS bytes,
      ((SELECT COUNT(*) FROM file_assets WHERE "ownerId"=$1 AND state<>'deleted')
      + (SELECT COUNT(*) FROM public_assets WHERE "ownerId"=$1))::text AS files`, [ownerId]);
  return { bytes: Number(result.rows[0]?.bytes ?? 0), files: Number(result.rows[0]?.files ?? 0) };
}

/** Serializes quota-checked reservations of one owner (private files and public assets share it). */
export async function lockOwnerQuota(tx: ApplicationTransaction, ownerId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':file-quota:' || $1, 0))::text AS locked", [ownerId]);
}

export class PostgresFileAssetRepository implements FileAssetRepository {
  constructor(private readonly database: ApplicationDatabase, private readonly quota?: FileOwnerQuota) {}

  /** Live (non-deleted) bytes and file count of one owner. */
  async usage(ownerId: string, tx?: ApplicationTransaction): Promise<FileOwnerUsage> {
    return ownerStorageUsage(this.database, ownerId, tx);
  }

  static exceeds(quota: FileOwnerQuota, usage: FileOwnerUsage, size: number): boolean {
    return usage.files + 1 > quota.maxFiles || usage.bytes + size > quota.maxBytes;
  }

  reserve(input: FileAssetReservation): Promise<FileAsset> {
    return this.database.transaction(async tx => {
      if (this.quota) {
        // Replays of an existing request key are never refused. New reservations of one owner are serialized
        // by a dedicated advisory lock (not the users row, which avatar binding and deletion lock) so
        // concurrent uploads cannot overshoot; deletions only lower usage and need no coordination.
        await lockOwnerQuota(tx, input.scope);
        const replay = await tx.query<FileAssetRow>('SELECT * FROM file_assets WHERE "ownerId"=$1 AND "idempotencyKey"=$2', [input.scope, input.idempotencyKey]);
        if (replay.rows[0]) return fromRow(replay.rows[0]);
        if (PostgresFileAssetRepository.exceeds(this.quota, await this.usage(input.scope, tx), input.size)) throw new FileQuotaExceededError();
      }
      const inserted = await tx.query<FileAssetRow>(`
        INSERT INTO file_assets ("id", "ownerId", "idempotencyKey", "objectKey", "fileName", "sha256", "size", "mimeType", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        ON CONFLICT ("ownerId", "idempotencyKey") DO NOTHING RETURNING *
      `, [input.id, input.scope, input.idempotencyKey, input.objectKey, input.fileName, input.sha256,
        input.size, input.mimeType, new Date(input.createdAt)]);
      if (inserted.rows[0]) return fromRow(inserted.rows[0]);
      const existing = await tx.query<FileAssetRow>(
        'SELECT * FROM file_assets WHERE "ownerId"=$1 AND "idempotencyKey"=$2', [input.scope, input.idempotencyKey]);
      if (!existing.rows[0]) throw new Error('Reserved file metadata disappeared');
      return fromRow(existing.rows[0]);
    });
  }

  /** The row bound to one owner request key, if any (any state). */
  async findByRequest(scope: string, idempotencyKey: string): Promise<FileAsset | null> {
    const rows = await this.database.transaction(tx => tx.query<FileAssetRow>(
      'SELECT * FROM file_assets WHERE "ownerId"=$1 AND "idempotencyKey"=$2', [scope, idempotencyKey]));
    return rows.rows[0] ? fromRow(rows.rows[0]) : null;
  }

  /**
   * Records an object that was already streamed and verified (server-generated content such as AI
   * outputs) directly as `ready`. Quota is checked with the actual size under the same owner advisory
   * lock as `reserve`, so concurrent uploads/outputs cannot overshoot. An existing row for the request
   * key is returned unchanged (the caller then discards its own object).
   */
  /**
   * Records a server-written object as a ready file. With `intentKey`, the object's write-ahead intent
   * is locked first (failing when the orphan sweeper already reclaimed it) and removed with the insert;
   * on a replay the intent is kept, because the caller still has to delete its own unrecorded object.
   */
  insertReady(input: FileAssetReservation, intentKey?: string): Promise<FileAsset> {
    return this.database.transaction(async tx => {
      if (intentKey !== undefined) await FileObjectIntents.lock(tx, intentKey);
      await lockOwnerQuota(tx, input.scope);
      const replay = await tx.query<FileAssetRow>('SELECT * FROM file_assets WHERE "ownerId"=$1 AND "idempotencyKey"=$2', [input.scope, input.idempotencyKey]);
      if (replay.rows[0]) return fromRow(replay.rows[0]);
      if (this.quota && PostgresFileAssetRepository.exceeds(this.quota, await this.usage(input.scope, tx), input.size)) throw new FileQuotaExceededError();
      const inserted = await tx.query<FileAssetRow>(`
        INSERT INTO file_assets ("id", "ownerId", "idempotencyKey", "objectKey", "fileName", "sha256", "size", "mimeType", "state", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$9) RETURNING *
      `, [input.id, input.scope, input.idempotencyKey, input.objectKey, input.fileName, input.sha256, input.size, input.mimeType, new Date(input.createdAt)]);
      if (intentKey !== undefined) await FileObjectIntents.settle(tx, intentKey);
      return fromRow(inserted.rows[0]);
    });
  }

  async get(scope: string, id: string): Promise<FileAsset | null> {
    const rows = await this.database.model('fileAssets').findMany({ where: { id, ownerId: scope }, take: 1 }) as FileAssetRow[];
    return rows[0] ? fromRow(rows[0]) : null;
  }

  /** Serialize with avatar binding: owner row first, then asset. No object IO runs under these locks. */
  beginDeletion(scope: string, id: string): Promise<FileAsset> {
    return this.database.transaction(async tx => {
      const users = await tx.query<{ status: boolean; avatarFileId: string | null }>('SELECT status,"avatarFileId" FROM users WHERE id=$1 FOR UPDATE', [scope]);
      if (!users.rows[0]?.status) throw new UnauthorizedException('Account is unavailable');
      const assets = await tx.query<FileAssetRow>('SELECT * FROM file_assets WHERE id=$1 AND "ownerId"=$2 FOR UPDATE', [id, scope]);
      const asset = assets.rows[0]; if (!asset) throw new NotFoundException();
      if (users.rows[0].avatarFileId === id) throw new ConflictException({ code: 'ASSET_IN_USE', message: 'Remove the current avatar before deleting this file' });
      if (asset.state === 'deleted') return fromRow(asset);
      const result = await tx.query<FileAssetRow>(`UPDATE file_assets SET state='deleted',revision=revision+1,"updatedAt"=$3,"deletedAt"=COALESCE("deletedAt",$3),
        "cleanupStatus"='pending',"cleanupConfirmedAt"=NULL WHERE id=$1 AND "ownerId"=$2 RETURNING *`, [id, scope, new Date()]);
      return fromRow(result.rows[0]);
    });
  }

  compareAndSwap(scope: string, id: string, revision: number, update: FileAssetMutation): Promise<FileAsset | null> {
    return this.database.transaction(async tx => {
      const changed = await tx.model('fileAssets').updateMany({ where: { id, ownerId: scope, revision }, data: {
        state: update.state, revision: { increment: 1 }, updatedAt: new Date(update.updatedAt),
        deletedAt: update.deletedAt === null ? null : new Date(update.deletedAt), cleanupStatus: update.cleanupStatus,
        cleanupConfirmedAt: update.cleanupConfirmedAt === null ? null : new Date(update.cleanupConfirmedAt),
      } });
      if (changed.count !== 1) return null;
      const row = await tx.model('fileAssets').findUnique({ where: { id } }) as FileAssetRow | null;
      if (!row) throw new Error('Updated file metadata disappeared');
      return fromRow(row);
    });
  }
}
