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
import "../globals.css";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "landing" });

  return {
    title: t("heroTitle"),
    description: t("heroDescription"),
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

  if (!routing.locales.includes(locale as "zh" | "en")) {
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

  return (
    <html lang={locale} suppressHydrationWarning>
      <body data-site-theme={theme.name}>
        <NextIntlClientProvider messages={messages}>
          <SiteTheme appearance={site.appearance}><div className="min-h-screen flex flex-col">
          <Header site={site} />
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
