import {
  LocalFileStorage, S3_MAX_PART_SIZE, S3_MIN_PART_SIZE, S3Storage, WebDavStorage, type FileManager, type StorageModuleOptions,
} from '@zucker-framework/storage';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILES_OPTIONS = Symbol('FILES_OPTIONS');
/** Per-owner storage defaults: 1 GiB and 1000 live (non-deleted) files. */
export const DEFAULT_OWNER_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_OWNER_MAX_FILES = 1000;
/** Age after which a write-ahead object intent with no recorded file is treated as an orphan. */
export const DEFAULT_ORPHAN_GRACE_MINUTES = 60;
export const MAX_ORPHAN_GRACE_MINUTES = 7 * 24 * 60;
export interface FilesOptions {
  maxObjectBytes: number;
  /** Total bytes of an owner's non-deleted files (uploads, imports and avatars). Defaults to 1 GiB. */
  maxOwnerBytes?: number;
  /** Number of an owner's non-deleted files. Defaults to 1000. */
  maxOwnerFiles?: number;
  /**
   * Minutes an object intent (written before a server-generated object is uploaded) may stay open
   * before the orphan sweeper deletes the unrecorded object. Defaults to 60. Long uploads refresh it.
   */
  orphanGraceMinutes?: number;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function filesOptionsFromEnvironment(env: NodeJS.ProcessEnv): FilesOptions {
  const maxObjectBytes = env.FILES_MAX_BYTES === undefined ? MAX_FILE_BYTES : Number(env.FILES_MAX_BYTES);
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > MAX_FILE_BYTES)
    throw new Error('FILES_MAX_BYTES must be a positive integer no greater than 10485760');
  const maxOwnerBytes = positiveInteger(env, 'FILES_OWNER_MAX_BYTES', DEFAULT_OWNER_MAX_BYTES);
  if (maxOwnerBytes < maxObjectBytes) throw new Error('FILES_OWNER_MAX_BYTES must be at least FILES_MAX_BYTES');
  const orphanGraceMinutes = positiveInteger(env, 'FILES_ORPHAN_GRACE_MINUTES', DEFAULT_ORPHAN_GRACE_MINUTES);
  if (orphanGraceMinutes > MAX_ORPHAN_GRACE_MINUTES) throw new Error(`FILES_ORPHAN_GRACE_MINUTES must be at most ${MAX_ORPHAN_GRACE_MINUTES}`);
  return { maxObjectBytes, maxOwnerBytes, maxOwnerFiles: positiveInteger(env, 'FILES_OWNER_MAX_FILES', DEFAULT_OWNER_MAX_FILES), orphanGraceMinutes };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for private S3 storage`);
  return value;
}

/**
 * Production requires https endpoints. `FILES_S3_INTERNAL_HTTP=true` (process environment only, never a
 * saved connection field) additionally allows plain http to a single-label host, i.e. a service on the
 * same private container network such as the workspace compose file's `http://minio:9000`. A saved
 * endpoint on any other host still needs https, so the switch cannot send credentials across the internet.
 */
function internalHttpEndpoint(env: NodeJS.ProcessEnv, url: URL): boolean {
  return env.FILES_S3_INTERNAL_HTTP === 'true' && url.protocol === 'http:' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname);
}

/** Composition-root configuration for the application's one shared FileManager. */
export function storageOptionsFromEnvironment(env: NodeJS.ProcessEnv): StorageModuleOptions {
  const provider = env.FILES_STORAGE_PROVIDER ?? 'local';
  if (provider === 'local') {
    if (env.NODE_ENV === 'production') throw new Error('Production private files require explicit S3 storage');
    return { provider: 'local', basePath: env.FILES_LOCAL_PATH?.trim() || './uploads' };
  }
  if (provider !== 's3') throw new Error('FILES_STORAGE_PROVIDER must be local or s3');
  const endpoint = env.FILES_S3_ENDPOINT?.trim();
  if (endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (env.NODE_ENV === 'production' && url.protocol !== 'https:' && !internalHttpEndpoint(env, url))) throw new Error('Invalid private S3 endpoint');
  }
  const forcePathStyle = env.FILES_S3_FORCE_PATH_STYLE;
  if (forcePathStyle !== undefined && forcePathStyle !== 'true' && forcePathStyle !== 'false')
    throw new Error('FILES_S3_FORCE_PATH_STYLE must be true or false');
  // Multipart part size for streamed uploads (AI outputs); one part is buffered at a time.
  const partSize = env.FILES_S3_PART_SIZE_BYTES === undefined || env.FILES_S3_PART_SIZE_BYTES === '' ? undefined : Number(env.FILES_S3_PART_SIZE_BYTES);
  if (partSize !== undefined && (!Number.isSafeInteger(partSize) || partSize < S3_MIN_PART_SIZE || partSize > S3_MAX_PART_SIZE))
    throw new Error(`FILES_S3_PART_SIZE_BYTES must be an integer between ${S3_MIN_PART_SIZE} and ${S3_MAX_PART_SIZE}`);
  return { provider: 's3', bucket: required(env, 'FILES_S3_BUCKET'),
    accessKeyId: required(env, 'FILES_S3_ACCESS_KEY_ID'), secretAccessKey: required(env, 'FILES_S3_SECRET_ACCESS_KEY'),
    region: env.FILES_S3_REGION?.trim() || 'us-east-1', endpoint,
    forcePathStyle: forcePathStyle === undefined ? Boolean(endpoint) : forcePathStyle === 'true',
    objectAclMode: 'none', uploadUrlMode: 'public-only', ...(partSize === undefined ? {} : { partSize }) };
}

/** The hot runtime connection profile that configures private (and public asset) object storage. */
export const PRIVATE_FILES_CONNECTION_PROFILE = 'private-files';
/**
 * Fields that decide where objects live (decision D14). Changing one while file rows exist needs
 * `acknowledgeDataLocationChange: true` in the save body: existing rows keep their object keys and the
 * framework does not move objects, so they stay where they were. Credential-only changes need no flag.
 */
export const STORAGE_LOCATION_FIELDS: readonly string[] = ['FILES_STORAGE_PROVIDER', 'FILES_S3_ENDPOINT', 'FILES_S3_BUCKET'];

/** Builds one FileManager from parsed options (no network request; S3 clients connect lazily). */
export function fileManagerFromOptions(options: StorageModuleOptions): FileManager {
  if (options.provider === 'local') return new LocalFileStorage({ basePath: options.basePath, baseUrl: options.baseUrl });
  if (options.provider === 'webdav') { const { provider: _provider, ...webdav } = options; return new WebDavStorage(webdav); }
  const { provider: _provider, ...s3 } = options;
  return new S3Storage(s3);
}

/** Conservative byte signatures; unknown content stays a binary attachment, never trusted client MIME. */
export function detectPrivateFileMime(body: Buffer): string {
  if (body.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  return 'application/octet-stream';
}
