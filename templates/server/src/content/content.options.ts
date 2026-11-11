import { isAbsolute, resolve } from 'node:path';

export const CONTENT_OPTIONS = Symbol('CONTENT_OPTIONS');
export interface ContentOptions {
  siteUrl: string;
  origins: readonly string[];
  /**
   * Shared HMAC secret for `POST <siteUrl>/api/revalidate`. Absent: publish hooks are skipped.
   * Optional so callers that build options by hand (tests) keep working without revalidation.
   */
  revalidateSecret?: string;
  /**
   * Origin the server posts revalidation to (`REVALIDATE_URL`), when the Web app is reachable on another
   * address than its public origin (a private container network: `http://web:3000`). Default: `siteUrl`.
   */
  revalidateUrl?: string;
  /** Absolute path of the app's `content/` directory. Absent: no file-backed documents are served. */
  contentDirectory?: string;
}
export const REVALIDATE_SECRET_MIN_LENGTH = 32;
export function contentOptionsFromEnvironment(env: NodeJS.ProcessEnv): ContentOptions {
  const url = new URL(env.WEB_URL ?? 'http://localhost:4202');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('WEB_URL must be the site origin for content URLs');
  const secret = env.REVALIDATE_SECRET?.trim() || undefined;
  const internal = env.REVALIDATE_URL?.trim() ? new URL(env.REVALIDATE_URL.trim()) : undefined;
  if (internal && (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.search || internal.hash || internal.pathname !== '/'))
    throw new Error('REVALIDATE_URL must be an origin (scheme, host and port only)');
  if (secret && secret.length < REVALIDATE_SECRET_MIN_LENGTH)
    throw new Error(`REVALIDATE_SECRET must be at least ${REVALIDATE_SECRET_MIN_LENGTH} characters`);
  // CONTENT_DIR may relocate the directory (tests, containers); the file source never reads outside it.
  const directory = env.CONTENT_DIR?.trim() || 'content';
  return { siteUrl: url.origin, origins: (env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()).filter(Boolean),
    ...(secret ? { revalidateSecret: secret } : {}),
    ...(internal ? { revalidateUrl: internal.origin } : {}),
    contentDirectory: isAbsolute(directory) ? directory : resolve(process.cwd(), directory) };
}
