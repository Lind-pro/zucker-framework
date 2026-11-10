import { MAX_FILE_BYTES } from './files.config';

export const PUBLIC_ASSETS_OPTIONS = Symbol('PUBLIC_ASSETS_OPTIONS');
/** Default largest accepted upload (5 MiB); bounded by the 10 MiB HTTP upload boundary. */
export const DEFAULT_PUBLIC_ASSET_MAX_BYTES = 5 * 1024 * 1024;
/** Longest stored edge; larger images are scaled down during the re-encode. */
export const PUBLIC_ASSET_MAX_DIMENSION = 4096;
/** Decoder bound against decompression bombs (pixels of the input). */
export const PUBLIC_ASSET_MAX_INPUT_PIXELS = 40_000_000;
/** Application route serving ready assets when no public base URL is configured. */
export const PUBLIC_ASSET_ROUTE = '/api/public-assets';

export interface PublicAssetsOptions {
  maxInputBytes: number;
  /** Stored object bound (the re-encode may grow a small, highly compressed input). */
  maxObjectBytes: number;
  /**
   * Base URL that maps to the storage bucket root (CDN or public bucket endpoint). The bucket must
   * allow anonymous reads of `public-assets/*` only. Empty: URLs use the application route.
   */
  baseUrl: string;
}

export function publicAssetsOptionsFromEnvironment(env: NodeJS.ProcessEnv): PublicAssetsOptions {
  const raw = env.PUBLIC_ASSETS_MAX_BYTES;
  const maxInputBytes = raw === undefined || raw === '' ? DEFAULT_PUBLIC_ASSET_MAX_BYTES : Number(raw);
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_FILE_BYTES)
    throw new Error(`PUBLIC_ASSETS_MAX_BYTES must be a positive integer no greater than ${MAX_FILE_BYTES}`);
  let baseUrl = env.PUBLIC_ASSETS_BASE_URL?.trim() ?? '';
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('PUBLIC_ASSETS_BASE_URL must be an absolute URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (env.NODE_ENV === 'production' && url.protocol !== 'https:'))
      throw new Error('PUBLIC_ASSETS_BASE_URL must be an https URL without credentials, query or fragment');
    baseUrl = url.href.replace(/\/+$/, '');
  }
  return { maxInputBytes, maxObjectBytes: MAX_FILE_BYTES, baseUrl };
}
