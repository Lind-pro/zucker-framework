import { getTranslations } from 'next-intl/server';
import { readSiteSettings } from '@/features/content/server';
import { DEFAULT_LOCALE, isLocale } from '@/lib/site/locales';
import { latinText, OG_IMAGE_CONTENT_TYPE, OG_IMAGE_SIZE, renderOgImage } from '@/lib/site/og-image';

export const alt = 'Site preview';
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;

/** Default share image for every page of a locale; buildMetadata points og:image here. */
export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const [site, landing, english] = await Promise.all([
    readSiteSettings(locale),
    getTranslations({ locale, namespace: 'landing' }),
    getTranslations({ locale: 'en', namespace: 'landing' }),
  ]);
  return renderOgImage({
    siteName: latinText(site.name, 'Zucker'),
    title: latinText(landing('heroTitle'), english('heroTitle')),
  });
}
