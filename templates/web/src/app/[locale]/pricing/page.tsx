import type { Metadata } from 'next';
import { pricingCopy } from '@/features/billing/copy';
import { PricingView } from '@/features/billing/PricingView';
import { readEntitlementCatalog, readPricingCatalog } from '@/features/billing/pricing-server';
import { readSiteSettings, routeLocale } from '@/features/content/server';
import { UtmCapture } from '@/features/landing/UtmCapture';
import { buildMetadata } from '@/lib/site/metadata';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const site = await readSiteSettings(locale);
  const copy = pricingCopy(locale);
  return buildMetadata({
    locale: routeLocale(locale),
    path: '/pricing',
    title: copy.title,
    description: copy.description,
    siteName: site.name,
  });
}

/** Anonymous catalog in the HTML (shared-cacheable); the current plan is marked in the browser. */
export default async function PricingPage({ params }: Props) {
  const { locale } = await params;
  const [catalog, entitlements] = await Promise.all([readPricingCatalog(locale), readEntitlementCatalog()]);
  return (
    <>
      <UtmCapture />
      <PricingView locale={locale} initial={catalog} entitlements={entitlements} standalone />
    </>
  );
}
