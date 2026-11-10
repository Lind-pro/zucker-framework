import { PublicAssetError, type PublicAssetCandidate, type PublicAssetRecord, type PublicAssetRepository, type RasterImageMime } from '@zucker-framework/storage';
import type { ApplicationDatabase } from '../database';
import { lockOwnerQuota, ownerStorageUsage, PostgresFileAssetRepository, type FileOwnerQuota } from './file-asset.repository';

interface PublicAssetRow {
  sha256: string; ownerId: string; objectKey: string; size: number; mimeType: RasterImageMime;
  width: number; height: number; state: 'pending' | 'ready'; createdAt: Date;
}
const COLUMNS = '"sha256","ownerId","objectKey","size","mimeType","width","height","state","createdAt"';
function fromRow(row: PublicAssetRow): PublicAssetRecord {
  return { ...row, createdAt: row.createdAt.getTime() };
}

/**
 * PostgreSQL metadata for public assets. Uniqueness on sha256 makes concurrent identical uploads
 * converge on one row; the per-owner quota is shared with private files (same advisory lock, same
 * usage sum) and charged only when a new row is inserted.
 */
export class PostgresPublicAssetRepository implements PublicAssetRepository {
  constructor(private readonly database: ApplicationDatabase, private readonly quota: FileOwnerQuota) {}

  reserve(candidate: PublicAssetCandidate): Promise<{ asset: PublicAssetRecord; created: boolean }> {
    return this.database.transaction(async tx => {
      const existing = await tx.query<PublicAssetRow>(`SELECT ${COLUMNS} FROM public_assets WHERE sha256=$1`, [candidate.sha256]);
      if (existing.rows[0]) return { asset: fromRow(existing.rows[0]), created: false };
      await lockOwnerQuota(tx, candidate.ownerId);
      if (PostgresFileAssetRepository.exceeds(this.quota, await ownerStorageUsage(this.database, candidate.ownerId, tx), candidate.size))
        throw new PublicAssetError('QUOTA_EXCEEDED');
      // A concurrent insert of the same hash (any owner) waits on the unique index, then does nothing.
      const inserted = await tx.query<PublicAssetRow>(`
        INSERT INTO public_assets ("sha256","ownerId","objectKey","size","mimeType","width","height","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT ("sha256") DO NOTHING RETURNING ${COLUMNS}`,
      [candidate.sha256, candidate.ownerId, candidate.objectKey, candidate.size, candidate.mimeType, candidate.width, candidate.height, new Date(candidate.createdAt)]);
      if (inserted.rows[0]) return { asset: fromRow(inserted.rows[0]), created: true };
      const winner = await tx.query<PublicAssetRow>(`SELECT ${COLUMNS} FROM public_assets WHERE sha256=$1`, [candidate.sha256]);
      if (!winner.rows[0]) throw new Error('Reserved public asset disappeared');
      return { asset: fromRow(winner.rows[0]), created: false };
    });
  }

  markReady(sha256: string): Promise<PublicAssetRecord> {
    return this.database.transaction(async tx => {
      await tx.query(`UPDATE public_assets SET state='ready',"updatedAt"=$2 WHERE sha256=$1 AND state='pending'`, [sha256, new Date()]);
      const row = await tx.query<PublicAssetRow>(`SELECT ${COLUMNS} FROM public_assets WHERE sha256=$1`, [sha256]);
      if (row.rows[0]?.state !== 'ready') throw new Error('Public asset could not be marked ready');
      return fromRow(row.rows[0]);
    });
  }

  async get(sha256: string): Promise<PublicAssetRecord | null> {
    const rows = await this.database.transaction(tx => tx.query<PublicAssetRow>(`SELECT ${COLUMNS} FROM public_assets WHERE sha256=$1`, [sha256]));
    return rows.rows[0] ? fromRow(rows.rows[0]) : null;
  }
}
