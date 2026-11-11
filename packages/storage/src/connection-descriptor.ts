/**
 * Plain-data connection descriptor for private file storage (local disk or S3/R2-compatible): profile id, environment keys, field types,
 * English display text and stable translation keys. It has no runtime dependency; an application turns
 * it into a saved connection profile with `localizeConnectionDescriptor` from
 * `@zucker-framework/config/connections` (matched structurally) and adds its own validation.
 * Ids and environment keys are a storage contract: saved configuration is keyed by them, so never rename one.
 */
export type StorageConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface StorageConnectionDescriptorField {
  readonly key: string; readonly label: string; readonly labelKey: string; readonly type: StorageConnectionFieldType;
  readonly options?: readonly string[]; readonly defaultValue?: string; readonly description?: string; readonly min?: number; readonly max?: number;
}
export interface StorageConnectionDescriptor {
  readonly profile: {
    readonly id: string; readonly name: string; readonly labelKey: string; readonly category: string; readonly categoryKey: string;
    readonly fields: readonly StorageConnectionDescriptorField[];
  };
}

/** Private files: `FILES_STORAGE_PROVIDER` selects local disk or an S3/R2-compatible bucket. */
export const PRIVATE_FILES_CONNECTION_DESCRIPTOR: StorageConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'private-files', name: 'Private file storage (S3 / R2)', labelKey: 'connections.private-files', category: 'Storage', categoryKey: 'connections.category.storage',
    fields: Object.freeze<StorageConnectionDescriptorField[]>([
      { key: 'FILES_STORAGE_PROVIDER', label: 'Storage type', labelKey: 'connections.field.FILES_STORAGE_PROVIDER', type: 'select', options: ['local', 's3'], defaultValue: 'local' },
      { key: 'FILES_S3_BUCKET', label: 'Bucket', labelKey: 'connections.field.FILES_S3_BUCKET', type: 'text' },
      { key: 'FILES_S3_REGION', label: 'Region', labelKey: 'connections.field.FILES_S3_REGION', type: 'text', defaultValue: 'us-east-1' },
      { key: 'FILES_S3_ENDPOINT', label: 'S3-compatible endpoint', labelKey: 'connections.field.FILES_S3_ENDPOINT', type: 'url' },
      { key: 'FILES_S3_ACCESS_KEY_ID', label: 'Access key ID', labelKey: 'connections.field.FILES_S3_ACCESS_KEY_ID', type: 'secret' },
      { key: 'FILES_S3_SECRET_ACCESS_KEY', label: 'Secret access key', labelKey: 'connections.field.FILES_S3_SECRET_ACCESS_KEY', type: 'secret' },
      { key: 'FILES_S3_FORCE_PATH_STYLE', label: 'Use path-style addressing (empty: chosen by endpoint)', labelKey: 'connections.field.FILES_S3_FORCE_PATH_STYLE', type: 'boolean' },
    ]) }),
});

/**
 * WebDAV object storage (Nextcloud, ownCloud, a dedicated WebDAV server): endpoint, credentials and the
 * base path files are written under. The endpoint is an endpoint field for the "credentials follow the
 * endpoint" rule (`*_BASE_URL`), so changing it requires re-entering the password in the same save.
 * Local fallback directories are filesystem paths of the host and deliberately not part of the profile.
 */
export const WEBDAV_STORAGE_CONNECTION_DESCRIPTOR: StorageConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'webdav-storage', name: 'WebDAV file storage', labelKey: 'connections.webdav-storage', category: 'Storage', categoryKey: 'connections.category.storage',
    fields: Object.freeze<StorageConnectionDescriptorField[]>([
      { key: 'WEBDAV_BASE_URL', label: 'WebDAV endpoint', labelKey: 'connections.field.WEBDAV_BASE_URL', type: 'url' },
      { key: 'WEBDAV_USERNAME', label: 'Username', labelKey: 'connections.field.WEBDAV_USERNAME', type: 'text' },
      { key: 'WEBDAV_PASSWORD', label: 'Password', labelKey: 'connections.field.WEBDAV_PASSWORD', type: 'secret' },
      { key: 'WEBDAV_BASE_PATH', label: 'Base path', labelKey: 'connections.field.WEBDAV_BASE_PATH', type: 'text', defaultValue: '/',
        description: 'Absolute path under the endpoint, for example /uploads.' },
    ]) }),
});

/** Options parsed from a WebDAV profile environment (structurally `WebDavStorageOptions`). */
export interface WebDavConnectionOptions { readonly url: string; readonly username?: string; readonly password?: string; readonly basePath: string }

/**
 * Local assembly check and parser for `WEBDAV_STORAGE_CONNECTION_DESCRIPTOR` values: an http(s) endpoint
 * without embedded credentials, query or fragment; username and password both set (anonymous access is
 * a consumer decision, `allowAnonymous`); an absolute base path without `..` segments. No request is made.
 * Throws an `Error` whose message names the offending key only, never a value.
 */
export function webDavOptionsFromConnection(environment: Readonly<Record<string, string | undefined>>, options: { allowAnonymous?: boolean } = {}): WebDavConnectionOptions {
  const value = (key: string) => { const raw = environment[key]?.trim(); return raw ? raw : undefined; };
  const endpoint = value('WEBDAV_BASE_URL');
  let url: URL;
  try { url = new URL(endpoint ?? ''); } catch { throw new Error('WEBDAV_BASE_URL is required and must be an http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('WEBDAV_BASE_URL must be an http(s) URL without credentials, query or fragment');
  const username = value('WEBDAV_USERNAME'), password = environment.WEBDAV_PASSWORD || undefined;
  if (!!username !== !!password) throw new Error('WEBDAV_USERNAME and WEBDAV_PASSWORD must be set together');
  if (!username && !options.allowAnonymous) throw new Error('WEBDAV_USERNAME and WEBDAV_PASSWORD are required');
  const basePath = value('WEBDAV_BASE_PATH') ?? '/';
  if (!basePath.startsWith('/') || basePath.split('/').some(segment => segment === '..' || segment === '.') || /[\u0000-\u001f\u007f\\]/.test(basePath))
    throw new Error('WEBDAV_BASE_PATH must be an absolute path without dot segments');
  return Object.freeze({ url: endpoint!, ...(username ? { username, password } : {}), basePath });
}
