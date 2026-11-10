import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, ROUTED_LOCALES } from "@/lib/site/locales";

export const routing = defineRouting({
  locales: ROUTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
  // Public HTML is shared-cacheable, so the response may depend only on the URL: no locale
  // cookie and no Accept-Language redirect. LocaleSuggestion offers the visitor's language instead.
  localeDetection: false,
  localeCookie: false,
  // hreflang is emitted in HTML from SITE_URL; next-intl's Link header would use the request Host.
  alternateLinks: false,
});

export type Locale = (typeof routing.locales)[number];
