import type { Metadata } from 'next';
import { DocumentView } from '@/features/content/DocumentView';
import { readOptionalEntry, readSiteSettings, routeLocale } from '@/features/content/server';
import { HOME_PAGE_SLUG, localizedHref } from '@/features/content/types';
import { landingCopy } from '@/features/landing/copy';
import { landingSlots } from '@/features/landing/slots';
import { UtmCapture } from '@/features/landing/UtmCapture';
import { buildMetadata } from '@/lib/site/metadata';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const [entry, site] = await Promise.all([
    readOptionalEntry('page', locale, HOME_PAGE_SLUG).catch(() => null),
    readSiteSettings(locale),
  ]);
  const title = entry?.document.seo.title || site.name;
  const metadata = buildMetadata({
    locale: routeLocale(locale),
    path: '/',
    title,
    description: entry?.document.seo.description || entry?.description || site.description,
    noIndex: entry?.document.seo.noIndex,
    siteName: site.name,
  });
  // The home page is the site itself: no "| Site name" suffix from the layout's title template.
  return { ...metadata, title: { absolute: title } };
}

/**
 * Home = the CMS page with slug `home`, rendered through the block renderer with live data slots
 * (pricing, recent posts, changelog). An unreachable content API renders the content error boundary
 * (no sample fallback); a site with no `home` page at all shows a notice for the operator.
 */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  const entry = await readOptionalEntry('page', locale, HOME_PAGE_SLUG);
  if (!entry) {
    const copy = landingCopy(locale);
    return (
      <section className="mx-auto max-w-3xl px-6 py-24 text-center" data-testid="home-setup">
        <h1 className="text-4xl font-bold tracking-tight">{copy.setupTitle}</h1>
        <p className="mt-5 text-lg text-[var(--color-muted)]">{copy.setupText}</p>
        <div className="mt-8 flex justify-center gap-4 text-primary-500">
          <a href={localizedHref('/pricing', locale)}>{copy.setupPricing}</a>
          <a href={localizedHref('/blog', locale)}>{copy.setupBlog}</a>
        </div>
      </section>
    );
  }
  const hasHero = entry.document.blocks.some((block) => block.enabled && block.type === 'hero');
  return (
    <div className="mx-auto max-w-6xl px-6 py-12 md:py-20" data-testid="home-page">
      <UtmCapture />
      {!hasHero && <h1 className="sr-only">{entry.title}</h1>}
      <DocumentView document={entry.document} locale={locale} slots={landingSlots} heroHeadingLevel={hasHero ? 1 : 2} />
    </div>
  );
}
