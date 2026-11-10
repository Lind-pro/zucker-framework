import { DEFAULT_LOCALE, LOCALE_TAGS, ROUTED_LOCALES, type Locale } from './locales';
import { localizedUrl } from './url';

export interface SitemapAlternate {
  hreflang: string;
  href: string;
}
export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  alternates?: SitemapAlternate[];
}

export const xmlEscape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

export function buildUrlsetXml(urls: readonly SitemapUrl[]): string {
  const hasAlternates = urls.some((url) => url.alternates?.length);
  const namespaces = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}`;
  const body = urls
    .map(
      (url) =>
        `<url><loc>${xmlEscape(url.loc)}</loc>${url.lastmod ? `<lastmod>${xmlEscape(url.lastmod)}</lastmod>` : ''}${(url.alternates ?? []).map((alternate) => `<xhtml:link rel="alternate" hreflang="${xmlEscape(alternate.hreflang)}" href="${xmlEscape(alternate.href)}"/>`).join('')}</url>`,
    )
    .join('');
  return `${XML_DECLARATION}<urlset ${namespaces}>${body}</urlset>`;
}

export function buildSitemapIndexXml(locations: readonly string[]): string {
  return `${XML_DECLARATION}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((loc) => `<sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`).join('')}</sitemapindex>`;
}

/** Page 0: every static route in every routed locale, each carrying all hreflang alternates. */
export function staticSitemapUrls(
  origin: string,
  routes: readonly string[],
  locales: readonly Locale[] = ROUTED_LOCALES,
  defaultLocale: Locale = DEFAULT_LOCALE,
): SitemapUrl[] {
  return routes.flatMap((path) => {
    const alternates: SitemapAlternate[] = locales.map((locale) => ({
      hreflang: LOCALE_TAGS[locale].hreflang,
      href: localizedUrl(origin, locale, path, defaultLocale),
    }));
    if (locales.length > 1)
      alternates.push({ hreflang: 'x-default', href: localizedUrl(origin, defaultLocale, path, defaultLocale) });
    return locales.map((locale) => ({ loc: localizedUrl(origin, locale, path, defaultLocale), alternates }));
  });
}

export function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function unavailableResponse(): Response {
  return new Response('Sitemap temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
