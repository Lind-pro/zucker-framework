import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { FileAsset, FileAssetMutation, FileAssetRepository, FileAssetReservation } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../database';

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
export class PostgresFileAssetRepository implements FileAssetRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  reserve(input: FileAssetReservation): Promise<FileAsset> {
    return this.database.transaction(async tx => {
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
