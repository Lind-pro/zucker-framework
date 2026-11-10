import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * Canonical, alternate, Open Graph and sitemap URLs are built only from the configured SITE_URL
 * origin. The request Host header is never consulted, so a forged Host cannot poison cached HTML.
 */
export function parseSiteOrigin(value: string | undefined, fallback = 'http://localhost:4202'): string {
  const url = new URL(value?.trim() || fallback);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('SITE_URL must be an HTTP(S) origin without path, query or credentials');
  return url.origin;
}

export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  return parseSiteOrigin(env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL);
}

/** Optional back-office link; empty disables it. Absolute HTTP(S) URL without credentials. */
export function parseAdminUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.href;
}

/**
 * Locale-aware path following the `as-needed` prefix rule: the default locale is unprefixed,
 * every other locale is prefixed. `path` must start with "/" and may carry a query string.
 */
export function localizedPath(locale: Locale, path: string, defaultLocale: Locale = DEFAULT_LOCALE): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`Site path must be absolute: ${path}`);
  if (locale === defaultLocale) return path;
  return path === '/' ? `/${locale}` : path.startsWith('/?') ? `/${locale}${path.slice(1)}` : `/${locale}${path}`;
}

export function localizedUrl(
  origin: string,
  locale: Locale,
  path: string,
  defaultLocale: Locale = DEFAULT_LOCALE,
): string {
  return new URL(localizedPath(locale, path, defaultLocale), origin).href;
}
