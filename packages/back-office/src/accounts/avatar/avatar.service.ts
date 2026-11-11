import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { requireSql, resolveAccountsOptions, table, type ResolvedAccountsOptions } from '../accounts.options';
import type { AccountAvatarStorage } from '../accounts.ports';
import { ACCOUNTS_AVATAR_STORAGE, ACCOUNTS_OPTIONS } from '../accounts.tokens';

export const AVATAR_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export interface AvatarCommand { key: string; expectedRevision: number }
export interface AvatarSnapshot { assetId: string | null; revision: number; appliedRevision?: number }
export interface UploadedAvatarFile { buffer: Buffer; originalname?: string; mimetype?: string; size?: number }
interface AvatarUser { id: string; status: boolean; avatarFileId: string | null; avatarRevision: number }
interface AvatarReceipt { id: string; userId: string; idempotencyKey: string; action: 'UPLOAD' | 'REMOVE'; assetId: string | null; expectedRevision: number; appliedRevision: number }

/** `Idempotency-Key` (16–128 url-safe characters) and `If-Match: "<revision>"` of an avatar change. */
export function avatarCommand(key: unknown, ifMatch: unknown): AvatarCommand {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable Idempotency-Key is required');
  const match = typeof ifMatch === 'string' ? /^"(0|[1-9][0-9]{0,9})"$/.exec(ifMatch) : null;
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647) throw new BadRequestException('If-Match must contain the current avatar revision');
  return { key, expectedRevision: revision };
}

/**
 * Account avatar (`users.avatarFileId` / `avatarRevision`): uploads are decoded and re-encoded by the
 * storage port, stored as private files, and bound with optimistic revisions plus an idempotency
 * receipt (`accountAvatarChanges`), so retries are safe and concurrent changes conflict (409).
 */
