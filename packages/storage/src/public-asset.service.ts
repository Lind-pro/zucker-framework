import { createHash } from 'node:crypto';
import { StorageTransferError, transferVerifiedObject, verifyStoredObject } from './verified-object-transfer';
import {
  detectRasterImageMime,
  looksLikeSvg,
  parsePublicAssetFileName,
  publicAssetFileName,
  publicAssetObjectKey,
  PublicAssetError,
  type PublicAssetRecord,
  type PublicAssetServiceOptions,
  type PublicAssetView,
} from './public-asset';

const detect = (body: Buffer): string => detectRasterImageMime(body) ?? 'application/octet-stream';

/**
 * Public, content-addressed raster images (CMS covers, logos, landing images, re-hosted outputs).
 *
 * Invariants:
 * - Only bytes produced by the host normalizer (a full decode and re-encode) are stored; the input's
 *   own bytes, metadata and declared type are never published.
 * - The object key and row are derived from the SHA-256 of the stored bytes, so identical uploads,
 *   including concurrent ones, converge on one object and one row. Concurrent writers of one key
 *   write identical bytes, and every write is read back and verified before the row becomes ready.
 * - Only the first uploader is charged (repository quota); a repeated upload returns the stored URL.
 */
export class PublicAssetService {
  private readonly now: () => number;

  constructor(private readonly options: PublicAssetServiceOptions) {
    for (const name of ['maxInputBytes', 'maxObjectBytes'] as const)
      if (!Number.isSafeInteger(options[name]) || options[name] < 1) throw new RangeError(`${name} must be a positive integer`);
    this.now = options.now ?? Date.now;
  }

  async upload(ownerId: string, input: Buffer): Promise<PublicAssetView> {
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 191 || /[\x00-\x1f\x7f]/.test(ownerId))
      throw new PublicAssetError('INVALID_ARGUMENT');
    if (!Buffer.isBuffer(input) || input.length < 1) throw new PublicAssetError('INVALID_ARGUMENT');
    if (input.length > this.options.maxInputBytes) throw new PublicAssetError('TOO_LARGE');
    // Snapshot before awaiting: the caller cannot change what was validated.
    const body = Buffer.from(input);
    const sniffed = detectRasterImageMime(body);
    if (!sniffed) throw new PublicAssetError(looksLikeSvg(body) ? 'SVG_REJECTED' : 'UNSUPPORTED_TYPE');
    let normalized: Awaited<ReturnType<PublicAssetServiceOptions['normalize']>>;
    try { normalized = await this.options.normalize(body, sniffed); }
    catch { throw new PublicAssetError('INVALID_IMAGE'); }
    const output = normalized?.body;
    if (!Buffer.isBuffer(output) || output.length < 1 || detectRasterImageMime(output) !== normalized.mimeType
      || !Number.isSafeInteger(normalized.width) || normalized.width < 1
      || !Number.isSafeInteger(normalized.height) || normalized.height < 1)
      throw new PublicAssetError('INVALID_IMAGE');
    if (output.length > this.options.maxObjectBytes) throw new PublicAssetError('TOO_LARGE');
    const sha256 = createHash('sha256').update(output).digest('hex');
    const candidate = {
      sha256, ownerId, objectKey: publicAssetObjectKey(sha256, normalized.mimeType), size: output.length,
      mimeType: normalized.mimeType, width: normalized.width, height: normalized.height, createdAt: this.now(),
    };
    const { asset, created } = await this.metadata(() => this.options.repository.reserve(candidate));
    if (asset.sha256 !== sha256 || asset.objectKey !== candidate.objectKey || asset.size !== candidate.size || asset.mimeType !== candidate.mimeType)
      throw new PublicAssetError('METADATA_UNAVAILABLE');
    if (asset.state === 'ready') return this.view(asset, !created);
    // Pending: this request created the row, another upload is in flight, or an earlier one stopped
    // before completing. Writing the same verified bytes to the same key is safe in each case.
    try {
      await transferVerifiedObject({
        source: { body: output, reportedSize: output.length }, target: this.options.objects,
        destinationKey: asset.objectKey, mode: 'apply', allowUpload: true, detectMimeType: detect,
      });
    } catch (error) {
      if (error instanceof StorageTransferError && error.code === 'STORAGE_NOT_CONFIGURED') throw new PublicAssetError('CONTENT_UNAVAILABLE');
      throw new PublicAssetError('UPLOAD_UNVERIFIED');
    }
    const ready = await this.metadata(() => this.options.repository.markReady(sha256));
    return this.view(ready, !created);
  }

  /** Metadata of a ready asset by its public file name (`<sha256>.<ext>`), or NOT_FOUND. */
  async find(fileName: unknown): Promise<PublicAssetRecord> {
    const parsed = parsePublicAssetFileName(fileName);
    if (!parsed) throw new PublicAssetError('NOT_FOUND');
    const asset = await this.metadata(() => this.options.repository.get(parsed.sha256));
    if (!asset || asset.state !== 'ready' || asset.mimeType !== parsed.mimeType || asset.sha256 !== parsed.sha256)
      throw new PublicAssetError('NOT_FOUND');
    return asset;
  }

  /** Bounded, verified read of a ready asset for an application route. */
  async read(fileName: unknown): Promise<{ asset: PublicAssetRecord; body: Buffer }> {
    const asset = await this.find(fileName);
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > this.options.maxObjectBytes)
      throw new PublicAssetError('CONTENT_UNAVAILABLE');
    try {
      const object = await this.options.objects.read(asset.objectKey);
      verifyStoredObject(object, asset, detect);
      return { asset, body: object.body };
    } catch { throw new PublicAssetError('CONTENT_UNAVAILABLE'); }
  }

  view(asset: PublicAssetRecord, deduplicated = false): PublicAssetView {
    return {
      sha256: asset.sha256, url: this.options.publicUrl(asset.objectKey, publicAssetFileName(asset.sha256, asset.mimeType)),
      mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height, deduplicated,
    };
  }

  private async metadata<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof PublicAssetError) throw error;
      throw new PublicAssetError('METADATA_UNAVAILABLE');
    }
  }
}
