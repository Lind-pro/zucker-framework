import { createHash } from 'node:crypto';

export interface DownloadedStorageObject {
  body: Buffer;
  reportedSize: number;
}
export interface BufferedObjectStore<TMimeType extends string = string> {
  read(key: string): Promise<DownloadedStorageObject>;
  exists(key: string): Promise<boolean>;
  write(
    key: string,
    body: Buffer,
    options: { contentType: TMimeType; metadata: Record<string, string>; private: true },
  ): Promise<{ size: number }>;
}

export type StorageTransferErrorCode =
  | 'STORAGE_NOT_CONFIGURED'
  | 'OBJECT_SIZE_OUT_OF_BOUNDS'
  | 'SOURCE_SIZE_MISMATCH'
  | 'TARGET_SIZE_CONFLICT'
  | 'TARGET_MIME_CONFLICT'
  | 'TARGET_HASH_CONFLICT'
  | 'UPLOAD_SIZE_MISMATCH';
export class StorageTransferError extends Error {
  constructor(readonly code: StorageTransferErrorCode) {
    super(code);
    this.name = 'StorageTransferError';
  }
}
export type StorageTransferErrorFactory = (code: StorageTransferErrorCode) => Error;

export interface VerifiedStorageMetadata<TMimeType extends string = string> {
  sha256: string;
  size: number;
  mimeType: TMimeType;
}

/** Compare every byte via SHA-256, with explicit size and MIME conflict reasons. */
export function verifyStoredObject<TMimeType extends string>(
  object: DownloadedStorageObject,
  expected: VerifiedStorageMetadata<TMimeType>,
  detectMimeType: (body: Buffer) => TMimeType,
  errorFactory: StorageTransferErrorFactory = (code) => new StorageTransferError(code),
): void {
  if (object.reportedSize !== object.body.length || object.body.length !== expected.size)
    throw errorFactory('TARGET_SIZE_CONFLICT');
  if (detectMimeType(object.body) !== expected.mimeType) throw errorFactory('TARGET_MIME_CONFLICT');
  if (createHash('sha256').update(object.body).digest('hex') !== expected.sha256)
    throw errorFactory('TARGET_HASH_CONFLICT');
}

export interface VerifiedObjectTransferOptions<TMimeType extends string> {
  source: DownloadedStorageObject;
  target: BufferedObjectStore<TMimeType>;
  destinationKey: string;
  mode: 'dry-run' | 'apply';
  allowUpload: boolean;
  detectMimeType: (body: Buffer) => TMimeType;
  errorFactory?: StorageTransferErrorFactory;
}

/**
 * Copy a bounded source buffer into a private destination, verify existing data
 * before reuse and round-trip every upload before reporting success. Dry-run and
 * disallowed uploads never write. This does not delete sources or commit metadata.
 */
export async function transferVerifiedObject<TMimeType extends string>(
  options: VerifiedObjectTransferOptions<TMimeType>,
): Promise<
  VerifiedStorageMetadata<TMimeType> & { targetDisposition: 'planned' | 'uploaded' | 'reused' }
> {
  const fail = options.errorFactory ?? ((code) => new StorageTransferError(code));
  const body = options.source.body;
  if (options.source.reportedSize !== body.length || body.length === 0)
    throw fail('SOURCE_SIZE_MISMATCH');
  const metadata: VerifiedStorageMetadata<TMimeType> = {
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
    mimeType: options.detectMimeType(body),
  };
  if (await options.target.exists(options.destinationKey)) {
    verifyStoredObject(
      await options.target.read(options.destinationKey),
      metadata,
      options.detectMimeType,
      fail,
    );
    return { ...metadata, targetDisposition: options.mode === 'dry-run' ? 'planned' : 'reused' };
  }
  if (options.mode === 'dry-run' || !options.allowUpload)
    return { ...metadata, targetDisposition: 'planned' };
  const uploaded = await options.target.write(options.destinationKey, body, {
    contentType: metadata.mimeType,
    metadata: { sha256: metadata.sha256, size: String(metadata.size), mimeType: metadata.mimeType },
    private: true,
  });
  if (uploaded.size !== metadata.size) throw fail('UPLOAD_SIZE_MISMATCH');
  verifyStoredObject(
    await options.target.read(options.destinationKey),
    metadata,
    options.detectMimeType,
    fail,
  );
  return { ...metadata, targetDisposition: 'uploaded' };
}