@Injectable()
export class AccountAvatarService {
  private readonly options: ResolvedAccountsOptions;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter,
    @Inject(ACCOUNTS_AVATAR_STORAGE) private readonly files: AccountAvatarStorage,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.options = options ?? resolveAccountsOptions({ features: { avatar: true } });
  }
  private assets(db: DatabaseAdapter = this.database) { return db.model(this.options.models.fileAssets); }
  private async user(tx: DatabaseAdapter, userId: string, lock = false): Promise<AvatarUser> {
    const result = await requireSql(this.options, tx, 'Avatars').query<AvatarUser>(
      `SELECT id,status,"avatarFileId","avatarRevision" FROM ${table(this.options, 'users')} WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [userId]);
    if (!result.rows[0]?.status) throw new UnauthorizedException('Account is unavailable'); return result.rows[0];
  }
  private async present(tx: DatabaseAdapter, user: AvatarUser): Promise<AvatarSnapshot> {
    if (!user.avatarFileId) return { assetId: null, revision: user.avatarRevision };
    const asset = await this.assets(tx).findUnique({ where: { id: user.avatarFileId }, select: { ownerId: true, state: true, mimeType: true } }) as { ownerId: string; state: string; mimeType: string } | null;
    return { assetId: asset?.ownerId === user.id && asset.state === 'ready' && asset.mimeType === 'image/png' ? user.avatarFileId : null, revision: user.avatarRevision };
  }
  metadata(userId: string): Promise<AvatarSnapshot> { return this.database.$transaction(async tx => this.present(tx, await this.user(tx, userId))); }
  private async preflight(userId: string, command: AvatarCommand, action: AvatarReceipt['action']): Promise<AvatarReceipt | null> {
    return this.database.$transaction(async tx => {
      const user = await this.user(tx, userId), receipt = await this.receipt(tx, userId, command.key);
      if (receipt) { if (receipt.action !== action || receipt.expectedRevision !== command.expectedRevision) throw new ConflictException('Avatar request key was reused'); }
      else if (user.avatarRevision !== command.expectedRevision) throw new ConflictException('The avatar changed in another request');
      return receipt;
    });
  }
  async upload(userId: string, command: AvatarCommand, file?: UploadedAvatarFile): Promise<AvatarSnapshot> {
    const request = { ...command };
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > AVATAR_MAX_INPUT_BYTES)
      throw new BadRequestException('One PNG or JPEG image no larger than 2 MiB is required');
    const snapshot = Buffer.from(file.buffer);
    const receipt = await this.preflight(userId, request, 'UPLOAD');
    const body = await this.files.normalize(snapshot);
    if (receipt?.assetId) {
      // A replay of an applied upload: its image may already have been superseded and deleted, so match
      // the request against the stored digest instead of re-uploading under the old key.
      const stored = await this.assets().findUnique({ where: { id: receipt.assetId }, select: { ownerId: true, sha256: true } }) as { ownerId: string; sha256: string } | null;
      if (!stored || stored.ownerId !== userId || stored.sha256 !== createHash('sha256').update(body).digest('hex'))
        throw new ConflictException('Avatar request key was reused');
      return (await this.bind(userId, request, 'UPLOAD', receipt.assetId)).snapshot;
    }
    const key = `avatar_${createHash('sha256').update(request.key).digest('hex')}`;
    const asset = await this.files.upload(userId, key, { originalname: 'avatar.png', buffer: body });
    return this.release(userId, await this.bind(userId, request, 'UPLOAD', asset.id));
  }
  /** Removing the avatar deliberately keeps the image among the owner's files. */
  async remove(userId: string, command: AvatarCommand): Promise<AvatarSnapshot> { return (await this.bind(userId, { ...command }, 'REMOVE', null)).snapshot; }
  /**
   * Best effort: start deletion of the avatar-owned asset that a new upload replaced, so replaced avatars do
   * not accumulate in private storage. Files the user uploaded elsewhere are never touched.
   */
  private async release(userId: string, result: { snapshot: AvatarSnapshot; superseded: string | null }): Promise<AvatarSnapshot> {
    if (result.superseded) {
      try {
        const rows = await this.assets().findMany({ where: { id: result.superseded, ownerId: userId,
          idempotencyKey: { startsWith: 'avatar_' }, state: { not: 'deleted' } }, select: { id: true }, take: 1 }) as Array<{ id: string }>;
        if (rows[0]) await this.files.delete(userId, rows[0].id);
      } catch { /* the asset stays listed under the owner's files and can be deleted there */ }
    }
    return result.snapshot;
  }
  private receipt(tx: DatabaseAdapter, userId: string, key: string) {
    return tx.model(this.options.models.accountAvatarChanges).findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } }) as Promise<AvatarReceipt | null>;
  }
  private bind(userId: string, command: AvatarCommand, action: AvatarReceipt['action'], assetId: string | null): Promise<{ snapshot: AvatarSnapshot; superseded: string | null }> {
    return this.database.$transaction(async tx => {
      const user = await this.user(tx, userId, true), previous = await this.receipt(tx, userId, command.key);
      if (previous) {
        if (previous.action !== action || previous.assetId !== assetId || previous.expectedRevision !== command.expectedRevision)
          throw new ConflictException('Avatar request key was reused');
        return { snapshot: { ...await this.present(tx, user), appliedRevision: previous.appliedRevision }, superseded: null };
      }
      if (user.avatarRevision !== command.expectedRevision) throw new ConflictException('The avatar changed in another request');
      if (assetId) {
        const valid = await requireSql(this.options, tx, 'Avatars').query<{ id: string }>(
          `SELECT id FROM ${table(this.options, 'fileAssets')} WHERE id=$1 AND "ownerId"=$2 AND state='ready' AND "mimeType"='image/png' FOR SHARE`, [assetId, userId]);
        if (valid.rows.length !== 1) throw new ConflictException('Avatar file is unavailable');
      }
      const revision = user.avatarRevision + 1;
      const changed = await tx.model(this.options.models.users).updateMany({ where: { id: userId, status: true, avatarRevision: command.expectedRevision }, data: { avatarFileId: assetId, avatarRevision: revision } });
      if (changed.count !== 1) throw new ConflictException('The avatar changed in another request');
      await tx.model(this.options.models.accountAvatarChanges).create({ data: {
        id: `avatar_${createHash('sha256').update(JSON.stringify([userId, command.key])).digest('hex')}`,
        userId, idempotencyKey: command.key, action, assetId, expectedRevision: command.expectedRevision, appliedRevision: revision,
      } });
      return { snapshot: { ...await this.present(tx, { ...user, avatarFileId: assetId, avatarRevision: revision }), appliedRevision: revision },
        superseded: user.avatarFileId && user.avatarFileId !== assetId ? user.avatarFileId : null };
    });
  }
  async content(userId: string, revision: number): Promise<Buffer> {
    const initial = await this.metadata(userId);
    if (initial.revision !== revision) throw new ConflictException('The avatar changed in another request');
    if (!initial.assetId) throw new NotFoundException('No avatar is set');
    const file = await this.files.read(userId, initial.assetId);
    const current = await this.metadata(userId);
    if (current.revision !== revision || current.assetId !== initial.assetId) throw new ConflictException('The avatar changed while loading');
    return file.body;
  }
}
