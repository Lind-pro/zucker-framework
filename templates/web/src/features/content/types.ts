import type { SiteColorMode, SiteDocument } from '@zucker-framework/fe-site/content';
import { DEFAULT_LOCALE, isLocale, LOCALES } from '../../lib/site/locales';
import { localizedPath } from '../../lib/site/url';

/** `log` entries are changelog releases, listed on /changelog. */
export type ContentKind = 'page' | 'post' | 'doc' | 'log';
export type ContentLocale = 'zh' | 'en';
export interface SiteLink {
  label: string;
  href: string;
}
export interface PublicSiteSettings {
  name: string;
  description: string;
  theme: string;
  appearance: SiteColorMode;
  navigation: SiteLink[];
  footerLinks: SiteLink[];
  siteUrl: string;
  /** Present on current servers; absent from older ones and from the outage defaults. */
  logoUrl?: string | null;
  social?: { platform: string; href: string }[];
  banner?: { text: string; href: string | null } | null;
}
export interface SiteSettings {
  name: string;
  theme: string;
  appearance: SiteColorMode;
  description: Record<ContentLocale, string>;
  navigation: Record<ContentLocale, SiteLink[]>;
  footerLinks: Record<ContentLocale, SiteLink[]>;
}
export interface Category {
  id: string;
  locale: ContentLocale;
  slug: string;
  title: string;
  description: string;
}
export interface Entry {
  id: string;
  kind: ContentKind;
  locale: ContentLocale;
  slug: string;
  title: string;
  description: string;
  authorName: string;
  publishedAt: string;
  updatedAt: string;
  categories: Category[];
  /** `database` for CMS rows, `file` for documents shipped in the Server's content directory. */
  source?: 'database' | 'file';
}
export interface EntryDetail extends Entry {
  document: SiteDocument;
}
export interface EntryPage<T extends Entry = Entry> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  category: Category | null;
}
export interface DraftEntry {
  id: string;
  kind: ContentKind;
  locale: ContentLocale;
  slug: string;
  draft: { document: SiteDocument; categoryIds: string[] };
  status: 'draft' | 'published' | 'archived';
  revision: number;
  publishedRevision: number | null;
  publishedSlug: string | null;
  updatedAt: string;
}
export interface DraftCategory {
  id: string;
  locale: ContentLocale;
  slug: string;
  draft: { title: string; description: string };
  status: 'draft' | 'published' | 'archived';
  revision: number;
  publishedRevision: number | null;
}
/** Page slug rendered at the site root instead of `/home`. */
export const HOME_PAGE_SLUG = 'home';
/** Locale-independent public path of an entry. */
export function contentPath(kind: ContentKind, slug: string): string {
  if (kind === 'page' && slug === HOME_PAGE_SLUG) return '/';
  const prefix = { page: '', post: '/blog', doc: '/docs', log: '/changelog' }[kind];
  return `${prefix}/${slug}`;
}
const localePrefix = new RegExp(`^/(${LOCALES.join('|')})(?=/|\\?|#|$)`);
/**
 * Site-relative href for `locale` following the `as-needed` rule (default locale unprefixed), so a
 * link never costs a redirect hop. Hrefs already carrying a locale keep it, except a redundant
 * default-locale prefix, which is dropped. External, protocol-relative and fragment hrefs are
 * returned unchanged. Public site links use document navigation, including into protected areas.
 */
export function localizedHref(href: string, locale: string): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const prefixed = localePrefix.exec(href);
  if (prefixed) {
    if (prefixed[1] !== DEFAULT_LOCALE) return href;
    const rest = href.slice(prefixed[0].length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return isLocale(locale) ? localizedPath(locale, href) : href;
}
export function emptyDocument(): SiteDocument {
  return {
    version: 1,
    title: '',
    description: '',
    authorName: '',
    markdown: '',
    blocks: [],
    seo: { title: '', description: '', noIndex: false },
  };
}
