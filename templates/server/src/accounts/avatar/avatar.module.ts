import { HttpException, Injectable, Module, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import sharp from 'sharp';
import { FileAssetError, StorageTransferError } from '@zucker-framework/storage';
import {
  ACCOUNTS_AVATAR_STORAGE, ACCOUNTS_AVATAR_UPLOAD, AccountAvatarController, AccountAvatarService, AccountAvatarUploadInterceptor, AVATAR_MAX_INPUT_BYTES,
  type AccountAvatarStorage,
} from '@zucker-framework/back-office/accounts';
import { FilesModule } from '../../files/files.module';
import { FilesService } from '../../files/files.service';
import { detectPrivateFileMime } from '../../files/files.config';
import { AccountModule } from '../account.module';

/** Avatars as private files of the owner; decoded locally by Sharp (orientation applied, metadata stripped). */
@Injectable()
export class FilesAvatarStorage implements AccountAvatarStorage {
  constructor(private readonly files: FilesService) {}
  upload(ownerId: string, key: string, file: { originalname: string; buffer: Buffer }) { return this.files.upload(ownerId, key, file); }
  read(ownerId: string, assetId: string) { return this.files.read(ownerId, assetId); }
  delete(ownerId: string, assetId: string) { return this.files.delete(ownerId, assetId); }
  async normalize(bytes: Buffer): Promise<Buffer> {
    const format = detectPrivateFileMime(bytes);
    if (format !== 'image/png' && format !== 'image/jpeg') throw new BadRequestException('Only PNG and JPEG images are supported');
    try {
      const decoder = sharp(bytes, { limitInputPixels: 16777216, failOn: 'warning' });
      const metadata = await decoder.metadata();
      if (!['png', 'jpeg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1
        || metadata.width * metadata.height > 16777216) throw new Error('Unsupported image');
      return await decoder.rotate().resize(256, 256, { fit: 'cover', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    } catch { throw new BadRequestException('The image could not be decoded safely'); }
  }
  mapError(error: unknown): HttpException | undefined {
    if (error instanceof FileAssetError && ['IDEMPOTENCY_CONFLICT', 'ASSET_DELETED', 'CONCURRENT_CHANGE'].includes(error.code))
      return new HttpException('Avatar request conflicts with an existing file', 409);
    if (error instanceof StorageTransferError && error.code === 'OBJECT_SIZE_OUT_OF_BOUNDS') return new HttpException('Avatar file exceeds the configured size limit', 413);
    return undefined;
  }
}

/** Optional root consumer: standalone account authentication does not require storage or image decoding. */
@Module({
  imports: [FilesModule, AccountModule],
  controllers: [AccountAvatarController],
  providers: [AccountAvatarService, AccountAvatarUploadInterceptor, { provide: ACCOUNTS_AVATAR_STORAGE, useClass: FilesAvatarStorage },
    { provide: ACCOUNTS_AVATAR_UPLOAD, useClass: FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_INPUT_BYTES, files: 1, fields: 0, parts: 2 } }) }],
  exports: [AccountAvatarService],
})
export class AccountAvatarModule {}
