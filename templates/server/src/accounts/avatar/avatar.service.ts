import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../../database';
import { FilesService, type UploadedPrivateFile } from '../../files/files.service';
import { detectPrivateFileMime } from '../../files/files.config';

export const AVATAR_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export interface AvatarCommand { key: string; expectedRevision: number }
export interface AvatarSnapshot { assetId: string | null; revision: number; appliedRevision?: number }
interface AvatarUser { id: string; status: boolean; avatarFileId: string | null; avatarRevision: number }
interface AvatarReceipt { id: string; userId: string; idempotencyKey: string; action: 'UPLOAD' | 'REMOVE'; assetId: string | null; expectedRevision: number; appliedRevision: number }

export function avatarCommand(key: unknown, ifMatch: unknown): AvatarCommand {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable Idempotency-Key is required');
  const match = typeof ifMatch === 'string' ? /^"(0|[1-9][0-9]{0,9})"$/.exec(ifMatch) : null;
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647) throw new BadRequestException('If-Match must contain the current avatar revision');
  return { key, expectedRevision: revision };
}

@Injectable()
export class AccountAvatarService {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly files: FilesService) {}
  private async user(tx: ApplicationTransaction, userId: string, lock = false): Promise<AvatarUser> {
    const result = await tx.query<AvatarUser>(`SELECT id,status,"avatarFileId","avatarRevision" FROM users WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [userId]);
    if (!result.rows[0]?.status) throw new UnauthorizedException('Account is unavailable'); return result.rows[0];
  }
  private async present(tx: ApplicationTransaction, user: AvatarUser): Promise<AvatarSnapshot> {
    if (!user.avatarFileId) return { assetId: null, revision: user.avatarRevision };
    const asset = await tx.model('fileAssets').findUnique({ where: { id: user.avatarFileId }, select: { ownerId: true, state: true, mimeType: true } }) as { ownerId: string; state: string; mimeType: string } | null;
    return { assetId: asset?.ownerId === user.id && asset.state === 'ready' && asset.mimeType === 'image/png' ? user.avatarFileId : null, revision: user.avatarRevision };
  }
  metadata(userId: string): Promise<AvatarSnapshot> { return this.database.transaction(async tx => this.present(tx, await this.user(tx, userId))); }
  private async preflight(userId: string, command: AvatarCommand, action: AvatarReceipt['action']): Promise<void> {
    await this.database.transaction(async tx => {
      const user = await this.user(tx, userId), receipt = await this.receipt(tx, userId, command.key);
      if (receipt) { if (receipt.action !== action || receipt.expectedRevision !== command.expectedRevision) throw new ConflictException('Avatar request key was reused'); }
      else if (user.avatarRevision !== command.expectedRevision) throw new ConflictException('The avatar changed in another request');
    });
  }
  private async normalize(file?: UploadedPrivateFile): Promise<Buffer> {
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > AVATAR_MAX_INPUT_BYTES)
      throw new BadRequestException('One PNG or JPEG image no larger than 2 MiB is required');
    const bytes = Buffer.from(file.buffer), format = detectPrivateFileMime(bytes);
    if (format !== 'image/png' && format !== 'image/jpeg') throw new BadRequestException('Only PNG and JPEG images are supported');
    try {
      const decoder = sharp(bytes, { limitInputPixels: 16777216, failOn: 'warning' });
      const metadata = await decoder.metadata();
      if (!['png', 'jpeg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1
        || metadata.width * metadata.height > 16777216) throw new Error('Unsupported image');
      // Decode locally, apply orientation and discard metadata before private storage.
      return await decoder.rotate().resize(256, 256, { fit: 'cover', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    } catch { throw new BadRequestException('The image could not be decoded safely'); }
  }
  async upload(userId: string, command: AvatarCommand, file?: UploadedPrivateFile): Promise<AvatarSnapshot> {
    const request = { ...command };
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > AVATAR_MAX_INPUT_BYTES)
      throw new BadRequestException('One PNG or JPEG image no larger than 2 MiB is required');
    const snapshot = { originalname: 'avatar.png', buffer: Buffer.from(file.buffer) };
    await this.preflight(userId, request, 'UPLOAD');
    const body = await this.normalize(snapshot);
    const key = `avatar_${createHash('sha256').update(request.key).digest('hex')}`;
    const asset = await this.files.upload(userId, key, { originalname: 'avatar.png', buffer: body });
    return this.bind(userId, request, 'UPLOAD', asset.id);
  }
  async remove(userId: string, command: AvatarCommand): Promise<AvatarSnapshot> { return this.bind(userId, { ...command }, 'REMOVE', null); }
  private receipt(tx: ApplicationTransaction, userId: string, key: string) {
    return tx.model('accountAvatarChanges').findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } }) as Promise<AvatarReceipt | null>;
  }
  private bind(userId: string, command: AvatarCommand, action: AvatarReceipt['action'], assetId: string | null): Promise<AvatarSnapshot> {
    return this.database.transaction(async tx => {
      const user = await this.user(tx, userId, true), previous = await this.receipt(tx, userId, command.key);
      if (previous) {
        if (previous.action !== action || previous.assetId !== assetId || previous.expectedRevision !== command.expectedRevision)
          throw new ConflictException('Avatar request key was reused');
        return { ...await this.present(tx, user), appliedRevision: previous.appliedRevision };
      }
      if (user.avatarRevision !== command.expectedRevision) throw new ConflictException('The avatar changed in another request');
      if (assetId) {
        const valid = await tx.query<{ id: string }>(`SELECT id FROM file_assets WHERE id=$1 AND "ownerId"=$2 AND state='ready' AND "mimeType"='image/png' FOR SHARE`, [assetId, userId]);
        if (valid.rows.length !== 1) throw new ConflictException('Avatar file is unavailable');
      }
      const revision = user.avatarRevision + 1;
      const changed = await tx.model('users').updateMany({ where: { id: userId, status: true, avatarRevision: command.expectedRevision }, data: { avatarFileId: assetId, avatarRevision: revision } });
      if (changed.count !== 1) throw new ConflictException('The avatar changed in another request');
      await tx.model('accountAvatarChanges').create({ data: {
        id: `avatar_${createHash('sha256').update(JSON.stringify([userId, command.key])).digest('hex')}`,
        userId, idempotencyKey: command.key, action, assetId, expectedRevision: command.expectedRevision, appliedRevision: revision,
      } });
      return { ...await this.present(tx, { ...user, avatarFileId: assetId, avatarRevision: revision }), appliedRevision: revision };
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
