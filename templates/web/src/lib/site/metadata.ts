import type { Metadata } from 'next';
import { DEFAULT_LOCALE, LOCALE_TAGS, ROUTED_LOCALES, type Locale } from './locales';
import { localizedUrl, siteOrigin } from './url';

export interface BuildMetadataInput {
  locale: Locale;
  /** Locale-independent path starting with "/", e.g. "/pricing" or "/blog/hello". */
  path: string;
  title: string;
  description?: string;
  noIndex?: boolean;
  type?: 'website' | 'article';
  /**
   * Locales this exact path exists in. Defaults to every routed locale; pass `[locale]` for
   * content whose slug differs per locale (CMS entries), so no wrong hreflang is emitted.
   */
  alternateLocales?: readonly Locale[];
  /**
   * Absolute or root-relative image URL. Defaults to the locale's generated `/{locale}/opengraph-image`.
   * `false` omits `images` so a co-located `opengraph-image.tsx` file in the page segment applies.
   */
  image?: string | false;
  siteName?: string;
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
  /** Test/override seam; defaults to the configured SITE_URL origin. */
  origin?: string;
  /** Test/override seam; defaults to DEFAULT_LOCALE. */
  defaultLocale?: Locale;
}

/** Path of the per-locale generated Open Graph image (always prefixed; the proxy serves it as-is). */
export function openGraphImagePath(locale: Locale): string {
  return `/${locale}/opengraph-image`;
}

/**
 * One place for public-page metadata: canonical, hreflang alternates (+ x-default), Open Graph,
 * Twitter card and robots. Every URL derives from SITE_URL, never from the request.
 */
export function buildMetadata(input: BuildMetadataInput): Metadata {
  const origin = input.origin ?? siteOrigin();
  const defaultLocale = input.defaultLocale ?? DEFAULT_LOCALE;
  const canonical = localizedUrl(origin, input.locale, input.path, defaultLocale);
  const available = (input.alternateLocales ?? ROUTED_LOCALES).filter((locale, index, all) => all.indexOf(locale) === index);
  const languages: Record<string, string> = {};
  for (const locale of available)
    languages[LOCALE_TAGS[locale].hreflang] = localizedUrl(origin, locale, input.path, defaultLocale);
  if (available.length > 1) {
    const fallback = available.includes(defaultLocale) ? defaultLocale : available[0];
    languages['x-default'] = localizedUrl(origin, fallback, input.path, defaultLocale);
  }
  const image =
    input.image === false ? undefined : new URL(input.image ?? openGraphImagePath(input.locale), origin).href;
  const type = input.type ?? 'website';
  const index = !input.noIndex;
  return {
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    alternates: { canonical, languages },
    robots: { index, follow: true },
    openGraph: {
      type,
      url: canonical,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.siteName ? { siteName: input.siteName } : {}),
      locale: LOCALE_TAGS[input.locale].openGraph,
      alternateLocale: available.filter((locale) => locale !== input.locale).map((locale) => LOCALE_TAGS[locale].openGraph),
      ...(image ? { images: [{ url: image, width: 1200, height: 630 }] } : {}),
      ...(type === 'article'
        ? {
            ...(input.publishedTime ? { publishedTime: input.publishedTime } : {}),
            ...(input.modifiedTime ? { modifiedTime: input.modifiedTime } : {}),
            ...(input.authors?.length ? { authors: input.authors } : {}),
          }
        : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(image ? { images: [image] } : {}),
    },
  };
}

