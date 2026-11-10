import type { Metadata } from 'next';
import { DEFAULT_LOCALE, isLocale } from '@/lib/site/locales';
import { buildMetadata } from '@/lib/site/metadata';

/**
 * AI and chat pages are per-user (private, no-store via the proxy's prefix list) and never
 * indexed; they still get canonical/alternate URLs from SITE_URL like every other page.
 */
export function privatePageMetadata(locale: string, path: string, title: string, description?: string): Metadata {
  return buildMetadata({ locale: isLocale(locale) ? locale : DEFAULT_LOCALE, path, title, description, noIndex: true });
}
