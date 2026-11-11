import { LOCALES } from './locales';

/**
 * Session-gated areas: the proxy redirects to login when no session cookie is present. AI generation
 * and chat render per-user state (tasks, balances, conversations), so they must never be shared-cached.
 */
export const PROTECTED_PREFIXES = ['/dashboard', '/account', '/billing', '/content/manage', '/ai', '/chat'] as const;

/** Per-user or credential-bearing pages: never stored by shared caches, never indexed. */
export const PRIVATE_PREFIXES = [
  ...PROTECTED_PREFIXES,
  '/login',
  '/register',
  '/oauth',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  // Carries a single-use sign-in ticket in the fragment; the page itself must never be shared-cached.
  '/magic-link',
] as const;

/** Robots exclusions: private pages plus public pages that are not worth crawling. */
export const ROBOTS_DISALLOWED_PREFIXES = [...PRIVATE_PREFIXES, '/docs/search'] as const;

/**
 * Public HTML is session-free (the header reads the session in the browser), so shared caches may
 * keep it for an hour and serve it stale for four more while revalidating.
 */
export const PUBLIC_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=14400';
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

export function stripLocale(pathname: string): { locale: string | undefined; path: string } {
  const first = pathname.split('/')[1] ?? '';
  if ((LOCALES as readonly string[]).includes(first))
    return { locale: first, path: pathname.slice(first.length + 1) || '/' };
  return { locale: undefined, path: pathname || '/' };
}

export function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export const isProtectedPath = (path: string) => matchesPrefix(path, PROTECTED_PREFIXES);
export const isPrivatePath = (path: string) => matchesPrefix(path, PRIVATE_PREFIXES);

/**
 * Cache-Control the proxy sets for a page response. `path` is the locale-free path.
 * Only successful GET/HEAD page responses are public; redirects and other methods are not stored.
 */
export function cacheControlFor(input: { method: string; path: string; redirect?: boolean }): string {
  if (input.redirect) return PRIVATE_CACHE_CONTROL;
  if (input.method !== 'GET' && input.method !== 'HEAD') return PRIVATE_CACHE_CONTROL;
  return isPrivatePath(input.path) ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL;
}
