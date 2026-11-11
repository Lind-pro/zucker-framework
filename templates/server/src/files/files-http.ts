import type { Readable } from 'node:stream';
import { HttpException, Logger, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { FileAssetError, StorageTransferError, type FileAsset } from '@zucker-framework/storage';
const streamLogger = new Logger('PrivateFileStream');
export interface DownloadResponse { setHeader(name: string, value: string): void }
export async function fileResult<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof FileAssetError) {
      const statuses = { INVALID_ARGUMENT: 400, FORBIDDEN: 403, NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409,
        ASSET_DELETED: 410, ASSET_NOT_READY: 409, CONTENT_UNAVAILABLE: 503, UPLOAD_UNVERIFIED: 503,
        DELETE_UNVERIFIED: 503, METADATA_UNAVAILABLE: 503, CONCURRENT_CHANGE: 409 };
      throw new HttpException({ code: error.code, message: error.message }, statuses[error.code]);
    }
    if (error instanceof StorageTransferError) {
      const status = error.code === 'OBJECT_SIZE_OUT_OF_BOUNDS' ? 413 : error.code === 'STORAGE_NOT_CONFIGURED' ? 503 : 409;
      throw new HttpException({ code: error.code, message: 'File content could not be verified' }, status);
    }
    throw new ServiceUnavailableException('Private file operation is unavailable; inspect the request before retrying');
  }
}
export function fileAttachment(result: { asset: FileAsset; body: Buffer } | { asset: FileAsset; stream: Readable; size: number }, response: DownloadResponse): StreamableFile {
  const { asset } = result;
  response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  const name = encodeURIComponent(Buffer.from(asset.fileName, 'utf8').toString('utf8')).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const options = { type: asset.mimeType, length: 'body' in result ? result.body.length : result.size,
    disposition: `attachment; filename="download"; filename*=UTF-8''${name}` };
  // Large server-generated files stream (verified as they flow); everything else is a verified buffer.
  if ('body' in result) return new StreamableFile(result.body, options);
  // A verification failure while streaming destroys the connection (never a clean, short 200 and never
  // an error text inside the attachment); the client sees an aborted download.
  return new StreamableFile(result.stream, options)
    .setErrorHandler((_error, response) => {
      // Express hands the Node ServerResponse; the Nest type omits destroy().
      const socket = response as typeof response & { destroy?: () => void };
      if (socket.destroyed) return;
      if (socket.destroy) socket.destroy(); else socket.end();
    })
    .setErrorLogger(() => { streamLogger.warn('private_file_stream_aborted'); });
}
