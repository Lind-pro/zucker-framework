import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { BufferedFileManagerStore, FILE_MANAGER, PublicAssetService } from '@zucker-framework/storage';
import type { FileManager, PublicAssetView, PublicImageNormalizer, RasterImageMime } from '@zucker-framework/storage';
import { ApplicationDatabase } from '../database';
import { DEFAULT_OWNER_MAX_BYTES, DEFAULT_OWNER_MAX_FILES, FILES_OPTIONS, type FilesOptions } from './files.config';
import { PostgresPublicAssetRepository } from './public-asset.repository';
import { PUBLIC_ASSET_MAX_DIMENSION, PUBLIC_ASSET_MAX_INPUT_PIXELS, PUBLIC_ASSET_ROUTE, PUBLIC_ASSETS_OPTIONS, type PublicAssetsOptions } from './public-assets.config';

const SHARP_FORMATS: Readonly<Record<RasterImageMime, string>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Full decode and re-encode with sharp. Output never carries the input's EXIF/XMP/ICC metadata
 * (sharp drops it unless asked to keep it); orientation is applied first. Only single-frame images
 * whose decoded format matches the sniffed magic bytes are accepted. GIF is stored as PNG.
 * Encoder options are fixed, so identical input yields identical output and the same content key.
 */
export const normalizePublicImage: PublicImageNormalizer = async (body, sniffed) => {
  const decoder = sharp(body, { limitInputPixels: PUBLIC_ASSET_MAX_INPUT_PIXELS, failOn: 'error', sequentialRead: true });
  const metadata = await decoder.metadata();
  if (metadata.format !== SHARP_FORMATS[sniffed] || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1)
    throw new Error('Unsupported image');
  const pipeline = decoder.rotate().resize(PUBLIC_ASSET_MAX_DIMENSION, PUBLIC_ASSET_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
  const mimeType: RasterImageMime = sniffed === 'image/gif' ? 'image/png' : sniffed;
  const encoded = mimeType === 'image/jpeg' ? pipeline.jpeg({ quality: 85, mozjpeg: true })
    : mimeType === 'image/webp' ? pipeline.webp({ quality: 85 })
      : pipeline.png({ compressionLevel: 9 });
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
  return { body: data, mimeType, width: info.width, height: info.height };
};

/**
 * Public raster images for CMS and site content (and other server features such as re-hosting
 * generated images). Quota is the private-file per-owner quota; see PostgresPublicAssetRepository.
 */
@Injectable()
export class PublicAssetsService {
  private readonly assets: PublicAssetService;
  constructor(@Inject(DATABASE_ADAPTER) database: ApplicationDatabase, @Inject(FILE_MANAGER) manager: FileManager,
    @Inject(FILES_OPTIONS) files: FilesOptions, @Inject(PUBLIC_ASSETS_OPTIONS) readonly options: PublicAssetsOptions) {
    const repository = new PostgresPublicAssetRepository(database,
      { maxBytes: files.maxOwnerBytes ?? DEFAULT_OWNER_MAX_BYTES, maxFiles: files.maxOwnerFiles ?? DEFAULT_OWNER_MAX_FILES });
    this.assets = new PublicAssetService({
      repository, objects: new BufferedFileManagerStore(manager, options.maxObjectBytes), normalize: normalizePublicImage,
      maxInputBytes: options.maxInputBytes, maxObjectBytes: options.maxObjectBytes,
      publicUrl: (objectKey, fileName) => options.baseUrl ? `${options.baseUrl}/${objectKey}` : `${PUBLIC_ASSET_ROUTE}/${fileName}`,
    });
  }
  /** Validate, re-encode and store an image owned by (and charged to) `ownerId`; identical content returns the stored URL. */
  upload(ownerId: string, body: Buffer): Promise<PublicAssetView> { return this.assets.upload(ownerId, body); }
  read(fileName: unknown) { return this.assets.read(fileName); }
}
