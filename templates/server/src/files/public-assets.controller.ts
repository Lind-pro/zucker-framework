import { Controller, ForbiddenException, Get, HttpCode, HttpException, Param, Post, Req, Res, ServiceUnavailableException, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Permissions, Public } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, type LimiterConfig } from '@zucker-framework/rate-limiter';
import { PublicAssetError, publicAssetFileName, type PublicAssetErrorCode } from '@zucker-framework/storage';
import { MAX_FILE_BYTES } from './files.config';
import { PublicAssetsService } from './public-assets.service';
import type { UploadedPrivateFile } from './files.service';

export const PUBLIC_ASSET_UPLOAD_LIMITER = 'public-asset-upload';
export const PUBLIC_ASSET_READ_LIMITER = 'public-asset-read';
/** Limiter fragment for `composeRateLimiters` in the application module. */
export const PUBLIC_ASSET_RATE_LIMITERS: Readonly<Record<string, LimiterConfig>> = Object.freeze({
  [PUBLIC_ASSET_UPLOAD_LIMITER]: { points: 30, duration: 60 }, // uploads per staff user per minute
  [PUBLIC_ASSET_READ_LIMITER]: { points: 600, duration: 60 }, // uncached reads per client IP per minute
});

const STATUSES: Readonly<Record<PublicAssetErrorCode, [number, string]>> = {
  INVALID_ARGUMENT: [400, 'One image file is required'],
  UNSUPPORTED_TYPE: [415, 'Only PNG, JPEG, WebP and GIF images are accepted'],
  SVG_REJECTED: [415, 'SVG images are not accepted; upload a PNG, JPEG or WebP image'],
  TOO_LARGE: [413, 'The image exceeds the configured size limit'],
  INVALID_IMAGE: [422, 'The image could not be decoded safely'],
  QUOTA_EXCEEDED: [413, 'Storage quota exceeded; delete files before uploading more'],
  NOT_FOUND: [404, 'Not found'],
  UPLOAD_UNVERIFIED: [503, 'The image could not be stored; retry the upload'],
  CONTENT_UNAVAILABLE: [503, 'The image is temporarily unavailable'],
  METADATA_UNAVAILABLE: [503, 'The image is temporarily unavailable'],
};
async function assetResult<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof PublicAssetError) {
      const [status, message] = STATUSES[error.code];
      // Same code as private uploads so clients handle the shared quota one way.
      throw new HttpException({ code: error.code === 'QUOTA_EXCEEDED' ? 'FILE_QUOTA_EXCEEDED' : error.code, message }, status);
    }
    throw new ServiceUnavailableException('Public asset operation is unavailable');
  }
}

interface AssetResponse { setHeader(name: string, value: string): void }
interface StaffRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

/**
 * Serves ready public assets from storage. Used when PUBLIC_ASSETS_BASE_URL is not configured
 * (local development, or a private bucket behind this server/CDN). The name must be exactly
 * `<sha256>.<ext>` of a ready row, so nothing outside the public-asset prefix (private files,
 * pending writes, other keys) can be addressed. Bytes are hash-verified before they are sent.
 */
@Controller('public-assets')
@Public()
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit(PUBLIC_ASSET_READ_LIMITER)
export class PublicAssetsController {
  constructor(private readonly assets: PublicAssetsService) {}
  @Get(':name')
  read(@Param('name') name: string, @Res({ passthrough: true }) response: AssetResponse): Promise<StreamableFile> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return assetResult(async () => {
      const { asset, body } = await this.assets.read(name);
      const fileName = publicAssetFileName(asset.sha256, asset.mimeType);
      // Content-addressed: the bytes behind this URL never change.
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.setHeader('ETag', `"${asset.sha256}"`);
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      response.setHeader('Referrer-Policy', 'no-referrer');
      return new StreamableFile(body, { type: asset.mimeType, length: body.length, disposition: `inline; filename="${fileName}"` });
    });
  }
}

/**
 * Staff upload of public images for CMS content and site settings (block images, covers, logos,
 * avatars, media). Requires `content:manage`, a trusted Origin and the staff user's own quota.
 * Response: `{ sha256, url, mimeType, size, width, height, deduplicated }`.
 */
@Controller('management/public-assets')
@Permissions('content:manage')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: PUBLIC_ASSET_UPLOAD_LIMITER, keyExtractor: '#userId' })
export class PublicAssetsManagementController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly assets: PublicAssetsService) {}
  @Post() @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 2 } }))
  upload(@Req() req: StaffRequest, @Res({ passthrough: true }) response: AssetResponse, @UploadedFile() file?: UploadedPrivateFile) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (typeof req.headers.origin !== 'string' || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('Untrusted upload origin');
    // The client-declared type and file name are ignored; the content is sniffed and re-encoded.
    if (!file || !Buffer.isBuffer(file.buffer)) throw new HttpException({ code: 'INVALID_ARGUMENT', message: STATUSES.INVALID_ARGUMENT[1] }, 400);
    return assetResult(() => this.assets.upload(req.user.id, file.buffer));
  }
}
