import 'server-only';
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ContentKind, EntryDetail, PublicSiteSettings } from './types';
import { contentPath } from './types';

export class ContentUnavailableError extends Error {}
export async function publicContent<T>(
  resource: string,
  query: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<T> {
  const base = (process.env.API_URL ?? 'http://localhost:4200/api').replace(/\/+$/, '');
  const url = new URL(`${base}/content/public/${resource}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ContentUnavailableError('Content is temporarily unavailable');
  }
  if (response.status === 404) notFound();
  if (!response.ok) throw new ContentUnavailableError('Content is temporarily unavailable');
  const body: unknown = await response.json();
  return (body && typeof body === 'object' && 'result' in body ? body.result : body) as T;
}
export const readEntry = cache((kind: ContentKind, locale: string, slug: string) =>
  publicContent<EntryDetail>('entry', { kind, locale, slug }),
);
export const readSiteSettings = cache(async (locale: string): Promise<PublicSiteSettings> => {
  try {
    // Every route's layout waits for this read; a short timeout keeps first byte fast during an
    // API outage (the defaults below then apply).
    return await publicContent<PublicSiteSettings>('settings', { locale }, 3000);
  } catch {
    // Visual defaults keep account routes usable during a content-service outage. Article reads never fall back.
    return {
      name: 'Zucker',
      description: '',
      theme: 'default',
      appearance: 'dark',
      siteUrl: configuredSiteUrl(),
      footerLinks: [],
      navigation: [
        { label: locale === 'zh' ? '首页' : 'Home', href: '/' },
        { label: locale === 'zh' ? '套餐' : 'Pricing', href: '/pricing' },
        { label: locale === 'zh' ? '博客' : 'Blog', href: '/blog' },
        { label: locale === 'zh' ? '文档' : 'Docs', href: '/docs' },
      ],
    };
  }
});
export function configuredSiteUrl(): string {
  const url = new URL(
    process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4202',
  );
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('SITE_URL must be an HTTP(S) origin');
  return url.origin;
}
export async function entryMetadata(
  kind: ContentKind,
  locale: string,
  slug: string,
): Promise<Metadata> {
  const [entry, settings] = await Promise.all([
    readEntry(kind, locale, slug),
    readSiteSettings(locale),
  ]);
  const title = entry.document.seo.title || entry.title,
    description = entry.document.seo.description || entry.description;
  const url = new URL(`/${locale}${contentPath(kind, entry.slug)}`, settings.siteUrl).href;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: !entry.document.seo.noIndex, follow: true },
    openGraph: {
      title,
      description,
      url,
      type: kind === 'post' ? 'article' : 'website',
      ...(kind === 'post'
        ? {
            publishedTime: entry.publishedAt,
            modifiedTime: entry.updatedAt,
            authors: entry.authorName ? [entry.authorName] : [],
          }
        : {}),
    },
  };
}
export async function listingMetadata(
  kind: 'post' | 'doc',
  locale: string,
  page?: string,
): Promise<Metadata> {
  const site = await readSiteSettings(locale);
  const title =
    kind === 'post'
      ? locale === 'zh'
        ? '博客'
        : 'Blog'
      : locale === 'zh'
        ? '文档中心'
        : 'Documentation';
  const url = new URL(`/${locale}/${kind === 'post' ? 'blog' : 'docs'}`, site.siteUrl);
  if (page && /^[1-9][0-9]*$/.test(page) && page !== '1') url.searchParams.set('page', page);
  return {
    title,
    description: site.description,
    alternates: { canonical: url.href },
    openGraph: { title, description: site.description, url: url.href, type: 'website' },
  };
}
