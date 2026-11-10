import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { routing } from "@/i18n/routing";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { SiteAnalytics } from "@/components/SiteAnalytics";
import { SiteConnections } from "@/components/SiteConnections";
import { readSafeSiteIntegrations } from "@/features/site/integrations.server";
import { readSiteSettings } from "@/features/content/server";
import { SiteTheme } from "@/features/site/SiteTheme";
import { resolveSiteTheme } from "@zucker-framework/fe-site/content";
import { LocaleSuggestion } from "@/components/LocaleSuggestion";
import { LOCALE_TAGS, isLocale } from "@/lib/site/locales";
import { parseAdminUrl, siteOrigin } from "@/lib/site/url";
import "../globals.css";

/**
 * Site-wide defaults only. Canonical and hreflang are page-specific, so they come from each public
 * page's buildMetadata() (lib/site/metadata.ts); a default here would be inherited by every page.
 * The generated opengraph-image in this segment supplies og:image for pages that set no openGraph.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const [t, site] = await Promise.all([
    getTranslations({ locale, namespace: "landing" }),
    readSiteSettings(locale),
  ]);
  const description = site.description || t("heroDescription");
  return {
    metadataBase: new URL(siteOrigin()),
    applicationName: site.name,
    title: { default: site.name, template: `%s | ${site.name}` },
    description,
    openGraph: {
      siteName: site.name,
      type: "website",
      locale: isLocale(locale) ? LOCALE_TAGS[locale].openGraph : undefined,
      description,
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!isLocale(locale) || !routing.locales.includes(locale)) {
    notFound();
  }

  // Independent reads run concurrently so an API outage costs one timeout, not the sum of them.
  const [messages, site, integrations, requestHeaders] = await Promise.all([
    getMessages(),
    readSiteSettings(locale),
    readSafeSiteIntegrations(),
    headers(),
  ]);
  const theme = resolveSiteTheme(site.theme, ['default']);
  // Set by src/proxy.ts when a nonce-based CSP is enabled; undefined otherwise.
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  // Rendered only for signed-in accounts holding permissions; the Server enforces access.
  const adminUrl = parseAdminUrl(process.env.ADMIN_URL);

  return (
    <html lang={locale} suppressHydrationWarning>
      <body data-site-theme={theme.name}>
        <NextIntlClientProvider messages={messages}>
          <SiteTheme appearance={site.appearance}><div className="min-h-screen flex flex-col">
          <LocaleSuggestion />
          <Header site={site} adminUrl={adminUrl} />
          <main className="flex-1">{children}</main>
          <Footer site={site} locale={locale} />
          <Toaster position="top-right" richColors />
          <SiteAnalytics config={integrations.analytics} nonce={nonce} />
          <SiteConnections config={integrations.connections} nonce={nonce} />
          </div></SiteTheme>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
