import 'server-only';
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { buildMetadata } from '@/lib/site/metadata';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/site/locales';
import { siteOrigin } from '@/lib/site/url';
import { contentCopy } from './copy';
import type { ContentKind, Entry, EntryDetail, EntryPage, PublicSiteSettings } from './types';
import { contentPath } from './types';

export class ContentUnavailableError extends Error {}

/** Seconds a public content read stays in the Next data cache; `POST /api/revalidate` expires it sooner. */
export const CONTENT_REVALIDATE_SECONDS = 3600;

/**
 * Cache tags of a public content read. They match the tags the Server signs in its revalidate
 * notification (templates/server/src/content/content-revalidate.ts `contentTags`), so publishing an
 * entry refreshes exactly the reads that can show it. Every read also carries `content`.
 */
export function contentReadTags(resource: string, query: Record<string, string>): string[] | null {
  const { kind, locale, slug } = query;
  switch (resource) {
    case 'entry':
      return ['content', `content:entry:${kind}:${locale}:${slug}`];
    case 'entries':
      return ['content', `content:list:${kind}:${locale}`];
    case 'categories':
      return ['content', `content:categories:${locale}`];
    case 'settings':
      return ['content', 'content:settings'];
    case 'sitemap':
      return ['content', 'content:sitemap'];
    default:
      // Search is keyed by free text; caching it would let visitors fill the data cache.
      return null;
  }
}

interface PublicContentOptions {
  timeoutMs?: number;
  /** Resolve a 404 to `null` instead of rendering the not-found page. */
  optional?: boolean;
}

async function fetchPublicContent<T>(
  resource: string,
  query: Record<string, string>,
  { timeoutMs = 8000, optional = false }: PublicContentOptions,
): Promise<T | null> {
  const base = (process.env.API_URL ?? 'http://localhost:4200/api').replace(/\/+$/, '');
  const url = new URL(`${base}/content/public/${resource}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const tags = contentReadTags(resource, query);
  let response: Response;
  try {
    response = await fetch(url, {
      ...(tags ? { next: { revalidate: CONTENT_REVALIDATE_SECONDS, tags } } : { cache: 'no-store' as const }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ContentUnavailableError('Content is temporarily unavailable');
  }
  if (response.status === 404) {
    if (optional) return null;
    notFound();
  }
  if (!response.ok) throw new ContentUnavailableError('Content is temporarily unavailable');
  const body: unknown = await response.json();
  return (body && typeof body === 'object' && 'result' in body ? body.result : body) as T;
}

export async function publicContent<T>(
  resource: string,
  query: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<T> {
  return (await fetchPublicContent<T>(resource, query, { timeoutMs })) as T;
}

export const readEntry = cache((kind: ContentKind, locale: string, slug: string) =>
  publicContent<EntryDetail>('entry', { kind, locale, slug }),
);
/** Like readEntry, but a missing entry is `null` (used by the home page's operator notice). */
export const readOptionalEntry = cache((kind: ContentKind, locale: string, slug: string) =>
  fetchPublicContent<EntryDetail>('entry', { kind, locale, slug }, { optional: true }),
);
export const readEntries = cache(
  (kind: ContentKind, locale: string, page = '1', category?: string, expand?: 'document') =>
    publicContent<EntryPage<Entry & { document?: EntryDetail['document'] }>>(
      'entries',
      { kind, locale, page, ...(category ? { category } : {}), ...(expand ? { expand } : {}) },
    ),
);

export const readSiteSettings = cache(async (locale: string): Promise<PublicSiteSettings> => {
  try {
    // Every route's layout waits for this read; a short timeout keeps first byte fast during an
    // API outage (the defaults below then apply).
    return await publicContent<PublicSiteSettings>('settings', { locale }, 3000);
  } catch {
    // Visual defaults keep account routes usable during a content-service outage. Article reads never fall back.
    const copy = contentCopy(locale);
    return {
      name: 'Zucker',
      description: '',
      theme: 'default',
      appearance: 'dark',
      siteUrl: siteOrigin(),
      footerLinks: [],
      navigation: [
        { label: copy.home, href: '/' },
        { label: copy.pricing, href: '/pricing' },
        { label: copy.blog, href: '/blog' },
        { label: copy.docs, href: '/docs' },
      ],
    };
  }
});

export function routeLocale(locale: string): Locale {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/** Page number for canonical URLs: page 1 and invalid values canonicalise to the unpaged URL. */
export function pagedPath(path: string, page?: string): string {
  return page && /^[1-9][0-9]{0,5}$/.test(page) && page !== '1' ? `${path}?page=${page}` : path;
}

export async function entryMetadata(kind: ContentKind, locale: string, slug: string): Promise<Metadata> {
  const [entry, settings] = await Promise.all([readEntry(kind, locale, slug), readSiteSettings(locale)]);
  const title = entry.document.seo.title || entry.title,
    description = entry.document.seo.description || entry.description;
  return buildMetadata({
    locale: routeLocale(locale),
    path: contentPath(kind, entry.slug),
    title,
    description,
    noIndex: entry.document.seo.noIndex,
    // CMS slugs differ per locale, so only this locale is a known alternate.
    alternateLocales: [routeLocale(locale)],
    siteName: settings.name,
    type: kind === 'post' ? 'article' : 'website',
    ...(kind === 'post'
      ? {
          publishedTime: entry.publishedAt,
          modifiedTime: entry.updatedAt,
          authors: entry.authorName ? [entry.authorName] : [],
        }
      : {}),
  });
}

const listingPaths = { post: '/blog', doc: '/docs', log: '/changelog' } as const;
export async function listingMetadata(
  kind: 'post' | 'doc' | 'log',
  locale: string,
  page?: string,
): Promise<Metadata> {
  const site = await readSiteSettings(locale);
  const copy = contentCopy(locale);
  const title = kind === 'post' ? copy.blogTitle : kind === 'doc' ? copy.docsTitle : copy.changelogTitle;
  return buildMetadata({
    locale: routeLocale(locale),
    path: pagedPath(listingPaths[kind], page),
    title,
    description: kind === 'log' ? copy.changelogDescription : site.description,
    siteName: site.name,
  });
}
